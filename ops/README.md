# 运行与维护

当前网站使用 GitHub Pages、GitHub Actions 和 [Cloudflare Workers](cloudflare/README.md)。默认分支为 `main`；发布入口是 `news.yml`，云函数也只触发此分支的同一工作流。

`cloudflare/` 包含手动刷新、停更补跑与去处共同记录的实现和测试。旧 Python 刷新服务、systemd 定时器和看房手帐服务已退役，其代码及部署说明可从 Git 历史恢复。

这里还保留两份已打开旧页面使用的 nginx 兼容配置：

- `news-refresh-cloud-location.conf`：将旧地址 `https://zacai.fun/api/news-refresh` 转发到现有 Worker。
- `news-refresh-limit.conf`：上述兼容入口的请求限流。

新页面直接请求 Worker。nginx 配置只用于维护旧入口，不参与 GitHub Pages 构建或定时采集。服务器上的私人数据库、访问凭据和备份由原部署单独管理。
