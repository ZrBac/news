import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
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

    def test_stable_id_and_unique_titles(self):
        item = collector.parse_feed(self.feed(), self.source, self.now)[0]
        same_title = dict(item, url='https://example.com/duplicate')
        self.assertEqual(len(collector.merge_articles([item], [same_title], self.now, {'example'})), 1)
        self.assertIsNone(collector.safe_url('https://user:password@example.com/'))

    def test_dedicated_categories_survive_ai_keyword_and_archive_merge(self):
        for category in ('entertainment', 'sports'):
            with self.subTest(category=category):
                source = dict(self.source, category=category)
                items = collector.parse_feed(self.feed(), source, self.now)
                self.assertEqual(items[0]['category'], category)
                self.assertEqual(collector.merge_articles(items, [], self.now, {'example'}), items)

    def test_hangzhou_housing_requires_location_and_housing_topic(self):
        source = dict(self.source, category='housing')
        for title in ('杭州二手房成交327套', '杭州新房成交99套', '临平推出购房补贴', '杭州AI选房服务与购房政策解读'):
            with self.subTest(title=title):
                feed = self.feed().replace(b'AI &amp; \xe7\xa7\x91\xe6\x8a\x80 <script>alert(1)</script>', title.encode())
                articles = collector.parse_feed(feed, source, self.now)
                self.assertEqual(len(articles), 1)
                self.assertEqual(articles[0]['category'], 'housing')
                self.assertEqual(len(collector.merge_articles(articles, [], self.now, {'example'})), 1)
        for title in ('杭州银行利润增长', '杭州国庆旅游客流', '上海新房成交99套', '全国楼市政策调整', '王石不卖房了？ - 杭州网', '上海新房成交99套 - 住在杭州网'):
            with self.subTest(title=title):
                self.assertFalse(collector.is_hangzhou_housing(title))
        article = collector.parse_feed(self.feed(), self.source, self.now)[0]
        unrelated = dict(article, title='杭州天气降温', category='housing')
        self.assertFalse(collector.merge_articles([unrelated], [], self.now, {'example'}))

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
        self.assertFalse(any(a['sourceId'] == 'example' for a in shared))
        models = collector.recent_model_releases([release], busy, self.now, allowed)
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]['category'], 'models')
        self.assertFalse(collector.recent_model_releases(models, [], self.now + timedelta(days=31), allowed))

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
                                 ['https://news.zacai.fun/', 'https://news.zacai.fun/games/'])
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
