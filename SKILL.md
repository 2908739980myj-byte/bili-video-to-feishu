---
name: bili-video-to-feishu
description: "当用户发来 B 站（bilibili.com/video/BV... 或裸 BV 号）链接，并要求「整理 / 总结 / 提取要点 / 做笔记 / 做成文档 / 生成飞书文档」时使用。完整覆盖：抓取 B 站音视频流 → 语音转写为文字稿 → 提炼要点整理成文 → 生成飞书云文档 → 分享给用户并推送链接。也适用于把任意已有的视频/音频文件走同一套「转写 + 生成飞书文档」流程的场景。"
metadata:
  category: media-to-document
  version: 1.0.0
  license: MIT
---

# 视频 → 飞书文档 流水线

把视频变成一份整理好的飞书文档，并送到用户飞书上。标准路径四步：**抓流 → 转写 → 整理 → 建文档并分享**。

## 何时触发

用户发来 `bilibili.com/video/BV...` 链接或裸 BV 号，并说「整理 / 总结 / 提取要点 / 做笔记 / 做成文档」。

## 环境

本 skill 自带两个脚本，就在**本文件同级的 `scripts/` 目录**里：

| 东西 | 位置 |
|---|---|
| 抓流脚本 | `<skill 目录>/scripts/bili-fetch.mjs` |
| 转写脚本 | `<skill 目录>/scripts/transcribe.mjs` |

skill 目录通常是 `~/.dsh/skills/bili-video-to-feishu/`（Windows：`C:\Users\<你的用户名>\.dsh\skills\bili-video-to-feishu\`）。

> **务必用绝对路径调用脚本。** skill 会被手机端等其它工作区的会话加载，相对路径在那时是错的；绝对路径在任何工作区都可执行，而产物会自动落在会话自己的工作区里，不污染别处。

外部依赖：

- **ffmpeg / ffprobe**（必需）。脚本按 `FFMPEG_PATH` / `FFPROBE_PATH` → `PATH` → `FFMPEG_BUNDLED_DIR`（未设时默认找 `~/.dsh/tools/ffmpeg-master-latest-win64-gpl/bin`）的顺序查找。
- **DashScope API Key**（必需）。读环境变量 `DASHSCOPE_API_KEY`；读不到时回退去读 `~/.dsh/.credentials.yaml` 的 `refs` 段（可用 `DSH_CREDENTIALS_FILE` 指向别处）。
- **飞书 MCP**（建文档用）。见 [README](./README.md) 的安装章节。

## 第 1 步：抓流

```bash
node "<skill 目录>/scripts/bili-fetch.mjs" "<链接或BV号>" --out .
```

- 默认只拉音频（转写够用，长视频也不会拖回几百 MB）；需要抽帧才加 `--video`
- 往 stdout 打一段 JSON：`title` / `owner` / `durationSec` / `part` / `pageCount` / `cid` / `pubdate` / `desc` / `stat.view` / `audio.path`，外加一条现成的 `transcribeHint`
- **先把这段 JSON 记下来** —— 标题、UP主、时长、简介、播放量都要写进文档抬头
- 多分P 视频用 `--page N` 指定；不指定取 P1
- 退出码：`2` 参数不全 · `3` 认不出 BV 号 · `1` 其他失败（stderr 里会带 B 站返回的 `code`）

**B 站特有的坑**：DASH 流把音视频**分开下发**，且 CDN 要求请求带 `Referer` + 浏览器 UA —— 所以视频页 URL 不能直接喂 ffmpeg。这些 `bili-fetch.mjs` 都已经处理好了。

## 第 2 步：转写

```bash
node "<skill 目录>/scripts/transcribe.mjs" <第1步给出的文件> --lang zh
```

- **默认按 180 秒切段，不要改小。** 实测 `--segment 10` 会把「老祖天天掏心窝子」切成「天天掏心窝子」，**吃掉一个字**。整段转写最准。
- 超 5 分钟的视频**本来就必须分段**（DashScope 限制单段 ≤10MB 且 ≤5 分钟），接缝处可能丢字。**长视频要主动把这个风险告诉用户**；必要时改用重叠切段（每段向前后各多切 2 秒）再手工拼接。
- 退出码：`0` 成功 · `2` 参数不全 · `3` 找不到 API Key · `4` 输入文件不存在 · `5` **所有片段都没识别出文字**
- **退出码 5 的处理**：说明这条视频没有人声（纯音乐 / BGM 卡点 / 纯画面）。这时**绝不要编内容** —— 加 `--video` 重新抓一次，用 ffmpeg 抽帧（`-vf fps=1/3`，每 3 秒一帧），自己看图后按画面整理，并明确告诉用户「这条没有语音，是按画面整理的」。

## 第 3 步：整理成文档

先通读文字稿，提炼**主播真正强调的点**（不是逐句复述）。口播里的「点赞收藏」类互动话术单列到结尾说明，不算内容。

文档结构照这个模板来（已验证有效）：

```
# <标题> —— 《<UP主>》视频要点整理

