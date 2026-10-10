# 资讯刷新云函数

把手动刷新接口和停更补跑迁到 Cloudflare Workers，抓取与发布仍由 `ZrBac/news` 的 `news.yml` / `hexo` 执行。网页和新闻数据仍由 GitHub Pages 提供。

## 当前状态

2026-09-24 已部署 `https://news-refresh.944052796.workers.dev` 并配置专用 `GITHUB_TOKEN`。真实浏览器通过云函数触发 GitHub run `35966590609`，抓取和发布成功，页面自动更新至 14:52。两个开关均开启，GitHub 仓库变量 `NEWS_REFRESH_ENDPOINT` 指向此 Worker 的 `/api/news-refresh`。

服务器上的 `zrbac-news-watchdog.timer` 和 `zrbac-news-refresh.service` 已停用且禁用开机启动。旧地址 `https://zacai.fun/api/news-refresh` 由 nginx 转发到同一 Worker，兼容已打开的旧页面；新页面直接访问 Worker，不依赖此兼容代理。生产代理配置为 `ops/news-refresh-cloud-location.conf`，安装于 `/etc/nginx/news-refresh-location.conf`，原配置备份于 `/var/backups/zrbac-news-refresh/news-refresh-location.before-cloud.conf`。证书校验保持开启，CA 路径适用于本机的 Linux 发行版。

资讯站和旅行网站域名继续使用阿里云 DNS；当前未绑定云函数自定义域名。定时规则仍为每小时 07、37 分钟，实际调度与执行情况可在 Worker 日志中查看。

## 行为

- POST `/api/news-refresh` 和 GET `/api/news-refresh/status` 与原接口兼容，固定仓库、工作流、分支，不接受任意任务参数。
- 只允许资讯站 Origin；Origin 不是登录认证。每 IP 每分钟最多 60 次请求，真正限制工作流触发次数的是全站持久化冷却。
- SQLite Durable Object 的单个 `news` 实例协调所有手动和自动请求；手动至少间隔 15 分钟，已有任务直接复用。
- Cron 每小时第 07、37 分钟检查 `data/status.json`。停更超过两小时且没有近期/正在运行的任务时补跑；同一次停更滚动 24 小时最多三次，两次至少间隔两小时。
- 预算先持久化再调用 GitHub，超时和失败也消耗预算；新的发布时间重置自动补跑预算，较旧的 CDN 响应不能重置它。
- 查询结果缓存 10 秒；上游异常短暂退避，不盲目补发。GitHub 凭证只存 Worker Secret，不打印上游原始响应或凭证。
- GitHub 自身的每小时计划任务保留。两套调度都不能保证 GitHub 排队和部署准点完成。

## 本地检查

使用 Node.js 22，工具依赖独立于根目录的旧 Hexo：

```sh
cd /root/workspace/zrbac-news/ops/cloudflare
npm ci
npm test
npm run check
```

测试涵盖并发、冷却、重启、失败预算、任务状态、CORS 和请求限制；Miniflare 使用真实 Workers 运行时和 SQLite 存储验证并发及重启持久化，所有 GitHub 请求均为模拟，不会触发线上任务。

## 凭证与首次部署

1. 在可信终端执行 `npx wrangler login --device --browser=false --scopes account:read user:read workers_scripts:write workers_tail:read`，在自己的浏览器打开 CLI 给出的 Cloudflare 页面并输入短验证码完成授权，然后 `npx wrangler whoami` 确认正确账号。设备登录无需开放端口或转发 localhost 回调。这里只请求部署、查看账号和日志所需权限；whoami 可能提示缺少其他产品的可选权限，无需因此扩大授权。不要把密码或访问令牌贴进聊天、仓库或网页。
2. 在 GitHub 创建细粒度访问令牌，仅选 `ZrBac/news`，仓库权限 `Actions: Read and write`。设置合适的有效期，并在过期前轮换。
3. 在新账号首次部署时，先将 `MANUAL_ENABLED` 和 `WATCHDOG_ENABLED` 改成 `false`，再执行 `npm run deploy`，以免与旧服务重复运行。首次部署会建立 SQLite Durable Object。当前仓库配置为已经完成切换的生产状态。
4. 执行 `npx wrangler secret put GITHUB_TOKEN`，在隐藏的输入提示中填入专用令牌。
5. 从部署输出取得真实的 `*.workers.dev` 地址。如果使用 `news-api.zacai.fun`，先确认 Cloudflare 上该域名区域已激活，再添加 Worker 自定义域名；不要修改资讯主站或旅行网站的 DNS 记录。

不要将服务器 `gh` 的广泛权限凭证直接复制到云函数。仓库不保存 account ID、令牌或未经验证的生产接口地址。

## 验证与切换顺序

1. 先发布本站的构建改动，确认 `https://news.zacai.fun/data/status.json` 返回有效 `updatedAt`，且与 `data/news.json` 一致。
2. 用部署得到的真实域名替换以下 `WORKER_HOST`，测试状态接口：

   ```sh
   curl --fail -H 'Origin: https://news.zacai.fun' \
     'https://WORKER_HOST/api/news-refresh/status'
   ```

   应返回 `idle`、`running`、`ready` 或 `failed` 等正常状态，不应返回 503。验证手机和常用网络都能连通该接口。
3. 记录旧服务状态和旧的 GitHub 仓库变量；停止旧 timer，等待其当前检查结束，再停止旧的刷新 API。确认 GitHub 没有正在执行的新闻工作流，且旧重试预算已因新发布清零；否则应转移预算，或等待旧补跑限制到期，避免迁移时重复触发。本次迁移时旧预算为空，且最后一次本机请求后已有新发布；手动 15 分钟间隔还会依据 GitHub 的运行记录检查。

   ```sh
   systemctl disable --now zrbac-news-watchdog.timer
   systemctl is-active zrbac-news-watchdog.service
   systemctl disable --now zrbac-news-refresh.service
   ```

