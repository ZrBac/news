# 资讯云函数

Cloudflare Workers 提供手动刷新、停更补跑和去处共同记录。抓取与发布由 `ZrBac/news` 的 `news.yml` / `main` 执行，网页和公开数据由 GitHub Pages 提供。

## 当前配置

- 服务地址：`https://news-refresh.944052796.workers.dev`。
- `MANUAL_ENABLED` 与 `WATCHDOG_ENABLED` 均开启；Cron 每小时 07、37 分钟运行。
- GitHub 仓库变量 `NEWS_REFRESH_ENDPOINT` 指向 Worker 的 `/api/news-refresh`；构建脚本默认也使用此地址。
- GitHub Pages 环境的部署分支策略允许 `main`；修改分支名时须同步工作流、Worker 和这条策略。
- 域名继续使用阿里云 DNS，目前未绑定 Worker 自定义域名。

旧地址 `https://zacai.fun/api/news-refresh` 仍通过 nginx 转发到 Worker，兼容已打开的旧页面。配置见 [运行说明](../README.md)。服务器刷新服务与定时器已停用。

## 手动刷新与补跑

- POST `/api/news-refresh` 和 GET `/api/news-refresh/status` 固定操作上述仓库、工作流和分支，不接受任意任务参数。
- 浏览器须提供资讯站 Origin，POST 还需 `X-News-Refresh: 1`。Origin 不是登录认证；每 IP 每分钟最多 60 次请求，真正限制触发次数的是全站持久化冷却。
- SQLite Durable Object 的 `idFromName('news')` 实例协调手动与自动请求；手动至少间隔 15 分钟，已有任务直接复用。
- Cron 检查 `data/status.json`。停更超过两小时且没有近期或正在运行的任务时补跑；同次停更滚动 24 小时最多三次，两次至少间隔两小时。
- 先持久化预算再调用 GitHub，失败和超时也消耗预算；新的发布时间重置自动补跑预算，较旧的 CDN 响应不能重置它。
- 查询结果缓存 10 秒；上游异常短暂退避。GitHub 凭据仅存 Worker Secret，不打印原始响应或凭据。

GitHub 自身的每小时采集任务继续运行。两套调度均受 GitHub API、队列与部署耗时影响。

## 去处共同记录

`/api/outings/profile` 使用同一 `NewsCoordinator` 类的 `idFromName('outings')` 实例。GET/POST 必须提供 `Authorization: Bearer <OUTING_PROFILE_TOKEN>`；浏览器读写另校验资讯站 Origin，构建任务可不带 Origin 读取。POST 按单条反馈或设置更新，最多保存 300 条，可撤销；接口不缓存，不记录令牌和请求正文。

连接码分别放在 Worker Secret 和 GitHub Actions 的 `OUTING_PROFILE_TOKEN` 中，两处必须一致。私人连接链接格式为 `https://news.zacai.fun/#local&outing-key=<连接码>`；浏览器保存连接码后立即清除地址中的令牌。两台手机各打开一次即可共用记录。轮换时更新两处 Secret 并给设备新的私人链接，原有记录继续保留。

采集程序只在内存里使用记录，公开文件与 Actions 缓存不含个人偏好。同步失败先保留本机待发送操作，快速连续修改保留最后一次选择。

## 检查与部署

使用 Node.js 22，在本目录执行：

```sh
npm ci
npm test
npm run check
npm run deploy
```

`npm test` 使用模拟 GitHub 请求检查冷却、并发、失败预算、查询分支、触发分支、权限和共同记录；Miniflare 验证真实 Workers 运行时及 SQLite 重启持久化。`npm run check` 只做打包检查，不上传。

首次部署先通过 `npx wrangler login` 登录账号，再用 `npx wrangler secret put GITHUB_TOKEN` 配置仅限本仓库且具有 Actions 读写权限的专用令牌。首次部署期间可先关闭两个运行开关，完成凭据与接口检查后再开启。连接码通过 `npx wrangler secret put OUTING_PROFILE_TOKEN` 写入；秘密只从可信终端的隐藏输入传入，不写进仓库、命令参数或静态资源。

Worker 代码推送后由 `news-worker-check.yml` 自动检查。Pages 工作流不会上传 Worker，修改 Worker 后须单独部署。部署后检查状态接口，并确认它能找到 `main` 上的工作流任务：

```sh
curl --fail -H 'Origin: https://news.zacai.fun' \
  https://news-refresh.944052796.workers.dev/api/news-refresh/status
```

## 维护与回滚

- `npx wrangler tail` 查看运行日志；检查令牌有效期及 Worker 用量。凭据失效会导致接口返回 503，已发布页面仍可阅读。
- 保持 Durable Object 命名空间及 `news`、`outings` 实例名称不变，保留冷却状态和共同记录。
- 应用回滚通过 Git revert 与重新部署完成；工作流和 Worker 的目标分支继续保持 `main`。
- Cloudflare 凭据只用于云函数，`OPENAI_API_KEY` 只配置在 GitHub Actions 的 AI 整理步骤中。
