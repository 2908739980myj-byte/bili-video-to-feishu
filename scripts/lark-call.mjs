#!/usr/bin/env node
/**
 * lark-call.mjs — 不经过 MCP，直接用 stdio 调 lark-mcp 的工具。
 *
 * 什么时候用：宿主还没重启、或 MCP 没加载，`mcp__lark__*` 工具不在列表里，
 * 但你要建飞书文档 / 分享给用户 / 推消息。它是那条链路的兜底通道。
 *
 * 用法：
 *   node lark-call.mjs list                    列出全部工具
 *   node lark-call.mjs schema <tool>           打印某个工具的参数 schema
 *   node lark-call.mjs call <tool> '<json>'    调用工具（json 为参数对象）
 *   node lark-call.mjs call <tool> @file.json  从文件读参数
 *
 * 依赖 `@larksuiteoapi/lark-mcp`（npm i 到任意目录，用 LARK_MCP_CLI 指过去）。
 *
 * 凭据一律不硬编码，按以下顺序解析：
 *   App ID       环境变量 LARK_APP_ID
 *                → 机器人绑定文件 ~/.dsh/integrations/dsh-feishu/config.json 的 appId
 *   App Secret   环境变量 LARK_APP_SECRET
 *                → 按绑定文件的 secretRef 去凭据文件里取
 *   凭据文件     环境变量 DSH_CREDENTIALS_FILE → ~/.dsh/.credentials.yaml
 *   绑定文件     环境变量 DSH_FEISHU_CONFIG
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const CRED_FILE =
  process.env.DSH_CREDENTIALS_FILE || join(HOME, '.dsh', '.credentials.yaml');
const BOT_CONFIG =
  process.env.DSH_FEISHU_CONFIG ||
  join(HOME, '.dsh', 'integrations', 'dsh-feishu', 'config.json');
const CLI =
  process.env.LARK_MCP_CLI ||
  join(
    HOME,
    '.dsh',
    'mcp',
    'lark-mcp',
    'node_modules',
    '@larksuiteoapi',
    'lark-mcp',
    'dist',
    'cli.js',
  );

function readBotConfig() {
  if (!existsSync(BOT_CONFIG)) return {};
  try {
    return JSON.parse(readFileSync(BOT_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function readSecretRef(name) {
  const raw = readFileSync(CRED_FILE, 'utf8');
  const re = new RegExp('^\\s*' + name + ':\\s*(\\S+)\\s*$', 'm');
  const m = raw.match(re);
  if (!m) throw new Error('未能从 ' + CRED_FILE + ' 读到 ' + name);
  return m[1];
}

function resolveApp() {
  const cfg = readBotConfig();
  const appId = process.env.LARK_APP_ID || cfg.appId;
  let secret = process.env.LARK_APP_SECRET;
  if (!secret) {
    const ref = process.env.LARK_APP_SECRET_REF || cfg.secretRef;
    if (!ref) {
      throw new Error(
        '没有 App Secret：设置 LARK_APP_SECRET，或让 ' + BOT_CONFIG + ' 里有 secretRef',
      );
    }
    secret = readSecretRef(ref);
  }
  if (!appId) {
    throw new Error('没有 App ID：设置 LARK_APP_ID，或让 ' + BOT_CONFIG + ' 里有 appId');
  }
  return { appId, secret };
}

// ---------- MCP stdio 客户端 ----------

function startServer() {
  const { appId, secret } = resolveApp();
  const child = spawn(process.execPath, [CLI, 'mcp', '-a', appId, '-s', secret], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let stderr = '';
  const pending = new Map();
  let nextId = 1;

  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const rpc = (method, params, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error('超时: ' + method + (stderr ? ' | stderr: ' + stderr.slice(0, 300) : '')),
        );
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  return { child, rpc, getStderr: () => stderr };
}

async function open() {
  const srv = startServer();
  const init = await srv.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lark-call', version: '1.0.0' },
  });
  if (init.error) throw new Error('initialize 失败: ' + JSON.stringify(init.error));
  srv.child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  return srv;
}

function unwrap(resp) {
  if (resp.error) throw new Error(JSON.stringify(resp.error));
  const r = resp.result ?? {};
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  return { ok: !r.isError, text };
}

// ---------- 主流程 ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const srv = await open();
  try {
    // tools/list 直接返回 result.tools，不经 content 包装（与 tools/call 不同）
    if (cmd === 'list' || cmd === 'schema') {
      const resp = await srv.rpc('tools/list', {});
      if (resp.error) throw new Error(JSON.stringify(resp.error));
      const parsed = resp.result?.tools ?? [];
      if (cmd === 'list') {
        for (const t of parsed) {
          console.log(
            '- ' +
              t.name +
              (t.description
                ? '  — ' + String(t.description).replace(/\s+/g, ' ').slice(0, 100)
                : ''),
          );
        }
        return 0;
      }
      const t = parsed.find((x) => x.name === rest[0]);
      if (!t) {
        console.error('未找到工具: ' + rest[0]);
        return 2;
      }
      console.log(JSON.stringify(t, null, 2));
      return 0;
    }

    if (cmd === 'call') {
      const tool = rest[0];
      let argsRaw = rest.slice(1).join(' ');
      if (!argsRaw) argsRaw = '{}';
      if (argsRaw.startsWith('@')) argsRaw = readFileSync(argsRaw.slice(1), 'utf8');
      const args = JSON.parse(argsRaw);
      const r = unwrap(await srv.rpc('tools/call', { name: tool, arguments: args }, 180000));
      console.log(r.text);
      return r.ok ? 0 : 1;
    }

    console.error('用法: list | schema <tool> | call <tool> <json>');
    return 2;
  } finally {
    srv.child.kill();
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    console.error('错误: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
