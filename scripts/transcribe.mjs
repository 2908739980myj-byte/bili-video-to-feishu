#!/usr/bin/env node
// transcribe.mjs — 把视频/音频转成带时间戳的文字稿
//
// 用法:
//   node transcribe.mjs <媒体文件> [--out 文字稿.md] [--segment 180] [--lang zh]
//
// 为什么需要它:
//   飞书渠道收到的视频以「文件」形式落盘后，模型无法直接"看"视频。
//   本脚本用 ffmpeg 抽音轨，交给 DashScope qwen3-asr-flash 转写为文字。
//
// 为什么要分段:
//   DashScope 对 qwen3-asr-flash 的限制是「单个音频 ≤10MB 且时长 ≤5 分钟」，
//   且 base64 编码会膨胀 4/3，所以按 180 秒切段最稳妥；若编码后仍超限会自动再切半。
//   参考: https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';

const DEFAULT_ASR_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_ASR_MODEL = 'qwen3-asr-flash';
const MAX_BASE64_BYTES = 9 * 1024 * 1024; // 留 1MB 余量给 10MB 硬限制

function parseArgs(argv) {
  const out = { input: null, output: null, segment: 180, lang: null, model: null, baseUrl: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') out.output = argv[++i];
    else if (a === '--segment' || a === '-s') out.segment = Number(argv[++i]);
    else if (a === '--lang' || a === '-l') out.lang = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.input = rest[0] ?? null;
  if (!Number.isFinite(out.segment) || out.segment <= 0) out.segment = 180;
  return out;
}

function run(bin, args) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(bin, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', (e) => reject(new Error(`${bin} 启动失败(是否已安装?): ${e.message}`)));
    p.on('close', (code) => (code === 0
      ? resolvePromise(out)
      : reject(new Error(`${bin} 退出码 ${code}: ${err.slice(-500)}`))));
  });
}

async function probeDuration(ffprobe, file) {
  const out = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`无法读取媒体时长(ffprobe 返回 "${out.trim()}")`);
  }
  return seconds;
}

// ffmpeg 解析顺序：FFMPEG_PATH/FFPROBE_PATH → PATH → 本机随附的副本。
// 之所以加最后一道兜底：DSH 进程继承的是它「启动那一刻」的 PATH。即使用户级 PATH
// 里已经加了 ffmpeg，没重启的 DSH 依然看不到它，脚本会以「启动失败」告终。
// 可用 FFMPEG_BUNDLED_DIR 覆盖；默认去找 DSH 常见的解压位置。
const BUNDLED_BIN_DIR = process.env.FFMPEG_BUNDLED_DIR?.trim()
  || join(homedir(), '.dsh', 'tools', 'ffmpeg-master-latest-win64-gpl', 'bin');

