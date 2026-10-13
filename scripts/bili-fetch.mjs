#!/usr/bin/env node
// bili-fetch.mjs — 把 B 站视频页变成可转写的媒体文件
//
// 用法:
//   node bili-fetch.mjs <BV号或视频链接> [--out 目录] [--page N] [--video]
//
// 为什么需要它:
//   B 站的 DASH 流把音视频分开下发，而且 CDN 要求请求带 Referer + 浏览器 UA。
//   直接把视频页 URL 丢给 ffmpeg 是拿不到东西的，本机也没有 yt-dlp / lux。
//   默认只拉音频（转写够用；一小时的长视频也不会拖回几百 MB）。
//   加 --video 才会额外拉视频流并合流成 mp4，用于抽帧。
//
// 输出:
//   <out>/<bvid>.audio.m4s        音频（可直喂 transcribe.mjs）
//   <out>/<bvid>.video.m4s        视频（仅 --video）
//   <out>/<bvid>.mp4              合流结果（仅 --video）
//   stdout                        一段 JSON，含标题/UP主/时长/分P/文件路径

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ffmpeg 解析顺序：FFMPEG_PATH → PATH → 本机随附的副本。
// 最后一道兜底是必要的：DSH 进程继承的是它「启动那一刻」的 PATH。
// 可用 FFMPEG_BUNDLED_DIR 覆盖；默认去找 DSH 常见的解压位置。
const BUNDLED_BIN_DIR = process.env.FFMPEG_BUNDLED_DIR?.trim()
  || join(homedir(), '.dsh', 'tools', 'ffmpeg-master-latest-win64-gpl', 'bin');

function lookOnPath(exeName) {
  const names = process.platform === 'win32' ? [`${exeName}.exe`] : [exeName];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function ffmpegBin() {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  const found = lookOnPath('ffmpeg');
  if (found) return found;
  const bundled = join(BUNDLED_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (existsSync(bundled)) return bundled;
  return 'ffmpeg';
}

function parseArgs(argv) {
  const out = { input: null, out: null, page: 1, video: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--page' || a === '-p') out.page = Number(argv[++i]);
    else if (a === '--video') out.video = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.input = rest[0] ?? null;
  if (!Number.isInteger(out.page) || out.page < 1) out.page = 1;
  return out;
}

function extractBvid(input) {
  const m = String(input ?? '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function run(bin, argv) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(bin, argv);
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on('error', (e) => reject(new Error(`${bin} 启动失败: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${bin} 退出码 ${code}: ${err.trim()}`));
    });
  });
}

async function getJson(url, headers, what) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what}: 返回非 JSON（前 200 字）${text.slice(0, 200)}`);
  }
  // B 站会把业务错误放在 code 里：-404 稿件不存在，-352 触发风控，62002 稿件不可见
  if (json.code !== 0) throw new Error(`${what}: code=${json.code} ${json.message ?? ''}`);
  return json.data;
}

async function download(url, dest, headers, what) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${what}: 下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`${what}: 下载到 0 字节`);
  writeFileSync(dest, buf);
  return buf.length;
}

function printUsage() {
  console.log(`用法: node bili-fetch.mjs <BV号或视频链接> [--out 目录] [--page N] [--video]

  --out, -o    输出目录（默认 ./downloads）
  --page, -p   分P 序号（默认 1）
  --video      额外拉视频流并合流成 mp4（默认只拉音频）

示例:
  node bili-fetch.mjs https://www.bilibili.com/video/BV1D9pn6KE9p
  node bili-fetch.mjs BV1D9pn6KE9p --video --out downloads`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    return args.help ? 0 : 2;
  }

  const bvid = extractBvid(args.input);
  if (!bvid) {
    console.error(`认不出 BV 号：${args.input}`);
    return 3;
  }

  const outDir = resolve(args.out || 'downloads');
  mkdirSync(outDir, { recursive: true });
  const headers = { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${bvid}` };

  const info = await getJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    headers,
    '视频信息',
  );

  const pages = Array.isArray(info.pages) ? info.pages : [];
  const page = pages.find((p) => p.page === args.page) ?? pages[0];
  if (!page) throw new Error('这个稿件没有任何可用的分P');

  const play = await getJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${page.cid}&fnval=16&fourk=1`,
    headers,
    '播放地址',
  );
  const dash = play.dash;
  if (!dash?.audio?.length) {
    throw new Error('B 站没有下发 DASH 音频流（可能需要登录，或该稿件有地区/会员限制）');
  }

  // 取带宽最高的音频：ASR 的质量直接受音质影响，而这部分体积可以忽略。
  const audio = [...dash.audio].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const audioPath = join(outDir, `${bvid}.audio.m4s`);
  const audioBytes = await download(
    audio.baseUrl || audio.base_url,
    audioPath,
    headers,
    '音频流',
  );

  let mp4Path = null;
  let videoBytes = 0;
  let videoMeta = null;

  if (args.video) {
    const all = Array.isArray(dash.video) ? dash.video : [];
    // 优先 AVC：HEVC 在某些播放器/抽帧链路上更麻烦，且我们要的只是画面。
    const avc = all.filter((v) => String(v.codecs ?? '').startsWith('avc'));
    const pick = [...(avc.length ? avc : all)].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    if (!pick) throw new Error('B 站没有下发视频流');
    const videoPath = join(outDir, `${bvid}.video.m4s`);
    videoBytes = await download(pick.baseUrl || pick.base_url, videoPath, headers, '视频流');
    mp4Path = join(outDir, `${bvid}.mp4`);
    await run(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      mp4Path,
    ]);
    videoMeta = { width: pick.width, height: pick.height, codecs: pick.codecs };
  }

  const summary = {
    bvid,
    title: info.title,
    owner: info.owner?.name ?? null,
    durationSec: page.duration ?? info.duration,
    page: page.page,
    part: page.part,
    pageCount: info.videos,
    cid: page.cid,
    pubdate: info.pubdate,
    desc: info.desc ?? '',
    stat: info.stat ? { view: info.stat.view, danmaku: info.stat.danmaku } : null,
    url: `https://www.bilibili.com/video/${bvid}`,
    audio: { path: audioPath, bytes: audioBytes, bandwidth: audio.bandwidth },
    video: args.video ? { path: mp4Path, bytes: videoBytes, ...videoMeta } : null,
    // 直接可跑的下一条命令
    transcribeHint: `node scripts/transcribe.mjs "${mp4Path ?? audioPath}" --lang zh`,
  };

  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

// 不调用 process.exit():在 Windows 上硬退出会与 undici 的 keep-alive 连接回收
// 竞争，触发 libuv 断言 (async.c: UV_HANDLE_CLOSING) 并以 0xC0000409 中止进程。
// 改为设置 exitCode 后自然退出，让 Node 自己收干净。
main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    console.error(`[bili-fetch] 失败: ${e.message}`);
    process.exitCode = 1;
  });
