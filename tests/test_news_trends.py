import copy
import gzip
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
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

    def test_provider_cache_before_collection_slot_is_not_a_missed_collection(self):
        cached = self.now - timedelta(minutes=20)
        first = trends.observe(None, self.platform, self.payload(now=cached), self.now)
        later = self.now + timedelta(hours=2)
        second = trends.observe(first, self.platform, self.payload(list(reversed(self.titles)), later - timedelta(minutes=10)), later)
        self.assertEqual(second['items'][0]['previousRank'], 5)

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

    def test_compressed_network_response_and_size_limit(self):
        body = json.dumps(self.payload()).encode()
        def response(data, encoding):
            result = Mock(headers={'Content-Encoding': encoding})
            result.read.return_value = data
            result.__enter__ = Mock(return_value=result)
            result.__exit__ = Mock(return_value=False)
            return result
        for encoding in ('gzip', ''):
            with patch.object(trends.urllib.request, 'urlopen', return_value=response(gzip.compress(body), encoding)):
                self.assertEqual(trends.fetch('https://example.com/data'), body)
        with patch.object(trends.urllib.request, 'urlopen', return_value=response(gzip.compress(b'x' * 2_000_001), 'gzip')):
            with self.assertRaises(ValueError):
                trends.fetch('https://example.com/data')

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

    def publisher_page(self, platform, title=None, **fields):
        if platform == 'thepaper':
            item = {'contId': 12345, 'name': title or self.titles[0],
                    'publishTime': (self.now - timedelta(hours=16)).timestamp() * 1000, 'content': '<p>来源原文</p>', **fields}
            props = {'detailData': {'contentDetail': item}}
        else:
            item = {'id': 12345, 'title': title or self.titles[0],
                    'ctime': (self.now - timedelta(hours=16)).timestamp(), 'content': '<p>来源原文</p>', **fields}
            props = {'articleDetail': item}
        return ('<script id="__NEXT_DATA__" type="application/json">' +
                json.dumps({'props': {'pageProps': props}}) + '</script>').encode()

    def test_direct_publisher_reads_use_the_article_date_and_identity(self):
        for platform, url in (('thepaper', 'https://www.thepaper.cn/newsDetail_forward_12345'),
                              ('cls-hot', 'https://www.cls.cn/detail/12345')):
            topic = {'title': self.titles[0], 'url': url}
            rows = trends.publisher_report(topic, self.publisher_page(platform), self.now)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['url'], url)
            self.assertEqual(rows[0]['publishedAt'], trends.stamp(self.now - timedelta(hours=16)))
            with self.assertRaises(ValueError):
                trends.publisher_report(topic, self.publisher_page(platform, title='毫无关联的体育比赛消息'), self.now)
            with self.assertRaises(ValueError):
                trends.publisher_report(topic, self.publisher_page(platform, contId=98765, id=98765), self.now)
            for hours in (-72, 2):
                timestamp = (self.now + timedelta(hours=hours)).timestamp()
                fields = {'publishTime': timestamp * 1000, 'ctime': timestamp, 'updateTime': self.now.timestamp() * 1000}
                self.assertEqual(trends.publisher_report(topic, self.publisher_page(platform, **fields), self.now), [])
        self.assertEqual(trends.publisher_report({'title': self.titles[0], 'url': 'https://cls.cn.evil.example/detail/12345'}, b'', self.now), [])

    def test_same_hot_topic_collapses_different_ai_groups_and_survives_candidate_limits(self):
        signal = {'platform': 'thepaper', 'name': '澎湃热榜', 'topicId': '1' * 16,
                  'rank': 2, 'asOf': trends.stamp(self.now), 'stale': False}
        first = dict(self.article('梁家辉、高叶分获金鸡奖最佳男、女主角'),
                     trend=[signal], editorial={'eventId': 'event-' + '1' * 24, 'priority': 2})
        duplicate = dict(first, id='second-report', title='高叶和梁家辉分别获得金鸡奖女主角和男主角奖',
                         editorial={'eventId': 'event-' + '2' * 24, 'priority': 2})
        self.assertEqual(len(news.brief_candidates([first, duplicate])), 1)
        next_board = dict(duplicate, trend=[dict(signal, topicId='2' * 16)])
        self.assertEqual(len(news.brief_candidates([first, next_board])), 2)
        # A yesterday report with a live signal must remain in the small packet
        # even if five higher-priority stories push it out of its category.
        old = dict(first, id='yesterday-hot', publishedAt=trends.stamp(self.now - timedelta(hours=16)))
        filler = [dict(old, id='filler-' + str(i), title='不同公共事件' + str(i), trend=[],
                       editorial={'eventId': 'event-' + str(i) * 24, 'priority': 3}) for i in range(6)]
        data = {'updatedAt': trends.stamp(self.now), 'articles': filler + [old]}
        with tempfile.TemporaryDirectory() as folder:
            build_news.build_news_pages(data, Path(folder))
            latest = json.loads((Path(folder) / 'data/latest.json').read_text())
        self.assertIn('yesterday-hot', {a['id'] for a in latest['briefArticles']})
        self.assertLessEqual(len(latest['briefArticles']), 120)

    def test_roundup_does_not_compete_with_individual_hot_events(self):
        digest = self.article('【早报】美股全线下挫；美联储加息押注升温；公司上市有新进展')
        digest['editorial'] = {'priority': 2}
        self.assertEqual(news.brief_rank(digest), 0)
        self.assertEqual(news.brief_rank(self.article('【8点见】电影节公布获奖名单')), 1)
        for title in ('机器人行情助攻，11月第一只翻倍股来了', '某公司创始人质押直接持股'):
            self.assertEqual(trends.category(title), 'finance')

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
        self.assertEqual(sum(url.startswith('https://newsnow.') for url in calls), 4)
        self.assertEqual(sum(url.startswith('https://news.google.') for url in calls), 12)
        self.assertLessEqual(len(calls), 4 + 2 * 12, 'at most one direct read and one search per topic')
        self.assertEqual(incoming, [])
        self.assertEqual(status['status'], 'ok')
        self.assertEqual(len(first['searches']), 12)
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
