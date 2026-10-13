# bili-video-to-feishu

给 AI Agent 用的一条流水线：**B 站视频链接进 → 整理好的飞书云文档出**，并自动推送到你的飞书。

```
B 站链接 ──► 抓流 ──► 语音转写 ──► 提炼整理 ──► 建飞书文档 ──► 分享并推送
          bili-fetch  transcribe             lark-mcp
```

它最初是为 [DeepSeek Harness](https://github.com/deepseek-ai) 写的 skill，但两个脚本是独立的 Node 程序，任何能跑 Node 18+ 的环境都能用。

## 它解决什么

| 环节 | 麻烦 | 这里怎么办 |
|---|---|---|
| 抓 B 站 | DASH 流音视频分开下发，CDN 校验 `Referer` + 浏览器 UA；`ffmpeg <视频页URL>` 拿不到东西 | `bili-fetch.mjs` 走官方 `playurl` 接口取真实流地址，再带齐头去下 |
| 语音转文字 | 长音频超模型限制；编码膨胀 4/3 | `transcribe.mjs` 按 180 秒切段，超限自动再切半 |
| 转写质量 | 切太细会**吃字** | 默认 180 秒，并把这当成已知限制写进文档 |
| 文档可见性 | 用应用身份建的云文档，用户**看不到** | 建完显式调 `permissions/members` 分享给指定 open_id |
| 静音视频 | 纯音乐 / 纯画面视频转写全空 | 退出码 `5` 明确区分「失败」与「没人声」 |

## 安装

### 1. 脚本

把 `scripts/` 放到 skill 目录下（以 DeepSeek Harness 为例）：

```bash
mkdir -p ~/.dsh/skills/bili-video-to-feishu
cp -r SKILL.md scripts ~/.dsh/skills/bili-video-to-feishu/
```

不需要装 npm 依赖 —— 两个脚本**零依赖**，只用 Node 内置模块 + 全局 `fetch`。

### 2. ffmpeg

必需。Windows 上最省事的办法是下 [BtbN 的静态构建](https://github.com/BtbN/FFmpeg-Builds/releases)，解压到：

```
~/.dsh/tools/ffmpeg-master-latest-win64-gpl/bin/
```

脚本会自己找到它。也可以设 `FFMPEG_BUNDLED_DIR` 指到别处，或把 ffmpeg 加进 `PATH`。

### 3. DashScope API Key

在[阿里云百炼](https://bailian.console.aliyun.com/)开通，然后用下面任一种方式提供：

```bash
export DASHSCOPE_API_KEY=sk-xxxx          # 推荐
```

或写进 `~/.dsh/.credentials.yaml` 的 `refs` 段：

```yaml
refs:
  DASHSCOPE_API_KEY: sk-xxxx
```

> 为什么支持第二种：宿主进程继承的是它**启动那一刻**的环境变量。运行期新写入的用户级变量，没重启的进程看不到 —— 这个回退就是为这种情况准备的。

### 4. 飞书 MCP（建文档用）

需要 [飞书开放平台](https://open.feishu.cn/app) 的一个**企业自建应用**，并开通这些权限：

```
docx:document, drive:drive, docs:document:import, wiki:wiki, im:chat, im:message
```

开通后**必须去「版本管理与发布」创建版本并发布**，否则不生效。

然后装 MCP：

```bash
npx -y @larksuiteoapi/lark-mcp mcp -a <APP_ID> -s <APP_SECRET>
```

接进 Agent 宿主后，就会得到 `docx_builtin_import`、`drive_v1_permissionMember_create`、`im_v1_message_create` 等工具。

## 用法

```bash
# 1) 抓流（默认只拉音频）
node scripts/bili-fetch.mjs "https://www.bilibili.com/video/BV1D9pn6KE9p" --out downloads

# 2) 转写
node scripts/transcribe.mjs downloads/BV1D9pn6KE9p.audio.m4s --lang zh --out 文字稿.md
```

`bili-fetch.mjs` 的 stdout 是一段 JSON，含标题 / UP主 / 时长 / 简介 / 播放量和 `audio.path`，可直接喂给下一步。

### bili-fetch.mjs

| 参数 | 说明 |
|---|---|
| `<BV号或链接>` | 必填 |
| `--out, -o` | 输出目录（默认 `./downloads`） |
| `--page, -p` | 分P 序号（默认 1） |
| `--video` | 额外拉视频流并合流成 mp4（抽帧用；默认只拉音频） |

退出码：`0` 成功 · `2` 参数不全 · `3` 认不出 BV 号 · `1` 其他失败

### transcribe.mjs

| 参数 | 说明 |
|---|---|
| `<媒体文件>` | 必填，音频或视频都行（内部抽音轨） |
| `--out, -o` | 输出 markdown 路径（默认打 stdout） |
| `--segment, -s` | 切段秒数（默认 `180`，**不建议改小**） |
| `--lang, -l` | 语言提示，如 `zh` |
| `--model` | ASR 模型（默认 `qwen3-asr-flash`） |
| `--base-url` | ASR 端点（默认 DashScope 兼容模式） |

退出码：`0` 成功 · `2` 参数不全 · `3` 找不到 API Key · `4` 输入文件不存在 · `5` 所有片段都没识别出文字

> 退出码 `5` 是有意设计的：它把「脚本坏了」和「这条视频本来就没有人声」分开，让上层能正确地决定是报错还是换抽帧。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DASHSCOPE_API_KEY` | ASR 凭据 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 显式指定可执行文件 |
| `FFMPEG_BUNDLED_DIR` | ffmpeg 兜底目录 |
| `DSH_CREDENTIALS_FILE` | 凭据 YAML 路径 |

## 已知限制

- **只支持 B 站。** 抖音 / 小红书 / YouTube 都没有实现。
- **长视频接缝处可能丢字。** DashScope 硬限制单段 ≤10MB 且 ≤5 分钟，必须切段；需要严格逐字稿的话得自己做重叠切段。
- **切段太细会吃字。** 实测 `--segment 10` 会吞掉字，别这么用。
- 用了非官方接口（`x/web-interface/view`、`x/player/playurl`）。B 站改接口就会失效，风控也可能拦（返回 `code=-352`）。

## License

MIT
