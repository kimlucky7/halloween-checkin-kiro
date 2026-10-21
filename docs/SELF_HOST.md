# 自己部署一套 Halloween Check-in

照着做一遍，你会得到：自己的网站、自己的发布后端（Cloudflare Worker + D1 + R2），以及在你自己的 ChatGPT 里用的插件和 Skill。约 15 分钟，全部在免费额度内（Cloudflare Workers Free 计划即可）。

> 给 AI 助手的说明：如果用户把这份文档交给你，请按顺序逐步带他执行；每条命令先解释它做什么，**不要**让用户把 owner 令牌贴进聊天，令牌只存在他本机的 `.env.local` 和 Cloudflare 的 secret 里。

## 你需要

- Node.js 22.12 或更高（`node -v` 查看）
- 一个 Cloudflare 账号
- 一个能添加自定义 MCP 服务器的 ChatGPT 账号（chatgpt.com → Plugins → ＋ 里能看到 **Add custom MCP server**；不同套餐开放情况不同，先确认）
- macOS 或 Linux 终端（Windows 用 WSL）

## 1. 拿到代码

```bash
git clone https://github.com/kimlucky7/halloween-checkin-kiro.git
cd halloween-checkin-kiro
npm ci
npm run verify          # 跑全部测试并构建，应全部通过
```

## 2. 登录 Cloudflare

```bash
npx wrangler login
npx wrangler whoami     # 记下要用的 Account ID
export CLOUDFLARE_ACCOUNT_ID=<你的 Account ID>
```

如果你的 Cloudflare 里有多个账号，后面每条 wrangler 命令都依赖这个环境变量，换终端要重新 `export`。

## 3. 建数据库和图片桶

名字可以自己取，下面用 `my-checkin` 举例。

```bash
npx wrangler d1 create my-checkin             # 输出里有 database_id，复制下来
npx wrangler r2 bucket create my-checkin-media
```

## 4. 改配置，指向你自己的资源

打开 `wrangler.jsonc`，只改这几处：

```jsonc
"name": "my-checkin",                                  // Worker 名字，也决定网址
"vars": { "PROJECT_ID": "my-checkin-prod" },           // 任意字符串，审批会绑定它
"d1_databases": [
  { "binding": "DB", "database_name": "my-checkin", "database_id": "<第 3 步的 database_id>", "migrations_dir": "migrations" }
],
"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-checkin-media" }],
```

`binding` 的名字（`DB`、`MEDIA`）不要改。

## 5. 建表

```bash
npx wrangler d1 migrations apply my-checkin --remote
```

应该看到 `0002_halloween_checkin.sql` 和 `0003_chatgpt_plugin.sql` 两行 ✅。

## 6. 生成 owner 令牌

这个令牌就是你网站的"钥匙"：发布、以及连接 ChatGPT 时都要用。

```bash
umask 077
TOKEN=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
printf 'HC_TOKEN=%s\n' "$TOKEN" > .env.local          # 只存在你本机，已被 git 忽略
printf '%s' "$TOKEN" | npx wrangler secret put OWNER_TOKEN
unset TOKEN
```

需要看令牌时：`cat .env.local`。不要把它提交到 git，也不要贴进任何聊天。

## 7. 部署

```bash
npm run build
npx wrangler deploy
```

最后会打印网址，形如 `https://my-checkin.<你的子域>.workers.dev`。把它记下，下面叫 **你的网址**。

快速检查：

```bash
curl -s https://<你的网址>/api/checkins                         # {"checkins":[]}
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<你的网址>/api/revisions   # 401
```

打开你的网址，会看到"这里还没有内容"。

## 8. 在 ChatGPT 里接上

### 8.1 添加插件（MCP 服务器）

chatgpt.com → **Plugins** → **＋** → **Add custom MCP server**：

- Name：Halloween Check-in
- Server URL：`https://<你的网址>/mcp`
- Authentication：**OAuth**（Client ID / Secret 留空，ChatGPT 会自动注册）
- 勾选确认风险提示 → **Create as a plugin** → 在个人插件里**安装**它

