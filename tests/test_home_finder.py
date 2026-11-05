import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect_home_candidates as collector


class CandidateTests(unittest.TestCase):
    def test_pages_schedule_checks_at_nine_and_sixteen_beijing(self):
        previous = {'scheduleRevision': collector.REVISION, 'updatedAt': '2026-11-02T01:01:00Z', 'sources': [{'ok': True}]}
        def due(stamp):
            return collector.refresh_due(previous, dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')))
        self.assertFalse(due('2026-11-02T07:59:00Z'))
        self.assertTrue(due('2026-11-02T08:00:00Z'))
        previous['updatedAt'] = '2026-11-02T08:01:00Z'
        self.assertFalse(due('2026-11-03T00:59:00Z'))
        self.assertTrue(due('2026-11-03T01:00:00Z'))
        previous['sources'] = [{'ok': False}]
        self.assertFalse(due('2026-11-02T08:59:00Z'))
        self.assertTrue(due('2026-11-02T09:01:00Z'))

    def test_public_snapshot_never_publishes_notebook_fields(self):
        value = json.loads((Path(__file__).resolve().parents[1] / 'news/home-candidates.json').read_text())
        value.update(homes=['private'], profile={'private': True}, token='private', notebook='private')
        value['items'][0].update(notes='private', photos=['private'], visits=['private'])
        value['sources'][0]['token'] = 'private'
        public = collector.public_snapshot(value)
        self.assertNotIn('private', json.dumps(public))
        self.assertTrue(all(collector.candidate_fits(item) for item in public['items']))
        self.assertEqual(public['updatedAt'], value['updatedAt'])
        with self.assertRaises(ValueError):
            collector.public_snapshot({'schema': 1, 'homes': []})

    def test_previous_snapshot_chooses_newest_and_does_not_call_private_server(self):
        seed = Path(__file__).resolve().parents[1] / 'news/home-candidates.json'
        value = json.loads(seed.read_text())
        value['updatedAt'] = '2026-11-03T01:01:00Z'
        with tempfile.TemporaryDirectory() as folder:
            saved = Path(folder) / 'saved.json'
            collector.write_atomic(saved, value)
            with patch.object(collector.urllib.request, 'urlopen', side_effect=TimeoutError()):
                actual = collector.read_previous(saved, 'https://news.zacai.fun/data/home-candidates.json', seed)
            self.assertEqual(actual['updatedAt'], value['updatedAt'])
            with self.assertRaises(ValueError):
                collector.read_previous(saved, 'https://zacai.fun/api/homes/notebook', seed)

    def test_failed_pages_refresh_retains_observations_and_marks_failed_sources(self):
        seed = json.loads((Path(__file__).resolve().parents[1] / 'news/home-candidates.json').read_text())
        def unavailable(url):
            raise TimeoutError()
        result = collector.public_snapshot(collector.collect(seed, unavailable))
        old = {item['id']: item for item in seed['items']}
        self.assertGreater(len(result['items']), 0)
        for item in result['items']:
            self.assertEqual(item['checkedAt'], old[item['id']]['checkedAt'])
            self.assertEqual(item['history'], old[item['id']]['history'])
            self.assertTrue(item.get('stale'))
        self.assertFalse(any(s['ok'] for s in result['sources']))

    def test_area_and_room_requirements_match_browser_rules(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/home-requirements.json').read_text())
        for case in cases:
            with self.subTest(case=case['label']):
                self.assertEqual(collector.candidate_fits(case), case['fits'])

    def new_page(self, unit='per平方米', value=28000, tags='普通住宅', status='在售'):
        data = {'@type': 'ItemList', 'itemListElement': [{'item': {'name': '测试住宅', 'description': '西湖 三墩 三居 100-120㎡',
                'url': 'https://hz.newhouse.fang.com/loupan/20101.htm', 'offers': {'price': value, 'unitText': unit}}}]}
        return '<title>杭州西湖楼盘</title><script type="application/ld+json">' + json.dumps(data) + '</script>' + \
            f'<li id="lp_20101"><div class="fangyuan"><span>{status}</span><a>{tags}</a></div><div class="house_type">100-120㎡</div></li>'

    def test_unit_prices_are_not_total_prices(self):
        config = collector.sources()[0]
        item = collector.parse_new(self.new_page(), config)[0]
        self.assertEqual(item['unitPrice'], 28000)
        self.assertIsNone(item['total'])
        self.assertEqual(item['areas'], [100, 120])
        total = collector.parse_new(self.new_page('per套', 3200000), config)[0]
        self.assertEqual(total['total'], 320)
        self.assertIsNone(total['unitPrice'])
        unknown = collector.parse_new(self.new_page('unknown'), config)[0]
        self.assertIsNone(unknown['total'])
        self.assertIsNone(unknown['unitPrice'])

    def test_commercial_and_city_checks(self):
        config = collector.sources()[0]
        self.assertEqual(collector.parse_new(self.new_page(tags='酒店式公寓'), config), [])
        self.assertTrue(collector.parse_new(self.new_page(tags='普通住宅 酒店式公寓'), config)[0]['mixedUse'])
        with self.assertRaises(ValueError):
            collector.parse_new(self.new_page().replace('杭州西湖楼盘', '上海楼盘'), config)
        self.assertEqual(collector.parse_new(self.new_page(status='售罄'), config)[0]['status'], '售罄')

    def test_resale_search_does_not_adopt_recommendations_or_rent(self):
        config = collector.sources()[3]
        def row(path, title, price):
            return f'<li><a href="{path}"><div class="img"><p></p></div><div class="txt"><h3>{title}</h3><p>121.8㎡ 4室2厅</p><div class="price"><em>{price}</em>万</div></div></a></li>'
        body = '<title>杭州房产搜索</title><section id="wapquanwangso_A03_03">' + \
            row('/esf/hz/3_123.html', '万科西雅图四室', 350) + row('/esf/hz/3_124.html', '其他小区', 250) + \
            row('/esf/sh/3_125.html', '西雅图', 320) + '</section><section id="wapquanwangso_A03_04">' + \
            row('/esf/hz/3_126.html', '西雅图出租', 4000) + '</section>'
        found = collector.parse_resale(body, config)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['total'], 350)
        self.assertEqual(found[0]['areas'], [121.8, 121.8])

    def test_history_only_records_changes_and_preserves_first_observation(self):
        item = {'id': 'one', 'total': 350, 'unitPrice': None, 'status': '平台挂牌'}
        first = collector.observe(item, {}, '2026-10-25T01:00:00+00:00')
        same = collector.observe(item, first, '2026-10-26T01:00:00+00:00')
        self.assertEqual(same['history'], [])
        changed = collector.observe(dict(item, total=340), same, '2026-10-26T08:00:00+00:00')
        self.assertEqual(changed['history'][0]['changes']['total'], {'from': 350, 'to': 340})
        self.assertEqual(first['firstSeen'], changed['firstSeen'])

    def test_source_failure_retains_last_good_data_and_timestamp(self):
        config = collector.sources()[0]
        item = collector.observe(collector.parse_new(self.new_page(), config)[0], {}, '2026-10-25T01:00:00+00:00')
        previous = {'items': [item], 'sources': [{'id': config['id'], 'checkedAt': item['checkedAt']}]}
        def unavailable(url):
            raise TimeoutError()
        result = collector.collect(previous, unavailable)
        self.assertEqual(result['items'][0]['checkedAt'], item['checkedAt'])
        self.assertTrue(result['items'][0]['stale'])
        self.assertFalse(result['sources'][0]['ok'])

    def resale_list(self):
        fields = {'district': '151', 'comarea': '2349', 'price': '300^350', 'purpose': '住宅',
                  'tags': '3', 'pageType': 'esfindex2022', 'total': '1'}
        inputs = ''.join(f'<input data-id="{k}" value="{v}">' for k, v in fields.items())
        card = '<li class="listhouse"><a class="listtype" href="//m.fang.com/esf/hz/3_123.html">' \
               '<div class="img"><p></p></div><div class="txt"><h3>精装三房</h3><p>' \
               '<span>89.52㎡</span><span>3室2厅</span><span>南</span><span>紫金名门</span></p>' \
               '<div class="price"><span><em>330</em>万</span><span>36863元/㎡</span></div></div></a></li>'
        return '<title>杭州三墩二手房</title>' + inputs + '<ul id="content">' + card + '</ul>' + \
               '<ul id="recommend">' + card.replace('3_123', '3_456') + '</ul>'

    def test_resale_list_requires_the_requested_city_region_price_and_residential_filters(self):
        config = next(x for x in collector.sources() if x['id'] == 'resale-area-sandun')
        body = self.resale_list()
        rows = collector.parse_resale_list(body, config)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['name'], rows[0]['total'], rows[0]['areas']), ('紫金名门', 330, [89.52, 89.52]))
        for before, after in [('杭州', '上海'), ('value="2349"', 'value="2918"'), ('300^350', ''),
                              ('value="住宅"', 'value="商铺"'), ('value="3"', 'value=""')]:
            with self.subTest(before=before), self.assertRaises(ValueError):
                collector.parse_resale_list(body.replace(before, after), config)
        for before, after in [('/esf/hz/', '/zf/hz/'), ('<em>330</em>', '<em>360</em>')]:
            self.assertEqual(collector.parse_resale_list(body.replace(before, after), config), [])

    def test_pagination_deduplicates_moved_items_and_stays_on_the_district_list(self):
        config = collector.sources()[0]
        next_url = config['url'] + 'b92/'
        calls = []
        first = collector.observe(collector.parse_new(self.new_page(), config)[0], {}, '2026-10-25T01:00:00+00:00')
        def loader(url):
            calls.append(url)
            if url == config['url']:
                return self.new_page() + '<a href="' + next_url + '">下一页</a>'
            return self.new_page() + '<a href="https://unrelated.example/b93/">下一页</a>'
        with patch.object(collector, 'sources', return_value=[config]):
            result = collector.collect({'items': [first]}, loader)
        self.assertEqual(calls, [config['url'], next_url])
        self.assertEqual(len(result['items']), 1)
        self.assertNotIn('missing', result['items'][0])
        self.assertEqual(result['items'][0]['firstSeen'], first['firstSeen'])

    def test_partial_page_failure_keeps_its_old_rows_without_refreshing_their_dates(self):
        config = collector.sources()[0]
        next_url = config['url'] + 'b92/'
        old = collector.observe(collector.parse_new(self.new_page(), config)[0], {}, '2026-10-25T01:00:00+00:00')
        second = dict(old, id='new-20102', sourcePage=next_url)
        moved = dict(old, id='new-20103', sourcePage=config['url'])
        def loader(url):
            if url == next_url:
                raise TimeoutError()
            return self.new_page(value=29000) + '<a href="' + next_url + '">下一页</a>'
        with patch.object(collector, 'sources', return_value=[config]):
            result = collector.collect({'items': [old, second, moved]}, loader)
        rows = {x['id']: x for x in result['items']}
        self.assertFalse(result['sources'][0]['ok'])
        self.assertTrue(result['sources'][0]['partial'])
        self.assertEqual(rows[old['id']]['unitPrice'], 29000)
        self.assertTrue(rows[second['id']]['stale'])
        self.assertNotIn('missing', rows[second['id']])
        self.assertEqual(rows[second['id']]['checkedAt'], second['checkedAt'])
        self.assertTrue(rows[moved['id']]['stale'])
        self.assertNotIn('missing', rows[moved['id']], 'the row could have moved onto the unread page')

    def test_fresh_result_wins_over_absence_in_an_overlapping_source(self):
        config = collector.sources()[0]
        other = dict(config, id='new-overlap', url='https://hz.newhouse.fang.com/house/s/xihu/another/')
        old = collector.observe(collector.parse_new(self.new_page(), other)[0], {}, '2026-10-25T01:00:00+00:00')
        def loader(url):
            return self.new_page(tags='酒店式公寓') if url == other['url'] else self.new_page()
        with patch.object(collector, 'sources', return_value=[config, other]):
            result = collector.collect({'items': [old]}, loader)
        self.assertEqual(len(result['items']), 1)
        self.assertNotIn('missing', result['items'][0])
        self.assertNotIn('stale', result['items'][0])

    def test_network_retry_is_bounded_and_does_not_retry_access_denials(self):
        with patch.object(collector.urllib.request, 'urlopen', side_effect=TimeoutError()) as request:
            with self.assertRaises(TimeoutError):
                collector.fetch('https://example.com/')
            self.assertEqual(request.call_count, 2)
        denial = collector.urllib.error.HTTPError('https://example.com/', 403, 'Forbidden', {}, None)
        with patch.object(collector.urllib.request, 'urlopen', side_effect=denial) as request:
            with self.assertRaises(collector.urllib.error.HTTPError):
                collector.fetch('https://example.com/')
            self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
