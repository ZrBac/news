import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ai_editor
import build_news
import collect_news as news
import news_schedule
import news_trends as trends


class TrendTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 11, 5, tzinfo=timezone.utc)
        self.platform = {'id': 'baidu', 'name': '百度热搜', 'domain': 'baidu.com'}
        self.titles = ['杭州地铁新增运营线路正式开放', '全国银行最新利率调整正式公布',
                       '中国新能源汽车出口额公布新数据', '中国足球队公布全新比赛阵容',
                       '国务院发布2027年节假日放假安排']

    def payload(self, titles=None, now=None):
        return {'status': 'success', 'updatedTime': (now or self.now).timestamp() * 1000,
                'items': [{'title': t, 'url': 'https://www.baidu.com/s?wd=' + str(i)}
                          for i, t in enumerate(titles or self.titles)]}

    def article(self, title=None):
        return {'id': 'test-story', 'title': title or self.titles[0], 'url': 'https://news.cctv.com/a',
                'sourceId': 'cctv-news', 'category': 'general', 'publishedAt': trends.stamp(self.now), 'excerpt': ''}

    def test_baseline_rank_changes_and_repeat_cache(self):
        first = trends.observe(None, self.platform, self.payload(), self.now)
        self.assertFalse(any(i['new'] for i in first['items']))
        reordered = [self.titles[4], '全国医保新政策实施细则正式公布'] + self.titles[:3]
        later = self.now + timedelta(hours=2)
        second = trends.observe(first, self.platform, self.payload(reordered, later), later)
        self.assertEqual(second['items'][0]['previousRank'], 5)
        self.assertTrue(second['items'][1]['new'])
        repeated = trends.observe(second, self.platform, self.payload(reordered, later), later + timedelta(minutes=10))
        self.assertEqual(repeated['history'], second['history'])
        self.assertEqual(repeated['items'], second['items'])
        self.assertEqual(first['items'][0]['rank'], 1, 'observation must not mutate previous snapshot')

    def test_failure_backwards_stale_and_recovery_do_not_fabricate_changes(self):
        first = trends.observe(None, self.platform, self.payload(), self.now)
        later = self.now + timedelta(hours=2)
        for bad in (None, {}, {'status': 'success', 'items': []},
                    self.payload(now=self.now - timedelta(hours=1)),
                    self.payload(now=later + timedelta(hours=1)), self.payload(now=later - timedelta(hours=5))):
            failed = trends.observe(first, self.platform, bad, later)
            self.assertEqual(failed['status'], 'unavailable')
            self.assertEqual(failed['observedAt'], first['observedAt'])
            self.assertEqual(failed['items'], first['items'])
        recovered = trends.observe(failed, self.platform, self.payload(list(reversed(self.titles)), later), later)
        self.assertTrue(all(i['previousRank'] is None and not i['new'] for i in recovered['items']))
        missed = trends.observe(first, self.platform, self.payload(now=later + timedelta(hours=4)), later + timedelta(hours=4))
        self.assertTrue(all(i['previousRank'] is None for i in missed['items']))

    def test_normal_night_pause_compares_and_history_is_bounded(self):
        night = self.now.replace(hour=13)  # Beijing 21:00
        morning = night + timedelta(hours=12)
        first = trends.observe(None, self.platform, self.payload(now=night), night)
        first['history']['expired'] = {'lastSeen': trends.stamp(night - timedelta(days=8))}
        second = trends.observe(first, self.platform, self.payload(now=morning), morning)
        self.assertEqual(second['items'][0]['previousRank'], 1)
        self.assertNotIn('expired', second['history'])
        for i in range(400):
            second['history']['old-' + str(i)] = dict(next(iter(second['history'].values())))
        third = trends.observe(second, self.platform, self.payload(now=morning + timedelta(hours=2)), morning + timedelta(hours=2))
        self.assertLessEqual(len(third['history']), 300)

    def test_untrusted_urls_and_malformed_payloads(self):
        for link in ('https://baidu.com.evil.example/a', 'https://baidu.com@evil.example/a',
                     'http://baidu.com/a', 'javascript:alert(1)', 'https://baidu.com:3000/a'):
            payload = self.payload()
            for item in payload['items']:
                item['url'] = link
            with self.assertRaises(ValueError):
                trends.parse_board(payload, self.platform, self.now)
        payload = self.payload()
        payload['items'][0]['url'] = 'javascript:alert(1)'
        _, items = trends.parse_board(payload, self.platform, self.now)
        self.assertEqual(items[0]['rank'], 2, 'invalid entries must not shift measured ranks')
        payload['updatedTime'] = True
        with self.assertRaises(ValueError):
            trends.parse_board(payload, self.platform, self.now)

    def test_matching_does_not_confuse_other_years_or_generic_keywords(self):
        topic = {'title': self.titles[4], 'url': 'https://www.baidu.com/s?q=holiday'}
        self.assertTrue(trends.matches(topic, self.article(self.titles[4] + '，请查收 - 央视网')))
        self.assertFalse(trends.matches(topic, self.article(self.titles[4].replace('2027', '2028'))))
        self.assertFalse(trends.matches({'title': 'AI模型', 'url': topic['url']}, self.article('最新AI模型正式发布')))
        self.assertFalse(trends.matches(topic, self.article('国务院公布2027年全国银行监管新要求')))

    def rss(self, title=None, published='Wed, 11 Nov 2026 04:00:00 GMT', publisher='https://news.cctv.com'):
        return ('<rss><channel><item><title>' + escape(title or self.titles[0]) + '</title>'
                '<link>https://news.cctv.com/a</link><pubDate>' + published + '</pubDate>'
                '<source url="' + publisher + '">央视网</source></item></channel></rss>').encode()

    def test_discovery_requires_publisher_date_and_topic_match(self):
        topic = {'title': self.titles[0], 'url': 'https://www.baidu.com/s?a=1'}
        reports = trends.search_reports(topic, self.rss(), self.now)
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]['publishedAt'], '2026-11-11T04:00:00Z')
        self.assertNotEqual(reports[0]['publishedAt'], trends.stamp(self.now))
        for body in (self.rss(published=''), self.rss(published='Fri, 06 Nov 2026 04:00:00 GMT'),
                     self.rss(published='Fri, 13 Nov 2026 04:00:00 GMT'),
                     self.rss(publisher='https://news.cctv.com.evil.example'), self.rss(title='毫不相关的文娱新闻')):
            self.assertEqual(trends.search_reports(topic, body, self.now), [])
        allowed = {trends.SOURCE['id']: trends.SOURCE}
        self.assertEqual(news.merge_articles(reports, [], self.now, allowed)[0]['category'], reports[0]['category'])

    def test_queries_bounded_cached_and_failures_keep_previous(self):
        calls = []
        domains = {'baidu': 'baidu.com', 'weibo': 'weibo.com', 'thepaper': 'thepaper.cn', 'cls-hot': 'cls.cn'}
        def get(url):
            calls.append(url)
            if url.startswith('https://newsnow.'):
                platform = parse_qs(urlsplit(url).query)['id'][0]
                payload = self.payload()
                for item in payload['items']:
                    item['url'] = item['url'].replace('baidu.com', domains[platform])
                    item['title'] = platform + '独有热点话题' + item['title']
                return json.dumps(payload).encode()
            return b'<rss><channel/></rss>'
        first, incoming, status = trends.collect(None, [], self.now, get)
        self.assertEqual(len(calls), 10)
        self.assertEqual(incoming, [])
        self.assertEqual(status['status'], 'ok')
        self.assertEqual(len(first['searches']), 6)
        queried = set(calls[4:])  # Parallel result order is immaterial below.
        calls.clear()
        second, _, _ = trends.collect(first, [], self.now + timedelta(minutes=5), get)
        self.assertTrue(queried.isdisjoint(calls), 'cached empty searches should not repeat')
        def fail(url):
            raise OSError('unavailable')
        failed, incoming, status = trends.collect(second, [], self.now + timedelta(hours=2), fail)
        self.assertEqual(status['status'], 'unavailable')
        self.assertEqual(failed['platforms']['baidu']['items'], first['platforms']['baidu']['items'])
        self.assertEqual(incoming, [])
        # News-only skip publications preserve state without issuing requests.
        carried = news_schedule.reuse({'trendState': first, 'updatedAt': trends.stamp(self.now)}, self.now)
        self.assertEqual(carried['trendState'], first)

    def test_compact_build_scoring_staleness_and_ai_cache_identity(self):
        board = trends.observe(None, self.platform, self.payload(), self.now)
        state = {'schema': 1, 'platforms': {'baidu': board}}
        story = self.article()
        marked, public = trends.annotate([story], state, self.now)
        self.assertGreater(trends.score(marked[0]), 0)
        self.assertEqual(ai_editor.article_hash(marked[0]), ai_editor.article_hash(story))
        stale, _ = trends.annotate(marked, state, self.now + timedelta(hours=5))
        self.assertTrue(stale[0]['trend'][0]['stale'])
        self.assertEqual(trends.score(stale[0]), 0)
        expired, _ = trends.annotate(marked, state, self.now + timedelta(hours=25))
        self.assertNotIn('trend', expired[0])
        ordinary = dict(story, id='ordinary', title='普通社区更新通知', publishedAt=trends.stamp(self.now + timedelta(minutes=1)))
        major = dict(story, id='major', title='重大公共消息', editorial={'priority': 3})
        selected = news.brief_candidates([ordinary, marked[0], major])
        self.assertEqual([a['id'] for a in selected], ['major', 'test-story', 'ordinary'])
        data = {'updatedAt': trends.stamp(self.now), 'articles': [story], 'trendState': state}
        with tempfile.TemporaryDirectory() as folder:
            build_news.build_news_pages(data, Path(folder))
            latest = json.loads((Path(folder) / 'data/latest.json').read_text())
        self.assertNotIn('trendState', latest)
        self.assertIn('trend', latest['briefArticles'][0])
        self.assertEqual(latest['trends'], public)
        self.assertNotIn('trend', data['articles'][0], 'building should not mutate the full export')


if __name__ == '__main__':
    unittest.main()