ChatGPT 会打开你网站的授权页「Connect to Halloween Check-in」。输入第 6 步的令牌，点 **Allow · 允许**。看到工具列表（`submit_checkin_for_review`、`publish_checkin`、`get_checkin_status`、`list_checkins`）就连好了。

### 8.2 添加 Skill

```bash
HC_MCP_URL=https://<你的网址>/mcp npm run chatgpt:zip
```

会生成两个文件，二选一：

- `chatgpt-skill/dist/halloween-checkin-plugin.zip`：完整插件包（`plugin.json` + `mcp.json` + `skills/`），在 ChatGPT **Plugins** 里上传；
- `chatgpt-skill/dist/halloween-checkin-skill.zip`：只有 Skill，在 ChatGPT **Skills** 里上传（MCP 用 8.1 单独添加）。

在 Plugins 里上传单独的 Skill zip 会提示「无法添加插件」：插件包必须在根目录带 `plugin.json`。

## 9. 打第一张卡

新开一个对话，输入 `@` 选择 Halloween Check-in 插件，上传一张你拍的地点照片，说：

```
checkin Halloween，地点是 <名字>
```

它会：

1. 依次生成两张图：普通版白天（来自照片）、万圣节夜景（在这张白天图上加小装饰、换成夜晚灯光）；
2. 在沙盒里跑 `prepare.py` 抠背景、统一构图、做机械检查；
3. 调用 `submit_checkin_for_review` 登记两个版本，给你看审核包，然后**停下**；
4. 你说"发布"，它才调用 `publish_checkin`（先普通版，再万圣节版）。

刷新你的网址就能看到。左下角切到夜晚，看到的就是万圣节版。

## 不用 ChatGPT 插件也行（命令行）

如果你的 ChatGPT 不能加自定义 MCP，可以让任何能出图的 AI 生成图片，下载后在本机发布（命令行工具目前按「每版一对白天+夜景」工作）：

```bash
set -a; . ./.env.local; set +a
export HC_API_URL=https://<你的网址>
npm run prepare:images -- --day normal-day.png --night normal-night.png --out-dir prep-normal
npm run hc -- review --day prep-normal/day.png --night prep-normal/night.png --theme normal --text "at <地点>" --place-name "<地点>" --out ws-normal
npm run hc -- submit --dir ws-normal     # 登记待审核，不公开
npm run hc -- approve --dir ws-normal    # 你确认要发布之后
npm run hc -- publish --dir ws-normal
```

万圣节版同理，`review` 时加 `--theme halloween --link <普通版发布后返回的 checkinId>`。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| Plugins 里没有 Add custom MCP server | 你的 ChatGPT 套餐或工作区没开放，改用上面的命令行方式 |
| 授权页提示 "This client is not registered" | ChatGPT 注册客户端失败，删掉插件重新添加 |
| 授权页提示令牌不正确 | 用 `cat .env.local` 核对；如果改过 secret，要重新 `wrangler secret put OWNER_TOKEN` |
| 工具返回 `host_not_allowed` / `download_failed` | ChatGPT 传文件的地址不在白名单，或文件已过期；把完整错误发 issue，白名单在 `worker/halloween/files.js` |
| `prepare.py` 返回 `backdrop_not_flat` | 背景不是一种纯色，让 ChatGPT 重出那张，强调纯品红背景 |
| `publish_checkin` 返回 `partner_not_published` | 先发布普通版，再发布万圣节版 |
| 网站一直显示加载中 / 空白 | 强制刷新；`curl https://<你的网址>/api/checkins` 看接口是否正常 |

## 安全提示

- 系统是单所有者：拿到 owner 令牌的人可以往你的网站发布。只在授权页和你本机使用它。
- 授权页没有速率限制，令牌务必是上面那样的长随机串。
- 想停用 ChatGPT 的访问：在 ChatGPT 里删掉插件；要让所有已发出的授权失效，换一个新令牌（第 6 步）并删除 D1 里 `hc_oauth_kv` 表的内容。
- 本项目不提供删除和替换功能；要清空，删掉 Worker、D1 数据库和 R2 桶即可。
