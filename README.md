# 资讯

[news.zacai.fun](https://news.zacai.fun/) 的源码，默认分支为 `main`。

网站包含新闻、今晚与周末去处、杭州房源、汇率、生活指南和离线小游戏。页面由 GitHub Pages 托管，GitHub Actions 负责采集、AI 整理和发布；Cloudflare Workers 提供手动刷新、停更补跑和去处共同记录。

## 目录

- `news/`：页面、样式、浏览器脚本、来源配置和公开初始化数据。
- `scripts/`：采集、AI 整理与静态构建，使用 Python 标准库。
- `tests/`：采集规则、浏览器、离线和旧版本升级回归测试。
- `ops/cloudflare/`：云函数、独立 Node.js 依赖和测试。
- `.github/workflows/`：网站发布与云函数检查任务。

## 本地检查

使用 Python 3.12 和 Node.js 22。在根目录执行：

```sh
python3 -m unittest discover -s tests -v
python3 scripts/collect_news.py --previous-url https://news.zacai.fun/data/news.json
python3 scripts/build_news.py
python3 -m http.server 8765 --bind 127.0.0.1 --directory _site
```

浏览器依赖位于 `tests/browser/`，云函数依赖位于 `ops/cloudflare/`，分别在对应目录运行 `npm ci`。完整检查和配置见 [网站维护说明](news/README.md) 与 [云函数说明](ops/cloudflare/README.md)。

## 发布与密钥

推送 `main` 后自动检查并发布；定时采集和手动刷新使用同一条 `news.yml` 工作流。云函数修改通过独立检查后，在 `ops/cloudflare/` 执行 `npm run deploy` 发布。

`OPENAI_API_KEY` 放在 GitHub Actions Secrets 中，只注入 AI 整理步骤。浏览器读取已生成的结果，不持有 API Key。去处连接令牌放在 Actions 与 Worker Secrets 中；密钥文件、本地缓存和生成数据均不提交。

旧博客、看房手帐和服务器刷新程序已从当前分支移除；需要查阅时可使用 Git 历史。旧版浏览器升级与离线兼容测试继续保留。