4. 将 `wrangler.jsonc` 的 `MANUAL_ENABLED` 改成 `true`，暂时保持 `WATCHDOG_ENABLED` 为 `false`，重新部署。测试真实 POST → 工作流 → 发布 → 页面新时间。若返回 `fresh` / `cooldown`，等冷却结束后再验证实际触发。
5. 验证成功后，把 `WATCHDOG_ENABLED` 改为 `true`，部署并观察下一次 cron 日志；应有 `watchdog` 事件，不能有持续 503。提交这两个开关的实际状态，避免日后重新部署关闭功能。
6. 设置仓库变量为真实接口地址，再触发 Pages 发布：

   ```sh
   gh variable set NEWS_REFRESH_ENDPOINT --repo ZrBac/news \
     --body 'https://WORKER_HOST/api/news-refresh'
   gh workflow run news.yml --repo ZrBac/news --ref hexo
   ```

7. 等 Pages 部署成功，检查 HTML 的 `news-refresh-endpoint`，在浏览器验证刷新完成、连续点击冷却、接口故障时仍能读取已发布资讯。旧地址可以按 `ops/news-refresh-cloud-location.conf` 转发到同一 Worker，以兼容已经打开的页面；安装后验证并 reload nginx。

只有全部通过才算迁移完成。旧脚本、状态和 nginx 配置保留用于回退；不要停止旅行网站或关闭整台服务器。

## 回退与维护

- 先关闭 Worker 两个开关并重新部署，确认没有在途触发，再恢复原服务器 timer/API，避免双系统同时补跑。将 `ops/news-refresh-location.conf` 重新安装到 `/etc/nginx/news-refresh-location.conf`，运行 `nginx -t` 后 reload nginx，让旧地址重新指向本机 Python 服务。
- 删除 `NEWS_REFRESH_ENDPOINT` 仓库变量（或恢复之前的值），重新运行 `news.yml` 发布。未设置变量时构建默认使用原服务器地址。
- `npx wrangler tail` 可检查日志；监控 GitHub 令牌到期、Worker 请求/CPU/存储额度。凭证失效会返回 503，但已发布新闻仍可阅读。
- Worker 代码改动由 `news-worker-check.yml` 自动测试；云端部署使用 `npm run deploy`，不会随着 Pages 构建自动上传。
- 不要删除 Durable Object 命名空间或改动 `idFromName('news')`，否则会丢失冷却和重试预算。

## 生活指南问答

阅读入口是 `https://news.zacai.fun/guide/`，正文、搜索、收藏和离线阅读由 GitHub Pages 与浏览器完成。每小时发布资讯时检查原项目版本；只有正文或页面发生变化才更新离线资源。

`news-refresh` Worker 增加了 `GET /api/life-guide/status` 和 `POST /api/life-guide/chat`。没有模型密钥时状态为 `ready: false`，网站会显示“AI 问答尚未配置”，仍然可以查找相关原文。已按上游 life-decision-guide 的 MIT 规则准备提示词，正文采用 CC BY 4.0；提示词源版本和完整许可见 `src/guide-prompt.js`、`LIFE-GUIDE-LICENSE`。

### 开启问答（以 DeepSeek 为例）

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/)，登录后在 API Keys 中创建密钥，并确认账户有可用额度。不要把密钥发进聊天。
2. 打开 Cloudflare 控制台 → **Workers & Pages** → **news-refresh** → **Settings** → **Variables and Secrets** → **Add**。类型选 **Secret**，名称填 `GUIDE_API_KEY`，值填刚创建的密钥，然后保存并部署。密钥只需要填在这里。
3. 打开生活指南的“问答”，刷新页面。提示变成“问答已就绪”后输入一个问题，例如“房东不给退押金怎么办”。回答下方会列出可展开核对的正文条目。

已部署的默认变量是 `GUIDE_API_URL=https://api.deepseek.com/chat/completions`、`GUIDE_MODEL=deepseek-flash`，来自 [DeepSeek 当前官方调用文档](https://api-docs.deepseek.com/)。其他支持相同 chat/completions 协议的服务可以替换这两个变量和密钥；URL 必须是完整的 HTTPS 接口地址，模型名以服务商文档为准。以后通过 Wrangler 部署时也要同步修改 `wrangler.jsonc` 中的变量，避免覆盖控制台的配置。

模型 API 由模型服务商单独计费，Cloudflare 的请求额度不包含模型调用费用。默认每 IP 每分钟最多 6 次问答、全站每天最多 100 次模型请求（UTC 00:00 重置，对应北京时间 08:00）。全站预算由独立的 `life-guide-budget` Durable Object 实例持久保存；失败的模型请求也消耗预算。`GUIDE_DAILY_LIMIT` 可在 1–1000 之间调整。

云函数先查询轻量索引，再读取最多三个相关章节中的完整条目。它不接受客户端提供的正文、任意模型地址或工具指令；条目里的来源、争议和适用条件一并交给模型，未检索到依据时不会调用模型。每次回答最多输出 2000 tokens，上游有超时限制。问题与参考原文会发送给所配置的模型服务商，Worker 日志不保存问题、回答和密钥。

检查状态可在可信终端运行：

```sh
curl --fail -H 'Origin: https://news.zacai.fun' \
  'https://news-refresh.944052796.workers.dev/api/life-guide/status'
```

返回 `{"ready":true}` 只表示配置完整；首次实际提问才能验证密钥、模型权限与账户额度。仓库中的测试使用模拟模型，没有模型密钥时不把模拟结果当作真实问答验证。
