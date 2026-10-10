import gzip
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('collector', ROOT / 'scripts/collect_news.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 23, 4, tzinfo=timezone.utc)
        self.source = {'id': 'example', 'category': 'tech'}

    def feed(self, link='https://example.com/story?utm_source=rss', date='Wed, 23 Sep 2026 03:00:00 GMT'):
        return f'''<rss><channel><item><title><![CDATA[AI &amp; 科技 <script>alert(1)</script>]]></title>
          <link>{link}</link><pubDate>{date}</pubDate>
          <description><![CDATA[<p>正文摘要</p><script>bad()</script><img src="x" onerror="bad()"/>]]></description>
          </item></channel></rss>'''.encode()

    def test_feed_has_clean_text_and_canonical_link(self):
        items = collector.parse_feed(self.feed(), self.source, self.now)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['title'], 'AI & 科技')
        self.assertEqual(items[0]['excerpt'], '正文摘要')
        self.assertEqual(items[0]['url'], 'https://example.com/story')
        self.assertEqual(items[0]['category'], 'ai')

    def test_fetch_decodes_gzip_feeds_with_or_without_encoding_header(self):
        feed = self.feed()
        for body, headers in ((feed, {}), (gzip.compress(feed), {'Content-Encoding': 'gzip'}),
                              (gzip.compress(feed), {})):
            with self.subTest(headers=headers, compressed=body != feed):
                response = io.BytesIO(body)
                response.headers = headers
                with patch.object(collector.urllib.request, 'urlopen', return_value=response):
                    decoded = collector.fetch('https://example.com/feed')
                self.assertEqual(decoded, feed)
                self.assertEqual(len(collector.parse_feed(decoded, self.source, self.now)), 1)

    def test_fetch_limits_downloaded_and_decompressed_response_sizes(self):
        for body, message in ((b'x' * 101, 'Response exceeds size limit'),
                              (gzip.compress(b'x' * 10000), 'Decompressed response exceeds size limit')):
            with self.subTest(message=message):
                response = io.BytesIO(body)
                response.headers = {}
                with patch.object(collector.urllib.request, 'urlopen', return_value=response):
                    with self.assertRaisesRegex(ValueError, message):
                        collector.fetch('https://example.com/feed', max_bytes=100)

    def test_rejects_unsafe_links_undated_old_and_future_articles(self):
        self.assertFalse(collector.parse_feed(self.feed(link='javascript:alert(1)'), self.source, self.now))
        for date in ['', 'Wed, 23 Sep 2026 03:00:00', 'Wed, 23 Sep 2020 03:00:00 GMT', 'Wed, 30 Sep 2026 03:00:00 GMT']:
            self.assertFalse(collector.parse_feed(self.feed(date=date), self.source, self.now))

    def test_failed_source_history_is_retained_and_duplicate_is_replaced(self):
        old = collector.parse_feed(self.feed(), self.source, self.now)[0]
        revised = dict(old, title='AI 更新后的标题')
        retained = collector.merge_articles([old], [], self.now, {'example'})
        self.assertEqual(retained, [old])
        merged = collector.merge_articles([old], [revised], self.now, {'example'})
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['title'], revised['title'])
        self.assertFalse(collector.merge_articles([old], [], self.now + timedelta(days=31), {'example'}))

    def test_limit_excerpt_and_keep_source_provenance(self):
        feed = self.feed().replace('正文摘要'.encode(), ('很长的内容' * 100).encode())
        item = collector.parse_feed(feed, self.source, self.now)[0]
        self.assertLessEqual(len(item['excerpt']), 90)
        self.assertEqual(item['sourceId'], 'example')

    def test_busy_sources_do_not_displace_older_low_volume_sources_and_categories(self):
        base = collector.parse_feed(self.feed(), self.source, self.now)[0]
        allowed = {key: {'id': key, 'category': category} for key, category in
                   (('busy', 'sports'), ('quiet', 'sports'), ('games', 'gaming'))}
        busy = [dict(base, title='比赛新闻' + str(i), category='sports', sourceId='busy',
                     url=f'https://example.com/busy/{i}', publishedAt=collector.iso(self.now)) for i in range(6500)]
        quiet = [dict(base, title='赛场记录' + str(i), category='sports', sourceId='quiet',
                      url=f'https://example.com/quiet/{i}', publishedAt=collector.iso(self.now - timedelta(days=28))) for i in range(5)]
        games = [dict(base, title='游戏发布' + str(i), category='gaming', sourceId='games',
                      url=f'https://example.com/games/{i}', publishedAt=collector.iso(self.now - timedelta(days=29))) for i in range(20)]
        archive = collector.merge_articles(busy + quiet + games, [], self.now, allowed)
        self.assertEqual(len(archive), 6000)
        self.assertEqual(len([a for a in archive if a['sourceId'] == 'quiet']), 5)
        self.assertEqual(len([a for a in archive if a['category'] == 'gaming']), 20)
        self.assertEqual([a['publishedAt'] for a in archive],
                         sorted([a['publishedAt'] for a in archive], reverse=True))
        self.assertFalse(collector.merge_articles(archive, [], self.now + timedelta(days=31), allowed))

    def test_stable_id_and_unique_titles(self):
        item = collector.parse_feed(self.feed(), self.source, self.now)[0]
        same_title = dict(item, url='https://example.com/duplicate')
        self.assertEqual(len(collector.merge_articles([item], [same_title], self.now, {'example'})), 1)
        self.assertIsNone(collector.safe_url('https://user:password@example.com/'))

    def test_dedicated_categories_survive_ai_keyword_and_archive_merge(self):
        for category in ('entertainment', 'gaming', 'sports'):
            with self.subTest(category=category):
                source = dict(self.source, category=category)
                items = collector.parse_feed(self.feed(), source, self.now)
                self.assertEqual(items[0]['category'], category)
                self.assertEqual(collector.merge_articles(items, [], self.now, {'example'}), items)

    def test_hangzhou_housing_requires_location_and_housing_topic(self):
        source = dict(self.source, category='housing')
        for title in ('杭州二手房成交327套', '杭州新房成交99套', '临平推出购房补贴', '杭州AI选房服务与购房政策解读', '杭州楼盘户型首次亮相', '杭州新盘开放示范区'):
            with self.subTest(title=title):
                feed = self.feed().replace(b'AI &amp; \xe7\xa7\x91\xe6\x8a\x80 <script>alert(1)</script>', title.encode())
                articles = collector.parse_feed(feed, source, self.now)
                self.assertEqual(len(articles), 1)
                self.assertEqual(articles[0]['category'], 'housing')
                self.assertEqual(len(collector.merge_articles(articles, [], self.now, {'example'})), 1)
        for title in ('杭州银行利润增长', '杭州国庆旅游客流', '杭州电影预售开启', '杭州演唱会门票预售', '上海新房成交99套', '全国楼市政策调整', '王石不卖房了？ - 杭州网', '上海新房成交99套 - 住在杭州网'):
            with self.subTest(title=title):
                self.assertFalse(collector.is_hangzhou_housing(title))
        article = collector.parse_feed(self.feed(), self.source, self.now)[0]
        unrelated = dict(article, title='杭州天气降温', category='housing')
        self.assertFalse(collector.merge_articles([unrelated], [], self.now, {'example'}))

    def test_direct_housing_bulletins_use_dated_publisher_rows_and_safe_links(self):
        source = {'id': 'hz-housing-daily', 'category': 'housing',
                  'url': 'https://zzhz.zjol.com.cn/hz/bb/'}
        def row(link, date, title='9月23日，杭州新房2盘预售，3盘报名中'):
            return f'<li class="news_item"><a href="{link}"><img alt="不要当作标题" />' \
                   f'<h2>{title}</h2><span class="resource">住在杭州网</span>' \
                   f'<span class="time">| {date}</span></a></li>'
        link = '//zzhz.zjol.com.cn/hz/bb/202609/t20260921_1234.shtml'
        content = '<aside><a href="' + link + '">杭州新房报道</a></aside><ul>'
        content += row(link, '2026-09-23')
        for invalid_link, date, title in ((link, '', '杭州楼盘信息'),
                                         (link, '2026-08-01', '杭州楼盘信息'),
                                         (link, '2026-09-30', '杭州楼盘信息'),
                                         (link, '2026-99-01', '杭州楼盘信息'),
                                         ('javascript:alert(1)', '2026-09-23', '杭州楼盘信息'),
                                         ('https://example.com/story', '2026-09-23', '杭州楼盘信息'),
                                         (link, '2026-09-23', '杭州电影预售消息')):
            content += row(invalid_link, date, title)
        articles = collector.parse_housing_daily((content + '</ul>').encode(), source, self.now)
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]['title'], '9月23日，杭州新房2盘预售，3盘报名中')
        self.assertEqual(articles[0]['publishedAt'], '2026-09-22T16:00:00Z')
        self.assertEqual(articles[0]['url'], 'https:' + link)
        self.assertEqual(articles[0]['sourceId'], source['id'])

    def test_housing_history_survives_busy_archive_and_source_failures(self):
        article = collector.parse_feed(self.feed(), self.source, self.now)[0]
        housing = dict(article, title='杭州新盘领出预售证', category='housing')
        source = dict(self.source, category='housing')
        allowed = {source['id']: source, 'sports': {'id': 'sports', 'category': 'sports'}}
        busy = [dict(article, sourceId='sports', category='sports', title='比赛结果' + str(i),
                     url='https://example.com/sport/' + str(i), publishedAt=collector.iso(self.now))
                for i in range(6000)]
        archive = collector.merge_articles([housing] + busy, [], self.now, allowed)
        self.assertEqual(len(archive), 6000)
        self.assertTrue(any(a['category'] == 'housing' for a in archive))
        retained = collector.recent_housing_articles([housing] + busy, [], self.now, allowed)
        self.assertEqual(retained, [housing])
        self.assertEqual(collector.recent_housing_articles(retained, [], self.now, allowed), retained)
        self.assertFalse(collector.recent_housing_articles(retained, [], self.now + timedelta(days=31), allowed))
        self.assertFalse(collector.recent_housing_articles(retained, [], self.now, {}))

    def test_model_launches_are_separate_from_ai_and_old_articles_are_migrated(self):
        for title in ('OpenAI 发布 GPT-6.1 Sol', '智谱 GLM-5.3 模型上线',
                      '阿里千问开源 Qwen-Image-2.1 图像模型', 'Introducing Claude Haiku 5.5',
                      '谷歌推出 EmbeddingGemma 2', '智谱一口气开源6款模型'):
            with self.subTest(title=title):
                feed = self.feed().replace(b'AI &amp; \xe7\xa7\x91\xe6\x8a\x80 <script>alert(1)</script>', title.encode())
                article = collector.parse_feed(feed, self.source, self.now)[0]
                self.assertEqual(article['category'], 'models')
                old = dict(article, category='ai')
                self.assertEqual(collector.merge_articles([old], [], self.now, {'example'})[0]['category'], 'models')
                for category in ('sports', 'entertainment'):
                    self.assertEqual(collector.article_category(title, dict(self.source, category=category)), category)

    def test_model_only_sources_reject_rumors_apps_and_unrelated_same_names(self):
        source = dict(self.source, category='models')
        for title in ('消息称 Gemini 4 即将发布', 'OpenAI 推出 ChatGPT 插件',
                      '谷歌云发布 Gemini Agent 智能体', 'DeepSeek官方开源昇腾基础组件',
                      '智谱计划开源代码库', '丰田推出新款 Sora 氢燃料电池巴士',
                      'DeepSeek终于丢了开源第一王座', '如何使用 Qwen3',
                      'Claude Fable 5 额度重新上线', 'OpenAI 投资新闻',
                      '英伟达发布 DGX Station：本地运行 AI 模型',
                      '辛顿提议 AI 模型推出前需通过审核',
                      'Ecosia 押注中国开源 AI 模型，取代 Mistral Large',
                      '派早报：Anthropic 发布 Claude Haiku 5.5 模型等'):
            with self.subTest(title=title):
                self.assertIsNone(collector.article_category(title, source))
        self.assertTrue(collector.is_model_release('Gemini 4 Argon: our next era of frontier intelligence', 'deepmind'))
        self.assertTrue(collector.is_model_release('Qwen-Image-2.1: Compact Image Creation - Qwen', 'gnews-qwen-models'))
        self.assertFalse(collector.is_model_release('Qwen3.8: a review of existing models', 'example'))

    def test_model_history_is_independent_of_the_busy_news_archive(self):
        release = collector.parse_feed(self.feed(), self.source, self.now)[0]
        release.update(title='通义发布 Qwen3.8 模型', category='ai', publishedAt='2026-09-15T03:00:00Z')
        busy = [dict(release, title='综合资讯', category='general', url=f'https://example.com/news/{i}',
                     publishedAt='2026-09-23T03:00:00Z', sourceId='source' + str(i)) for i in range(6001)]
        allowed = {a['sourceId'] for a in busy} | {'example'}
        shared = collector.merge_articles([release], busy, self.now, allowed)
        self.assertTrue(any(a['sourceId'] == 'example' for a in shared))
        models = collector.recent_model_releases([release], busy, self.now, allowed)
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]['category'], 'models')
        self.assertFalse(collector.recent_model_releases(models, [], self.now + timedelta(days=31), allowed))

    def test_ai_tools_hardware_finance_and_model_releases_have_distinct_categories(self):
        cases = [
            ('阿里Qoder上线Fast模式', 'ai'),
            ('国产AI工具推出新功能', 'ai'),
            ('陶哲轩与OpenAI讨论数学研究', 'ai'),
            ('Cursor发布编程助手更新', 'ai'),
            ('英伟达发布AI显卡，配备新GPU', 'tech'),
            ('46999元起，迷你AI工作站发售', 'tech'),
            ('微软推出Edge155稳定版，增强AI标签整理', 'tech'),
            ('AI巨头盈利增长，标普股价上涨', 'general'),
            ('特斯拉布局物理AI，成为投资标的', 'general'),
            ('OpenAI发布GPT-6.1模型', 'models'),
            ('AirPods Max推出新颜色', 'tech'),
            ('AION新车型发布', 'tech'),
        ]
        for title, expected in cases:
            with self.subTest(title=title):
                self.assertEqual(collector.article_category(title, self.source), expected)

    def test_archive_reclassification_uses_current_source_rules_and_filters(self):
        article = collector.parse_feed(self.feed(), self.source, self.now)[0]
        article.update(title='阿里Qoder上线Fast模式', category='tech')
        allowed = {'example': self.source}
        self.assertEqual(collector.merge_articles([article], [], self.now, allowed)[0]['category'], 'ai')
        allowed = {'example': dict(self.source, category='entertainment', titleFilter='entertainment')}
        for title in ('梦见公主是什么意思', '新任白宫新闻秘书曾在北京工作', '辅助驾驶的技术风险如何兜底'):
            with self.subTest(title=title):
                self.assertFalse(collector.merge_articles([dict(article, title=title, category='entertainment')], [], self.now, allowed))
        for title in ('电影《梦见你》上映', '知名演员获得飞天奖', '诺贝尔文学奖揭晓', '歌手发布新专辑'):
            self.assertEqual(collector.article_category(title, allowed['example']), 'entertainment')
        sports = dict(self.source, category='sports')
        for title in ('彩经前瞻：国米主场占优', '半全场分析：马德里竞技进球', '英超赔率预测'):
            self.assertIsNone(collector.article_category(title, sports))
        for title in ('足球赛果：国米2比1获胜', '球员因违规投注被禁赛，联赛公布调查结果'):
            self.assertEqual(collector.article_category(title, sports), 'sports')

    def test_rdf_feed_retains_publisher_date_link_and_excerpt(self):
        feed = b'''<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
            xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <item rdf:about="https://example.com/world">
            <title>World news &amp; analysis</title><link>https://example.com/world</link>
            <description><![CDATA[<p>A short summary.</p>]]></description>
            <dc:date>2026-09-22T14:29:00Z</dc:date>
          </item></rdf:RDF>'''
        items = collector.parse_feed(feed, dict(self.source, category='general'), self.now)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['title'], 'World news & analysis')
        self.assertEqual(items[0]['url'], 'https://example.com/world')
        self.assertEqual(items[0]['publishedAt'], '2026-09-22T14:29:00Z')
        self.assertEqual(items[0]['excerpt'], 'A short summary.')
        self.assertEqual(items[0]['category'], 'general')