**来源**：<链接>
**UP主**：<owner> ｜ **时长**：<durationSec> 秒 ｜ **发布**：<yyyy-MM-dd> ｜ **播放**：<stat.view>
**简介**：<desc>
**整理**：<今天日期> ｜ 文字稿由 DashScope `qwen3-asr-flash` 转写

---

## 一句话概括
## 为什么 / 背景（若视频讲了原理）
## 做法 / 要点清单（能列步骤就列成有序列表）
## 易错点 / 关键提醒
## 完整文字稿
```

## 第 4 步：建飞书文档

用 lark MCP：

```
mcp__lark__docx_builtin_import
  data: { file_name: "<≤27 字的名字>", markdown: "<第3步的 markdown>" }
```

返回 `token` 和 `url`。注意 `file_name` 有 **27 字符上限**。

建完可以用 `mcp__lark__docx_v1_document_rawContent`（`path: { document_id: <token> }`）回读一遍，确认渲染无误。

## 第 5 步（**不能省**）：分享给用户

用 tenant token 建出来的文档归**应用**所有，用户在飞书里**看不到**。必须显式分享：

```
mcp__lark__drive_v1_permissionMember_create
  path:   { token: "<第4步的 token>" }
  params: { type: "docx", need_notification: true }
  data:   { member_type: "openid", member_id: "<用户 open_id>", perm: "full_access" }
```

### 用户 open_id 从哪来

**不要硬编码。** 按优先级试：

1. **读机器人自己的绑定文件**（最省事）：
   `~/.dsh/integrations/dsh-feishu/config.json` → 字段 `ownerOpenIds[0]`
   （Windows：`C:\Users\<你的用户名>\.dsh\integrations\dsh-feishu\config.json`）

2. 用 MCP 反查：`mcp__lark__contact_v3_user_batchGetId`，传手机号或邮箱。

3. 直接问用户。

> 为什么不用 `user_access_token`：它只有 2 小时且要 OAuth 往返。tenant token + 显式分享更省事。

## 第 6 步：把链接推到飞书

```
mcp__lark__im_v1_message_create
  params: { receive_id_type: "open_id" }
  data:   { receive_id: "<用户 open_id>",
            msg_type: "text",
            content: "{\"text\":\"<标题> 整理好了 👇\\n<url>\\n\\n一句话版：<一句话概括>\"}" }
```

`content` 是**字符串化的 JSON**，里层引号要转义。

## MCP 工具不可用时

若 `mcp__lark__*` 没出现在工具列表里（宿主没重启 / MCP 没加载），可以临时写一个小脚本直接调飞书 REST API，但**别把 App Secret 写进脚本** —— 从环境变量或凭据文件读。

## 已知坑（都踩过，别重复）

1. **`process.exit()` 在 Windows 上会崩。** 它会和 undici 的 keep-alive 连接回收竞争，触发 libuv 断言（`src\win\async.c: UV_HANDLE_CLOSING`）并以 `0xC0000409` 中止进程。脚本里一律用 `process.exitCode` + 自然退出；自己写临时脚本时同理。
2. **细分段吃字**（见第 2 步）。
3. **文档不分享 = 用户看不到**（见第 5 步）。
4. **飞书个人版无法签发 `tenant_access_token`**，恒返回 `21001 Access denied by access control policy. Contact the administrator for assistance.`。必须用**企业 / 团队**租户下的自建应用。诊断技巧：app_id 不存在返 `10014 app id not exists`，secret 错返 `10014 app secret invalid`，**只有 app_id 和 secret 都对才会看到 21001** —— 所以见到 21001 说明凭据没问题，是租户侧的事。
5. **飞书文档权限要单独开通**：`docx:document`、`drive:drive`、`docs:document:import`、`wiki:wiki`，开完还要去「版本管理与发布」**创建版本并发布**才生效。缺权限时接口返 `99991672`，**错误信息里会直接带一个可点开申请的链接**。
6. **只覆盖 B 站。** 抖音 / 小红书 / YouTube 没有抓取能力，遇到这些平台只能现场想办法，并如实告诉用户。
7. **依赖宿主开机。** Agent 跑在用户电脑上，IM 只是遥控器；电脑关机或宿主未启动时不会有任何反应。

## 完整案例

`BV1D9pn6KE9p`（《荷包蛋》，UP主「邪修美食」，38 秒，177 万播放）：
抓流 → 转写（37 秒，退出码 0）→ 整理 → 建文档 → 分享 → 推送，全程 `code=0`。
