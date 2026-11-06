# 资讯

一个日常使用的小网站：看新闻、查汇率、找杭州的去处，也能读指南、玩小游戏。

**访问：[news.zacai.fun](https://news.zacai.fun/)**

## 可以做什么

| 入口 | 功能 |
| --- | --- |
| [资讯](https://news.zacai.fun/) | 每日速览与分类阅读，支持搜索、日期筛选、收藏和来源状态查看 |
| [今晚](https://news.zacai.fun/#tonight) | 按到家时间与精力，继续阅读、摄影、写作、做饭等兴趣项目，也能挑选附近活动 |
| [周末](https://news.zacai.fun/#local) | 杭州及周边的新活动、爬山、骑行、露营和雨天备选 |
| [汇率](https://news.zacai.fun/#exchange) | 美元、日元、泰铢兑人民币的近一个月走势、金额换算与 30 天最低提醒 |
| [杭州房价](https://news.zacai.fun/#housing) | 成交报告、市场数据与楼盘资讯，可继续查看自动采集的房源 |
| [生活指南](https://news.zacai.fun/guide/) | 按章节阅读、搜索和收藏《高性价比人生指南》 |
| [小游戏](https://news.zacai.fun/games/) | 纸牌、数独、卡牌地牢、塔防、俄罗斯方块、扫雷等触屏小游戏 |

新闻按栏目整理，去处独立展示。部分资讯摘要和活动推荐经过 AI 整理，保留原文与来源，方便核对。

每日速览优先展示重大公共消息，再兼顾不同栏目。央视新闻列表与现有订阅共同补充消息；正式放假安排等公共通知即使离开最新列表，也会保留为当天的速览候选。

各新闻栏目都会补读近期原文，按栏目提炼一两句有依据的要点：民生侧重办理条件与时间，财经保留统计口径，游戏交代平台与开放时间等。每轮轮流处理各栏目，新消息优先；无法读取正文或核对依据时保留原摘要，不影响正常更新。

“今晚”可以记下本次成果和下次接着做什么，已开始的项目会优先展示。在“偏好与反馈”首次连接后，两台设备会自动同步偏好、活动标记和积累文字；离线先保存在本机，联网后补传。积累文字不会作为 AI 推荐输入，照片和录音仍由自己保管；记录也能导出、导入。每天的新选题只用于尚未开始的项目，休息无需记录或打卡。

## 更新与离线

- 新闻计划每小时检查一次；去处补充检索和房源计划每天北京时间 9 点、16 点检查。实际完成时间受来源、排队和发布耗时影响。
- 页面上的“刷新资讯”可以请求一次更新。已有任务时复用该任务，重复请求有冷却时间。
- 普通刷新会读取最新页面，无需再手动点击版本更新提示。
- 支持安装到桌面。指南、小游戏和房源可在各自页面准备离线资源；新闻和收藏可读取已保存的内容。
- iPhone 添加到主屏幕后，从桌面图标联网打开一次，完成离线准备后再断网使用。

## 项目结构

前端使用原生 HTML、CSS 和 JavaScript，采集与构建使用 Python 标准库。GitHub Pages 托管网页，GitHub Actions 定时采集并发布，Cloudflare Workers 提供刷新协调和去处记录同步。

```text
news/                 页面、样式、脚本与内容来源配置
scripts/              采集、内容整理和静态构建
tests/                数据规则、浏览器、离线与升级检查
ops/cloudflare/       云函数及其测试
.github/workflows/    自动检查与发布
```

## 本地预览

使用 Python 3.12，在仓库根目录执行：

```sh
python3 scripts/previous_snapshot.py --url https://news.zacai.fun/data/news.json --output news/data/news.json
python3 scripts/build_news.py
python3 -m http.server 8765 --bind 127.0.0.1 --directory _site
```

打开 <http://127.0.0.1:8765>。新闻和相关数据沿用公开快照；未单独采集时，房源使用仓库内的初始数据。生成结果位于 `_site/`，不直接修改生成文件。

## 检查与维护

```sh
python3 -m unittest discover -s tests -v
npm ci --prefix tests/browser
tests/browser/node_modules/.bin/playwright install --with-deps chromium
PLAYWRIGHT_MODULE="$PWD/tests/browser/node_modules/playwright" node tests/check-mobile.cjs
```

浏览器检查使用 Node.js 22 或更新版本，覆盖资讯、去处、汇率、房价、指南、全部小游戏，以及手机布局、旧版浏览器兼容和离线恢复。

默认分支为 `main`，网站代码推送后自动检查并发布。详见[网站维护说明](news/README.md)和[运行说明](ops/README.md)。

## 内容来源

新闻标题、摘要和数据归原发布方所有，阅读详情请访问原文。

生活指南来自 [eternity4719/HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter)，正文按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用；网站调整了阅读排版，保留来源和版本说明。天气来自 [Open-Meteo](https://open-meteo.com/)，汇率依据欧洲央行公开参考数据换算。