class BuildTests(unittest.TestCase):
    def test_housing_packet_is_independent_deduplicated_and_small(self):
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        articles = [{'id': 's' + str(i), 'category': 'sports', 'title': '比赛' + str(i),
                     'publishedAt': '2026-10-10T04:00:00Z'} for i in range(200)]
        housing = [{'id': 'h' + str(i), 'category': 'housing', 'title': '杭州楼盘' + str(i),
                    'publishedAt': '2026-10-09T04:00:00Z'} for i in range(70)]
        duplicate = dict(housing[0], id='copy', title=housing[0]['title'] + ' - 住在杭州网')
        with tempfile.TemporaryDirectory() as tmp:
            builder.build_news_pages({'articles': articles, 'housingArticles': [housing[0], duplicate] + housing[1:]}, Path(tmp))
            latest = json.loads((Path(tmp) / 'data/latest.json').read_text())
            self.assertEqual(latest['articles'], articles[:150])
            self.assertEqual(latest['housingArticles'], housing[:60])

    def test_brief_packet_includes_low_volume_categories_and_beijing_dates(self):
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        busy = [{'id': 's' + str(i), 'category': 'sports', 'title': '比赛消息' + str(i),
                 'sourceId': 'sports', 'publishedAt': '2026-10-10T04:00:00Z'} for i in range(170)]
        rare = [{'id': c, 'category': c, 'title': c + '今日消息', 'sourceId': c,
                 'publishedAt': '2026-10-09T16:01:00Z'} for c in ('general', 'tech', 'ai', 'entertainment', 'gaming', 'housing')]
        model = {'id': 'model', 'category': 'models', 'title': '今日模型发布', 'sourceId': 'official',
                 'publishedAt': '2026-10-09T16:00:00Z'}
        yesterday = dict(model, id='yesterday', title='昨日模型发布', publishedAt='2026-10-09T15:59:00Z')
        data = {'updatedAt': '2026-10-10T06:00:00Z', 'articles': busy + rare,
                'modelReleases': [model, yesterday]}
        with tempfile.TemporaryDirectory() as tmp:
            builder.build_news_pages(data, Path(tmp))
            latest = json.loads((Path(tmp) / 'data/latest.json').read_text())
            self.assertEqual(latest['articles'], busy[:150])
            self.assertEqual(latest['briefDays'], ['2026-10-10', '2026-10-09'])
            self.assertEqual({a['category'] for a in latest['briefArticles']},
                             {'general', 'tech', 'ai', 'models', 'entertainment', 'gaming', 'sports', 'housing'})
            self.assertEqual(len([a for a in latest['briefArticles'] if a['category'] == 'sports']), 5)
            self.assertEqual({a['id'] for a in latest['briefArticles'] if a['category'] == 'models'},
                             {'model', 'yesterday'})
            self.assertLessEqual(len(latest['briefArticles']), 80)
    def test_gaming_snapshot_is_available_beyond_the_first_news_page(self):
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        busy = [{'id': 's' + str(i), 'category': 'sports', 'title': '比赛' + str(i),
                 'publishedAt': '2026-10-10T04:00:00Z'} for i in range(200)]
        gaming = [{'id': 'g' + str(i), 'category': 'gaming', 'title': '新游' + str(i),
                   'publishedAt': '2026-10-09T04:00:00Z'} for i in range(70)]
        with tempfile.TemporaryDirectory() as tmp:
            builder.build_news_pages({'articles': busy + gaming}, Path(tmp))
            latest = json.loads((Path(tmp) / 'data/latest.json').read_text())
            self.assertEqual(latest['articles'], busy[:150])
            self.assertEqual(latest['gamingArticles'], gaming[:60])

    def test_recent_model_releases_are_cached_separately_from_the_first_news_page(self):
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        articles = [{'id': str(i), 'category': 'general', 'title': '综合' + str(i),
                     'publishedAt': '2026-10-08T04:00:00Z'} for i in range(160)]
        releases = [{'id': 'm' + str(i), 'category': 'models', 'title': '模型发布' + str(i),
                     'publishedAt': '2026-10-07T04:00:00Z'} for i in range(70)]
        duplicate = dict(releases[0], id='copy', title=releases[0]['title'] + ' - 聚合来源')
        with tempfile.TemporaryDirectory() as tmp:
            builder.build_news_pages({'articles': articles + [releases[0], duplicate] + releases[1:]}, Path(tmp))
            latest = json.loads((Path(tmp) / 'data/latest.json').read_text())
            self.assertEqual(latest['articles'], articles[:150])
            self.assertEqual(latest['modelReleases'], releases[:60])
            builder.build_news_pages({'articles': articles,
                                      'modelReleases': [releases[0], duplicate] + releases[1:]}, Path(tmp))
            latest = json.loads((Path(tmp) / 'data/latest.json').read_text())
            self.assertEqual(latest['modelReleases'], releases[:60])
            self.assertEqual(latest['archive']['total'], len(articles))

    def test_small_news_pages_preserve_all_articles_and_stable_chunks(self):
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        articles = [{'id': str(i), 'publishedAt': '2026-10-08T04:00:00Z',
                     'category': 'tech', 'sourceId': 'example',
                     'title': '测试资讯' + str(i)} for i in range(701)]
        data = {'updatedAt': '2026-10-08T05:00:00Z', 'articles': articles, 'sources': []}
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            builder.build_news_pages(data, output)
            latest = json.loads((output / 'data/latest.json').read_text())
            self.assertEqual(latest['articles'], articles[:150])
            self.assertEqual(latest['archive']['total'], len(articles))
            combined = list(latest['articles'])
            for url in latest['archive']['pages']:
                self.assertRegex(url, r'^/data/archive/[a-f0-9]{16}\.json$')
                page = json.loads((output / url.lstrip('/')).read_text())
                self.assertLessEqual(len(page['articles']), 150)
                combined.extend(page['articles'])
            self.assertEqual(combined, articles)
            index = json.loads((output / latest['archive']['lookup'].lstrip('/')).read_text())
            self.assertEqual(len(index['rows']), len(articles))
            self.assertEqual(latest['archive']['categories'], {'tech': ['example']})
            self.assertEqual(index['rows'][-1][2], '2026-10-08')
            last_page = index['pages'][index['rows'][-1][4]]
            self.assertIn(articles[-1], json.loads((output / last_page.lstrip('/')).read_text())['articles'])
            data['updatedAt'] = '2026-10-08T06:00:00Z'
            builder.build_news_pages(data, output)
            self.assertEqual(json.loads((output / 'data/latest.json').read_text())['archive'],
                             latest['archive'])
            builder.build_news_pages({**data, 'articles': []}, output)
            self.assertEqual(json.loads((output / 'data/latest.json').read_text())['archive']['pages'], [])

    def test_build_news_only_removes_stale_blog_files(self):
        data = ROOT / 'news/data/news.json'
        existed = data.exists()
        original = data.read_bytes() if existed else None
        try:
            data.parent.mkdir(parents=True, exist_ok=True)
            data.write_text(json.dumps({'articles': [], 'updatedAt': '2026-09-24T06:00:00Z'}))
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / 'out'
                # Rebuilding an old output must remove previously published blog files.
                stale_paths = ('blog/index.html', '2020/story/index.html', 'asset.css', 'atom.xml', 'CNAME')
                for path in stale_paths:
                    target = output / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('old blog content')
                subprocess.run([sys.executable, str(ROOT / 'scripts/build_news.py'), '--output', str(output)], check=True, capture_output=True)
                self.assertIn('id="news-content"', (output / 'index.html').read_text())
                for path in stale_paths:
                    self.assertFalse((output / path).exists())
                self.assertNotIn('/blog/', (output / 'index.html').read_text())
                self.assertNotIn('/blog/', (output / 'assets/news/app.js').read_text())
                self.assertEqual(re.findall(r'<loc>(.*?)</loc>', (output / 'sitemap.xml').read_text()),
                                 ['https://news.zacai.fun/', 'https://news.zacai.fun/games/', 'https://news.zacai.fun/guide/'])
                self.assertEqual(json.loads((output / 'data/status.json').read_text()),
                                 {'updatedAt': '2026-09-24T06:00:00Z'})
                manifest = json.loads((output / 'manifest.webmanifest').read_text())
                self.assertEqual(manifest['display'], 'standalone')
                self.assertEqual(manifest['start_url'], '/')
                for size in (192, 512):
                    icon = next(i for i in manifest['icons'] if i['sizes'] == f'{size}x{size}')
                    png = (output / icon['src'].lstrip('/')).read_bytes()
                    self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
                    self.assertEqual(int.from_bytes(png[16:20], 'big'), size)
                    self.assertEqual(int.from_bytes(png[20:24], 'big'), size)
                worker = (output / 'sw.js').read_text()
                self.assertNotIn('__BUILD_ID__', worker)
                self.assertNotIn('__SHELL_FILES__', worker)
                shell = json.loads(re.search(r'const SHELL = (\[.*?\]);', worker, re.S).group(1))
                self.assertNotIn('/data/news.json', shell)
                self.assertIn('/games/', shell)
                self.assertIn('/guide/', shell)
                guide = (output / 'guide/index.html').read_text()
                guide_data = re.search(r'/assets/news/guide-index\.[0-9a-f]{12}\.json', guide).group(0)
                self.assertIn(guide_data, shell)
                book = json.loads((output / 'guide/book.json').read_text())
                index = json.loads((output / guide_data.lstrip('/')).read_text())
                self.assertEqual(len(index['entries']), len(book['entries']))
                self.assertTrue(all('body' not in entry for entry in index['entries']))
                self.assertEqual(index['entries'], [{key: value for key, value in entry.items() if key != 'body'}
                                                   for entry in book['entries']])
                self.assertNotIn('guide-book.', ''.join(shell))
                self.assertNotIn('AI 问答', guide)
                self.assertNotIn('guide-endpoint', guide)
                self.assertNotIn('__GUIDE_', guide)
                self.assertIn('成本：', guide)
                chapter_files = json.loads(re.search(r'const GUIDE_FILES = (\[.*?\]);', worker, re.S).group(1))
                self.assertEqual(chapter_files, [chapter['file'] for chapter in index['chapters']])
                self.assertTrue(all(file not in shell for file in chapter_files))
                chapter = json.loads((output / index['chapters'][14]['file'].lstrip('/')).read_text())
                self.assertEqual(chapter['revision'], index['revision'])
                self.assertTrue(all('备注：' in entry['body'] for entry in chapter['entries']))
                static = (output / 'guide/read/15/index.html').read_text()
                self.assertIn('押金', static)
                self.assertIn('备注：', static)
                self.assertNotIn('<script', static)
                for path in shell:
                    self.assertTrue((output / (path.lstrip('/') + 'index.html' if path.endswith('/') else path.lstrip('/'))).is_file())
                games = (output / 'games/index.html').read_text()
                for name, extension in [('compat', 'js'), ('compat', 'css'), ('games', 'js'), ('games-core', 'js'), ('games', 'css'), ('table-games', 'js'), ('table-games-core', 'js'), ('table-games', 'css'), ('extra-games', 'js'), ('extra-games-core', 'js'), ('extra-games', 'css'), ('casual-games', 'js'), ('casual-games-core', 'js'), ('casual-games', 'css')]:
                    match = re.search(r'/assets/news/' + name + r'\.[0-9a-f]{12}\.' + extension, games)
                    self.assertIsNotNone(match)
                    self.assertIn(match.group(0), shell)
                # The document must not load an unversioned cached script or stylesheet.
                homepage = (output / 'index.html').read_text()
                self.assertIn('rel="canonical" href="https://news.zacai.fun/"', homepage)
                for filename in ('news.xml', 'sitemap.xml', 'robots.txt'):
                    contents = (output / filename).read_text()
                    self.assertIn('https://news.zacai.fun/', contents)
                    self.assertNotIn('https://zrbac.github.io', contents)
                for name, extension in [('compat', 'js'), ('compat', 'css'), ('app', 'js'), ('pwa', 'js'), ('style', 'css'), ('favicon', 'svg')]:
                    match = re.search(r'/assets/news/' + name + r'\.[0-9a-f]{12}\.' + extension, homepage)
                    self.assertIsNotNone(match)
                    self.assertEqual((output / match.group(0).lstrip('/')).read_bytes(), (ROOT / 'news/assets' / f'{name}.{extension}').read_bytes())
                # Hourly news publications must not force a new application-shell update.
                data.write_text(json.dumps({'articles': [], 'updatedAt': '2026-09-24T07:00:00Z'}))
                subprocess.run([sys.executable, str(ROOT / 'scripts/build_news.py'), '--output', str(output)], check=True, capture_output=True)
                self.assertEqual((output / 'sw.js').read_text(), worker)
                cloud_endpoint = 'https://news-api.zacai.fun/api/news-refresh'
                env = dict(os.environ, NEWS_REFRESH_ENDPOINT=cloud_endpoint)
                command = [sys.executable, str(ROOT / 'scripts/build_news.py'), '--output', str(output)]
                subprocess.run(command, check=True, capture_output=True, env=env)
                self.assertIn(f'name="news-refresh-endpoint" content="{cloud_endpoint}"',
                              re.sub(r'\s+', ' ', (output / 'index.html').read_text()))
                self.assertNotEqual((output / 'sw.js').read_text(), worker)
                env['NEWS_REFRESH_ENDPOINT'] = 'https://user:secret@example.com/api/news-refresh'
                self.assertNotEqual(subprocess.run(command, capture_output=True, env=env).returncode, 0)
        finally:
            if existed:
                data.write_bytes(original)
            elif data.exists():
                data.unlink()


if __name__ == '__main__':
    unittest.main()