function lookOnPath(exeName) {
  const names = process.platform === 'win32' ? [exeName, `${exeName}.exe`] : [exeName];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveBin(envName, exeName) {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  const found = lookOnPath(exeName);
  if (found) return found;
  const bundled = join(
    BUNDLED_BIN_DIR,
    process.platform === 'win32' ? `${exeName}.exe` : exeName,
  );
  if (existsSync(bundled)) return bundled;
  return exeName;
}

function ffmpegBin() {
  return resolveBin('FFMPEG_PATH', 'ffmpeg');
}

function ffprobeBin() {
  return resolveBin('FFPROBE_PATH', 'ffprobe');
}

// ---- 凭据兜底 --------------------------------------------------------------
// DSH 进程继承的是它「启动那一刻」的环境变量。运行期间新写入的用户级变量，
// 没重启的 DSH 是看不到的，所以环境变量缺失时回退去读 DSH 的凭据库
// （.credentials.yaml 的 refs 段，DEEPSEEK_API_KEY 等也存在同一位置）。
// 可用 DSH_CREDENTIALS_FILE 覆盖。
const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE?.trim()
  || join(homedir(), '.dsh', '.credentials.yaml');

function readCredentialRef(name) {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, 'utf8');
    const m = raw.match(new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S+)[ \\t]*$`, 'm'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function extractSegment(input, startSec, durSec, outPath) {
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startSec), '-t', String(durSec),
    '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    outPath,
  ]);
}

async function transcribeChunk(wavPath, { apiKey, baseUrl, model, lang }) {
  const raw = readFileSync(wavPath);
  const b64 = raw.toString('base64');
  if (b64.length > MAX_BASE64_BYTES) {
    const err = new Error('chunk-too-large');
    err.code = 'CHUNK_TOO_LARGE';
    err.bytes = b64.length;
    throw err;
  }
  const audio = { data: `data:audio/wav;base64,${b64}` };
  if (lang) audio.format = lang;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: audio }] }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DashScope ASR ${res.status}: ${text.slice(0, 400)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DashScope 返回非 JSON: ${text.slice(0, 200)}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  // 静音片段（纯音乐、停顿、无人说话）会返回空串，这是正常结果而不是故障。
  // 以前在这里抛错，一段没说话的音频就会毁掉整份文字稿。
  return typeof content === 'string' ? content.trim() : '';
}

// 转写一段时间区间；若编码后超限则一分为二重试，保证长音频也能走完。
async function transcribeRange(input, startSec, durSec, ctx) {
  const wav = join(ctx.work, `seg-${Math.round(startSec)}-${Math.round(durSec)}.wav`);
  await extractSegment(input, startSec, durSec, wav);
  try {
    const text = await transcribeChunk(wav, ctx);
    return [{ start: startSec, text }];
  } catch (e) {
    if (e.code !== 'CHUNK_TOO_LARGE') throw e;
    rmSync(wav, { force: true });
    if (durSec < 20) {
      throw new Error(`音频片段过短仍超出体积限制(${e.bytes} B base64)，请降低采样率后重试`);
    }
    const half = durSec / 2;
    const left = await transcribeRange(input, startSec, half, ctx);
    const right = await transcribeRange(input, startSec + half, half, ctx);
    return [...left, ...right];
  } finally {
    rmSync(wav, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(`用法: node transcribe.mjs <媒体文件> [--out 文字稿.md] [--segment 180] [--lang zh]

环境变量:
  DASHSCOPE_API_KEY  必填,DashScope(阿里云百炼) API Key
  FFMPEG_PATH        可选,ffmpeg 路径(默认走 PATH)
  FFPROBE_PATH       可选,ffprobe 路径(默认走 PATH)`);
    return args.help ? 0 : 2;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() || readCredentialRef('DASHSCOPE_API_KEY');
  if (!apiKey) {
    console.error(`缺少 DASHSCOPE_API_KEY：环境变量没有，${CREDENTIALS_FILE} 的 refs 里也没有。`);
    return 3;
  }
  const input = resolve(args.input);
  try {
    statSync(input);
  } catch {
    console.error(`文件不存在: ${input}`);
    return 4;
  }

  const ctx = {
    apiKey,
    baseUrl: args.baseUrl ?? DEFAULT_ASR_BASE_URL,
    model: args.model ?? DEFAULT_ASR_MODEL,
    lang: args.lang,
    work: mkdtempSync(join(tmpdir(), 'dsh-transcribe-')),
  };

  try {
    const duration = await probeDuration(ffprobeBin(), input);
    console.error(`[transcribe] ${basename(input)} 时长 ${mmss(duration)}，按 ${args.segment}s 切段`);

    const pieces = [];
    for (let start = 0; start < duration; start += args.segment) {
      const dur = Math.min(args.segment, duration - start);
      if (dur < 0.5) break;
      console.error(`[transcribe] 转写 ${mmss(start)} - ${mmss(start + dur)}`);
      pieces.push(...await transcribeRange(input, start, dur, ctx));
    }

    const spoken = pieces.filter((p) => p.text);
    if (!spoken.length) {
      console.error('[transcribe] 所有片段都没识别出文字——音频可能没有人声，或 --lang 指定错了。');
      return 5;
    }

    const body = spoken
      .map((p) => `**[${mmss(p.start)}]** ${p.text}`)
      .join('\n\n');
    const markdown = `# 文字稿：${basename(input)}

> 时长 ${mmss(duration)} · 模型 ${ctx.model} · 分段 ${args.segment}s

${body}
`;

    if (args.output) {
      const out = resolve(args.output);
      writeFileSync(out, markdown, 'utf8');
      console.error(`[transcribe] 已写入 ${out}`);
    } else {
      process.stdout.write(markdown);
    }
    return 0;
  } finally {
    rmSync(ctx.work, { recursive: true, force: true });
  }
}

// 不调用 process.exit():在 Windows 上硬退出会与 undici 的 keep-alive 连接回收
// 竞争,触发 libuv 断言 (async.c: UV_HANDLE_CLOSING) 并以 0xC0000409 中止进程。
// 改为设置 exitCode 后自然退出,让 Node 自己收干净。
main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((e) => {
    console.error(`[transcribe] 失败: ${e.message}`);
    process.exitCode = 1;
  });
