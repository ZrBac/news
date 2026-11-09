# 运行说明

网站运行在 GitHub Pages、GitHub Actions 和 Cloudflare Workers 上。默认分支为 `main`，日常阅读、采集与发布不依赖常驻服务器。

| 部分 | 职责 |
| --- | --- |
| GitHub Pages | 提供页面、静态资源和公开数据 |
| GitHub Actions | 定时采集、内容整理、检查和发布 |
| [Cloudflare Workers](cloudflare/README.md) | 定时采集触发、手动刷新、停更补跑和去处记录同步 |

修改默认分支时，需要同时检查工作流的触发分支、云函数的目标分支，以及 Pages 环境的部署规则。

站点地址统一由 `NEWS_SITE_URL` 提供，值为 HTTPS 根地址，不带路径或结尾斜杠。在 Actions 和 Workers 的部署设置中分别配置同一值；Pages 的自定义域名继续在 Pages 设置中管理。构建时生成 canonical、站点地图和 HTTPS 入口，云函数据此校验请求来源、读取发布状态及推荐资料。更换域名时更新这三处配置并重新部署，无需修改源码。测试统一使用示例域名。

## 兼容入口

本目录的 `news-refresh-cloud-location.conf` 和 `news-refresh-limit.conf` 仅用于兼容以前打开的页面，将旧刷新地址转到云函数。当前页面直接使用云函数，这两份配置不参与网站构建和定时采集。

## 排查顺序

1. 查看 `Update and publish news` 最近一次任务，确认采集、检查和发布分别是否完成。
2. 查看网站 `data/status.json` 的更新时间，区分已发布和仍在排队。
3. 查看页面“来源状态”，确认是否只有个别来源异常。
4. 若页面内容较旧，联网刷新；离线资源不完整时，在相应页面重新准备。

临时采集失败会保留现有数据。完整快照及其备份都不可用时停止发布，不用空数据覆盖历史。
