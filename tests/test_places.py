import copy
import json
import sys
import unittest
from datetime import timedelta
from functools import partial
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import collect_places as places
import build_news


class PlaceUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.now = places.news.parse_date('2026-10-30T08:00:00Z')
        self.place = {'id': 'baoshi', 'group': 'hiking', 'aliases': ['宝石山']}
        self.item = {'title': '杭州宝石山登山步道维修通知 - 杭州网',
                     'url': 'https://hznews.hangzhou.com.cn/notice', 'publisher': '杭州网',
                     'publishedAt': '2026-10-29T00:00:00Z'}
        self.resolve = lambda *args, **kwargs: None
        self.refresh = partial(places.refresh, get_page=lambda _: '')

    def feed(self, item=None, publisher='https://www.hangzhou.com.cn'):
        item = item or self.item
        return f'''<rss><channel><item><title>{item['title']}</title><link>{item['url']}</link>
          <pubDate>{item['publishedAt']}</pubDate><source url="{publisher}">杭州网</source>
          </item></channel></rss>'''.encode()

    def test_only_dated_trusted_publisher_entries_are_accepted(self):
        self.assertEqual(len(places.parse_feed(self.feed(), self.now)), 1)
        for publisher in ('https://hangzhou.com.cn.fake.example', 'https://spam.example', 'javascript:bad'):
            self.assertEqual(places.parse_feed(self.feed(publisher=publisher), self.now), [])
        for stamp in ('2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 'invalid'):
            self.assertEqual(places.parse_feed(self.feed({**self.item, 'publishedAt': stamp}), self.now), [])
        with self.assertRaises(ValueError):
            places.parse_feed(b'<html>Temporarily unavailable</html>', self.now)

    def test_matching_excludes_noise_and_unrelated_routes(self):
        cycling = {'id': 'liangzhu', 'group': 'cycling', 'aliases': ['良渚']}
        for title, wanted in [('良渚绿道临时封闭', True), ('良渚电动自行车整治', False),
                              ('良渚自行车骑行节圆满举办', False), ('湘湖绿道骑行', False),
                              ('良渚楼盘开盘，邻近骑行绿道', False)]:
            self.assertEqual(places.matches(cycling, {**self.item, 'title': title}, self.now), wanted)
        self.assertFalse(places.matches(self.place, {**self.item, 'url': 'javascript:alert(1)'}, self.now))

    def test_daily_slots_and_hourly_new_reports_do_not_change_search_time(self):
        calls = []
        def fetch(url):
            calls.append(url)
            return self.feed()
        first = self.refresh([self.place], {}, [], self.now, fetch, self.resolve)
        query = parse_qs(urlsplit(calls[0]).query)['q'][0]
        self.assertIn('"宝石山"', query)
        self.assertIn('when:30d', query)
        self.assertEqual(len(first['places']['baoshi']['items']), 1)
        newer = {**self.item, 'title': '宝石山登山步道恢复开放', 'url': 'https://hznews.hangzhou.com.cn/reopen', 'publishedAt': '2026-10-30T08:30:00Z'}
        next_run = self.refresh([self.place], first, [newer], self.now + timedelta(hours=1), fetch, self.resolve)
        self.assertEqual(len(calls), 1)
        record = next_run['places']['baoshi']
        self.assertEqual(record['items'][0]['url'], newer['url'])
        self.assertEqual(record['searchedAt'], first['places']['baoshi']['searchedAt'])
        self.refresh([self.place], next_run, [], self.now + timedelta(hours=17), fetch, self.resolve)
        self.assertEqual(len(calls), 2)  # next day's 09:00 Beijing slot

    def test_failures_retain_reports_and_last_success_then_retry(self):
        initial = self.refresh([self.place], {}, [], self.now, lambda _: self.feed(), self.resolve)
        old = copy.deepcopy(initial)
        def fail(_):
            raise TimeoutError()
        failed = self.refresh([self.place], initial, [], self.now + timedelta(days=1), fail, self.resolve)
        self.assertEqual(initial, old)
        record = failed['places']['baoshi']
        self.assertEqual(record['status'], 'unavailable')
        self.assertEqual(record['items'], old['places']['baoshi']['items'])
        self.assertEqual(record['searchedAt'], old['places']['baoshi']['searchedAt'])
        retried = self.refresh([self.place], failed, [], self.now + timedelta(days=1, hours=1), lambda _: b'<rss><channel/></rss>', self.resolve)
        self.assertEqual(retried['places']['baoshi']['status'], 'ok')
        self.assertEqual(len(retried['places']['baoshi']['items']), 1)
        expired = self.refresh([self.place], failed, [], self.now + timedelta(days=31), fail, self.resolve)
        self.assertEqual(expired['places']['baoshi']['items'], [])

    def test_partial_batch_failures_only_retry_failed_places(self):
        catalog = [{**self.place, 'id': str(i), 'aliases': ['山' + str(i)]} for i in range(5)]
        def fetch(url):
            if '山4' in parse_qs(urlsplit(url).query)['q'][0]:
                raise TimeoutError()
            return b'<rss><channel/></rss>'
        initial = self.refresh(catalog, {}, [], self.now, fetch, self.resolve)
        self.assertEqual(initial['places']['0']['status'], 'ok')
        self.assertEqual(initial['places']['4']['status'], 'unavailable')
        calls = []
        def retry(url):
            calls.append(parse_qs(urlsplit(url).query)['q'][0])
            return b'<rss><channel/></rss>'
        self.refresh(catalog, initial, [], self.now + timedelta(hours=1), retry, self.resolve)
        self.assertEqual(len(calls), 1)
        self.assertIn('山4', calls[0])
        self.assertNotIn('山0', calls[0])

    def test_duplicates_and_alias_changes(self):
        duplicate = {**self.item, 'title': self.item['title'].replace('杭州网', '其他转载')}
        self.assertEqual(len(places.select(self.place, [self.item, duplicate], self.now)), 1)
        first = self.refresh([self.place], {}, [], self.now, lambda _: self.feed(), self.resolve)
        changed = {**self.place, 'aliases': ['保俶塔']}
        calls = []
        def fetch(url):
            calls.append(url)
            return b'<rss><channel/></rss>'
        second = self.refresh([changed], first, [], self.now + timedelta(minutes=1), fetch, self.resolve)
        self.assertEqual(len(calls), 1)
        self.assertEqual(second['places']['baoshi']['items'], [])

    def test_roundup_requires_nearby_body_evidence_and_keeps_publication_date(self):
        article = {**self.item, 'title': '杭州周末登山路线推荐'}
        self.assertFalse(places.matches(self.place, article, self.now))
        places.enrich([self.place], [article], [], self.now,
                      lambda _: '宝石山登山步道近期开放，沿台阶游览。\n另外一篇介绍露营活动。')
        self.assertTrue(places.matches(self.place, article, self.now))
        selected = places.select(self.place, [article], self.now)
        self.assertEqual(selected[0]['publishedAt'], self.item['publishedAt'])
        self.assertEqual(selected[0]['placeEvidence']['baoshi']['checkedAt'], places.news.iso(self.now))
        unrelated = {**self.item, 'title': '杭州周末登山路线推荐'}
        places.enrich([self.place], [unrelated], [], self.now,
                      lambda _: '本段介绍宝石山。\n' + '其他内容' * 100 + '\n另一地的登山步道已开放。')
        self.assertFalse(places.matches(self.place, unrelated, self.now))

    def test_catalog_build_preserves_maps_sources_and_offline_text(self):
        catalog = json.loads((places.ROOT / 'news/places.json').read_text())['places']
        self.assertEqual(len({p['id'] for p in catalog}), len(catalog))
        for place in catalog:
            self.assertTrue(any(link['url'].startswith('https://uri.amap.com/') for link in place['links']), place['name'])
            self.assertTrue(any(link['url'].startswith('https://') and 'amap.com' not in link['url'] for link in place['links']), place['name'])
        template = (places.ROOT / 'news/index.html').read_text()
        rendered = build_news.build_places(template)
        self.assertNotIn('_PLACES__', rendered)
        self.assertEqual(rendered.count('data-place-id='), 38)
        self.assertIn('骑行路线', rendered)
        self.assertIn('卡式炉', rendered)
        self.assertIn('data-place-id="cycle-xianghu"', rendered)


if __name__ == '__main__':
    unittest.main()
