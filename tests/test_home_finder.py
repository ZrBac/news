import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect_home_candidates as collector
from homes_api import Application, MAX_BODY, backup, candidate_fits


def empty_book():
    return {'schema': 1, 'revision': 1, 'homes': [], 'profile': {'budgetMin': 300, 'budgetMax': 350,
            'areas': '西湖、上城、西溪', 'priority': 'new', 'driver': 'undecided', 'maxDrive': None, 'maxTransit': None}}


class CandidateTests(unittest.TestCase):
    def test_area_and_room_requirements_match_browser_rules(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/home-requirements.json').read_text())
        for case in cases:
            with self.subTest(case=case['label']):
                self.assertEqual(candidate_fits(case), case['fits'])

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


class NotebookAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.token = 'test-only-' + 'a' * 40
        self.app = Application(self.temp.name, hashlib.sha256(self.token.encode()).hexdigest())

    def tearDown(self):
        self.temp.cleanup()

    def call(self, method='GET', path='/api/homes/notebook', body=None, token=True, origin='https://news.zacai.fun', **extra):
        raw = json.dumps(body).encode() if body is not None else b''
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'HTTP_ORIGIN': origin, 'CONTENT_TYPE': 'application/json',
               'CONTENT_LENGTH': str(len(raw)), 'wsgi.input': io.BytesIO(raw), **extra}
        if token:
            env['HTTP_AUTHORIZATION'] = 'Bearer ' + self.token
        answer = []
        chunks = self.app(env, lambda status, headers: answer.extend([int(status.split()[0]), dict(headers)]))
        return answer[0], json.loads(b''.join(chunks)), answer[1]

    def test_auth_cors_and_public_feed_separation(self):
        self.assertEqual(self.call(token=False)[0], 401)
        self.assertEqual(self.call(origin='https://unrelated.example')[0], 403)
        code, _, headers = self.call('OPTIONS', token=False)
        self.assertEqual(code, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://news.zacai.fun')
        self.assertEqual(self.call(path='/api/homes/candidates', token=False)[0], 503)
        Path(self.temp.name, 'candidates.json').write_text('{"schema":1,"items":[]}')
        self.call('PUT', body={'baseRevision': 0, 'state': empty_book()})
        public = self.call(path='/api/homes/candidates', token=False)
        self.assertEqual(public[0], 200)
        self.assertNotIn('profile', str(public[1]))
        self.assertEqual(self.call()[2]['Cache-Control'], 'no-store')

    def test_stale_device_cannot_overwrite_and_unchanged_reads_are_small(self):
        book = empty_book()
        first = self.call('PUT', body={'baseRevision': 0, 'state': book})
        self.assertEqual(first[0], 200)
        changed = copy.deepcopy(book)
        changed['profile']['areas'] = '另一台设备'
        self.assertEqual(self.call('PUT', body={'baseRevision': 0, 'state': changed})[0], 409)
        self.assertEqual(self.call()[1]['state'], book)
        response = self.call(QUERY_STRING='since=1')[1]
        self.assertTrue(response['unchanged'])
        self.assertNotIn('state', response)

    def test_public_feed_filters_new_observations_without_changing_saved_records(self):
        good = {'id': 'qualified', 'areas': [100, 100], 'layout': '3室2厅'}
        bad = dict(good, id='two-rooms', layout='2室3厅')
        path = Path(self.temp.name, 'candidates.json')
        path.write_text(json.dumps({'schema': 1, 'items': [good, bad]}))
        book = empty_book()
        self.call('PUT', body={'baseRevision': 0, 'state': book})
        self.assertEqual(self.call(path='/api/homes/candidates', token=False)[1]['items'], [good])
        self.assertEqual(len(json.loads(path.read_text())['items']), 2, 'raw source history stays intact')
        self.assertEqual(self.call()[1]['state'], book)
        path.write_text(json.dumps({'schema': 1, 'items': [bad, dict(good, areas=[])]}))
        self.assertEqual(self.call(path='/api/homes/candidates', token=False)[1]['items'], [])

    def test_concurrent_writes_have_one_winner(self):
        def save(_):
            return self.call('PUT', body={'baseRevision': 0, 'state': empty_book()})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(save, range(2))), [200, 409])

    def test_invalid_or_large_uploads_do_not_touch_original(self):
        self.call('PUT', body={'baseRevision': 0, 'state': empty_book()})
        bad = empty_book()
        bad['profile']['maxDrive'] = float('nan')
        self.assertEqual(self.call('PUT', body={'baseRevision': 1, 'state': bad})[0], 400)
        self.assertEqual(self.call('PUT', CONTENT_LENGTH=str(MAX_BODY + 1))[0], 413)
        self.assertEqual(self.call('PUT', body={'baseRevision': True, 'state': empty_book()})[0], 400)
        self.assertEqual(self.call()[1]['revision'], 1)

    def test_backup_is_a_consistent_restorable_database(self):
        self.call('PUT', body={'baseRevision': 0, 'state': empty_book()})
        backup(self.temp.name)
        path = next(Path(self.temp.name, 'backups').glob('*.sqlite3'))
        with sqlite3.connect(path) as connection:
            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(connection.execute('SELECT revision FROM notebook').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
