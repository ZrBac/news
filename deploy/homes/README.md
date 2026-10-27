# 私人看房本服务

前端 `/homes/` 仍由 GitHub Pages 发布。现有阿里云服务器运行独立 WSGI 服务，监听 `127.0.0.1:8094`，由 `zacai.fun` 的 Nginx 代理 `/api/homes/`。不会新建收费云资源。

- 程序：`/opt/zrbac-homes/scripts/`，独立虚拟环境 `/opt/zrbac-homes/.venv/`。
- 私人数据：`/var/lib/zrbac-homes/notebook.sqlite3`，含收藏、配置、笔记与压缩照片。SQLite WAL 写入，服务用户 `zrbachomes`，状态目录权限 0700。
- 公开候选：同目录 `candidates.json`，只包含来源页面公开信息和观察历史。采集使用固定 HTTPS 来源，不接受用户提交的抓取地址，不登录或绕过验证码。
- API 每次返回候选时要求面积至少 100㎡、至少 3 室；未知信息或跨过下限的范围排除。原始来源观察继续保留，私人收藏不受此筛选影响；新采集结果也自动按相同条件返回。
- 私人认证：`/etc/zrbac-homes.env`（0600）提供 `HOMES_TOKEN_SHA256` 和 `HOMES_STATE_DIR`。此部署只对应一个家庭看房本。无注册接口；未经认证不能读取或写入私人记录。CORS 仅允许 `https://news.zacai.fun`，浏览器不发送 Cookie。
- 每日同机备份：`/var/lib/zrbac-homes/backups/YYYY-MM-DD.sqlite3`，保留最近 14 份，用 SQLite backup API 获得一致快照。同机备份不能防止整台服务器或磁盘损坏；浏览器仍可导出完整 JSON。

生产私人链接保存在 root 可读的 `/root/.config/zrbac-homes/access-link`，不可提交到仓库或复制到公开页面。链接的 fragment 只在客户端消费，随后从地址栏移除。持有链接的人能读写整个看房本；轮换时生成新的随机 32 字节令牌，将其 SHA-256 写入环境文件并重启 API，给使用者提供新链接，数据库保持不变。

## 更新部署

仅把 `scripts/homes_api.py` 和 `scripts/collect_home_candidates.py` 复制到上述程序目录，程序和虚拟环境需要允许服务用户读取/执行，私人状态目录不开放权限。独立环境安装本目录 `requirements.txt` 的固定依赖。服务和定时任务定义位于本目录，复制至 `/etc/systemd/system/` 后执行 `systemctl daemon-reload`。

`nginx-limit.conf` 放在 Nginx http 上下文；`nginx-location.conf` 只包含在 `zacai.fun` 的 HTTPS server 中。先运行 `nginx -t` 再 reload。现有站点配置的首次备份在 `/root/.config/zrbac-homes/zacai.fun.conf.before`。

```sh
systemctl restart zrbac-homes.service
systemctl enable --now zrbac-home-candidates.timer zrbac-homes-backup.timer
systemctl start zrbac-home-candidates.service
systemctl start zrbac-homes-backup.service
systemctl list-timers zrbac-home-candidates.timer zrbac-homes-backup.timer
```

候选北京时间 09:00 和 16:00 检查，允许最多 2 分钟错峰，开机后补跑。新房跟随三个区的真实下一页链接，各最多 3 页；二手房覆盖 10 个区域列表（300–350 万住宅，排除来源标记的商住小区，各前 30 条）和原有 3 个小区搜索，另核对云耀状态。最多 23 个公开页面、并发不超过 3、单页最多 2.5 MB、单次网络超时 18 秒；网络超时和 500/502/503/504 最多重试一次，总计最多 46 次请求。验证页、访问拒绝和限流不重试。整个任务由 systemd 限时 360 秒。

失败页面保留对应最后一次成功结果及检查日期，成功页面继续更新；合并后按房源编号去重，再判断缺失，避免跨页移动和来源重叠造成误标。公开快照最多 500 条，优先本次读到的记录，余量保留最近 30 天缺失记录。所有页面失败时退出非零并保留旧数据。页面显示失败情况，重新读取按钮只取服务器最新快照，不触发抓取。源站结构改变时需调整解析器；本服务并不保证完整市场覆盖、真实成交价或实时余房。

API 的 GET 支持 `?since=<server revision>`，未变化时不传照片。PUT 需提供 `baseRevision`，SQLite 原子比较后更新；不匹配返回 409。前端持久记录未上传状态，离线不会清掉队列；冲突需用户确认合并，保留差异副本，可能恢复另一设备删除的记录。服务端和前端都限制完整记录 60 MB，并校验结构。API 响应禁止缓存，私有请求不会进入 Service Worker 缓存。

## 验证与恢复

公开 `/api/homes/health` 返回 200；公开候选 `/api/homes/candidates` 返回 JSON；不带令牌访问 `/api/homes/notebook` 必须为 401。不要把令牌放在查询参数、测试日志或命令行参数里。

```sh
python3 -m unittest discover -s tests -p test_home_finder.py -v
PLAYWRIGHT_MODULE=/path/to/playwright NEWS_TEST_SITE=_site node tests/check-mobile.cjs
```

浏览器同步检查启动临时 Python 后端和临时 SQLite 文件，不向正式看房本写测试数据。若需回滚前端，原有 IndexedDB 的 `state` 和 schema 1 均保留兼容；新 `cloud` 元数据不影响旧版读取。恢复数据库前停止 API，保留当前库及其 WAL/SHM 文件作为回退，再恢复已验证备份，调整所有者并重启。不要在服务运行时直接覆盖 SQLite 文件。
