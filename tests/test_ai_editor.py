import copy
import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ai_editor as ai


class EditorialTests(unittest.TestCase):
    def setUp(self):
        self.now = ai.news.parse_date('2026-11-02T08:00:00Z')
        self.config = json.loads((ai.ROOT / 'news/editorial.json').read_text())
        self.a = {'id': 'a', 'title': '杭州发布本周消费券申领安排', 'excerpt': '消费券从11月3日开始申领。',
                  'category': 'livelihood', 'sourceId': 'example', 'url': 'https://example.com/a',
                  'publishedAt': '2026-11-02T07:00:00Z'}
        self.b = {**self.a, 'id': 'b', 'title': '11月3日起申领杭州消费券', 'url': 'https://example.com/b'}
        self.group = {'ids': ['a', 'b'], 'summary': '杭州本周消费券将从11月3日开始申领。',
                      'evidence': [{'id': 'a', 'quote': self.a['title']}, {'id': 'b', 'quote': self.b['title']}]}
        self.item = {'title': '杭州宝石山步道本周临时封闭', 'url': 'https://hznews.hangzhou.com.cn/notice',
                     'publisher': '杭州网', 'publishedDate': '2026-11-01', 'publishedEvidence': '2026年11月1日',
                     'type': 'outdoor', 'quote': '杭州宝石山步道本周临时封闭，施工期间请绕行。', 'placeIds': ['baoshi'],
                     'facts': [{'kind': 'closure', 'quote': '施工期间请绕行'}]}
        self.body = '2026年11月1日\n杭州宝石山步道本周临时封闭，施工期间请绕行。'
        self.places = [{'id': 'baoshi', 'aliases': ['宝石山']}]

    def response(self, result, **extra):
        return {'status': 'completed', 'usage': {'input_tokens': 100, 'output_tokens': 100},
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}], **extra}

    def test_budget_blocks_before_request_and_failed_request_keeps_reservation(self):
        with tempfile.TemporaryDirectory() as folder:
            path, state, requests = Path(folder) / 'state.json', {}, []
            def fail(payload):
                requests.append(payload)
                raise TimeoutError()
            client = ai.Client('secret-for-test', self.config, state, path, self.now, fail)
            with self.assertRaises(TimeoutError):
                client.ask('test', 'test', {}, ai.NEWS_SCHEMA)
            reserved = json.loads(path.read_text())['usage']['estimatedUsd']
            self.assertGreater(reserved, 0)
            self.assertNotIn('secret-for-test', path.read_text())
            state['usage']['estimatedUsd'] = 50
            with self.assertRaises(ai.BudgetStop):
                client.ask('test', 'test', {}, ai.NEWS_SCHEMA)
            self.assertEqual(len(requests), 1)

    def test_metering_reconciles_and_month_changes_reset_only_usage(self):
        with tempfile.TemporaryDirectory() as folder:
            path, state = Path(folder) / 'state.json', {'research': {'items': []}}
            client = ai.Client('x', self.config, state, path, self.now, lambda _: self.response({'groups': []}))
            client.ask('test', 'test', {}, ai.NEWS_SCHEMA)
            self.assertAlmostEqual(state['usage']['estimatedUsd'], 0.000075)
            state['usage']['estimatedUsd'] = 50
            ai.Client('x', self.config, state, path, self.now + timedelta(days=30))
            self.assertEqual(state['usage']['estimatedUsd'], 0)
            self.assertIn('research', state)

    def test_bad_ledger_and_unknown_model_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            for value in (-1, float('nan'), '0'):
                with self.assertRaises(ai.EditorialError):
                    ai.Client('x', self.config, {'usage': {'month': '2026-11', 'estimatedUsd': value}}, path, self.now)
            client = ai.Client('x', {**self.config, 'newsModel': 'unknown'}, {}, path, self.now)
            with self.assertRaises(ai.EditorialError):
                client.ask('test', 'test', {}, ai.NEWS_SCHEMA)

    def test_news_groups_require_every_id_and_literal_evidence(self):
        records = ai.validate_groups({'groups': [self.group]}, [self.a, self.b], {}, self.now)
        self.assertEqual(records['a']['eventId'], records['b']['eventId'])
        for change in ({'ids': ['a', 'invented']}, {'ids': ['a', 'a']}, {'evidence': []},
                       {'evidence': [{'id': 'a', 'quote': '未经来源支持的虚构事实'}]}):
            with self.subTest(change=change):
                self.assertEqual(ai.validate_groups({'groups': [{**self.group, **change}]}, [self.a, self.b], {}, self.now), {})
        old = {**self.b, 'publishedAt': '2026-10-29T00:00:00Z'}
        self.assertEqual(ai.validate_groups({'groups': [self.group]}, [self.a, old], {}, self.now), {})

    def test_unchanged_news_does_not_make_another_call(self):
        with tempfile.TemporaryDirectory() as folder:
            calls, state = [], {}
            def transport(payload):
                calls.append(payload)
                return self.response({'groups': [self.group]})
            client = ai.Client('x', self.config, state, Path(folder) / 'state.json', self.now, transport)
            data = {'articles': [self.a, self.b]}
            first = ai.edit_news(client, data, state, self.now)
            self.assertEqual(ai.edit_news(client, data, state, self.now), first)
            self.assertEqual(len(calls), 1)

    def test_modified_input_does_not_keep_old_summary_or_remove_source_articles(self):
        records = ai.validate_groups({'groups': [self.group]}, [self.a, self.b], {}, self.now)
        data = {'articles': [{**self.a, 'excerpt': '来源修订了申领日期。'}, self.b.copy()]}
        ai.apply_results(data, {}, records, self.now)
        self.assertEqual(len(data['articles']), 2)
        self.assertNotIn('editorial', data['articles'][0])
        self.assertIn('editorial', data['articles'][1])

    def test_discovery_needs_actual_source_date_citation_and_quotation(self):
        urls = {self.item['url']}
        accepted = ai.validate_discovery(self.item, urls, self.body, self.places, self.now)
        self.assertEqual(accepted['placeIds'], ['baoshi'])
        self.assertTrue(accepted['outing']['cancelled'])
        self.assertEqual(accepted['publishedAt'], '2026-10-31T16:00:00Z')
        self.assertIsNone(ai.validate_discovery(self.item, set(), self.body, self.places, self.now))
        self.assertIsNone(ai.validate_discovery(self.item, urls, '无可验证正文', self.places, self.now))
        for change in ({'publishedDate': '2026-12-01'}, {'publishedDate': '2025-11-01'},
                       {'quote': '杭州某营地允许使用明火，停车完全免费'}, {'title': '杭州博物馆新展览'}):
            self.assertIsNone(ai.validate_discovery({**self.item, **change}, urls, self.body, self.places, self.now))

    def test_negative_stove_conditions_are_quoted_without_reversing_them(self):
        item = {**self.item, 'facts': [{'kind': 'stove', 'quote': '营地禁止使用自带卡式炉'},
                                     {'kind': 'parking', 'quote': '车可以开到每个营位旁'}]}
        body = self.body + '\n营地禁止使用自带卡式炉。'
        record = ai.validate_discovery(item, {item['url']}, body, self.places, self.now)
        self.assertEqual(record['facts'], [{'kind': 'stove', 'text': '营地禁止使用自带卡式炉'}])

    def test_roundup_does_not_attach_an_unrelated_place_to_excerpt(self):
        item = {**self.item, 'placeIds': ['anyu']}
        body = self.body + '\n另一篇推荐：建德安屿营地。'
        result = ai.validate_discovery(item, {item['url']}, body, [{'id': 'anyu', 'aliases': ['安屿']}], self.now)
        self.assertEqual(result['placeIds'], [])

    def test_untrusted_urls_and_redirects_rejected(self):
        for url in ('https://127.0.0.1/a', 'http://hangzhou.com.cn/a',
                    'https://hangzhou.com.cn.evil.example/a', 'https://a@hangzhou.com.cn/a',
                    'https://hznews.hangzhou.com.cn:5000/a', 'javascript:alert(1)'):
            self.assertFalse(ai.trusted_url(url))
        with self.assertRaises(ai.EditorialError):
            ai.PublicRedirect().redirect_request(None, None, 302, '', {}, 'http://127.0.0.1/admin')

    def test_closed_places_still_show_their_notice_but_no_activity(self):
        record = ai.validate_discovery(self.item, {self.item['url']}, self.body, self.places, self.now)
        editorial = {'research': {'items': [record], 'searchedAt': ai.news.iso(self.now), 'status': 'ok'}}
        data = {'articles': [], 'weekendArticles': []}
        ai.apply_results(data, editorial, {}, self.now)
        self.assertEqual(data['weekendArticles'], [])
        self.assertEqual(data['placeUpdates']['places']['baoshi']['items'][0]['title'], record['title'])

    def test_rain_wind_closures_and_wrong_dates_exclude_outdoor_recommendations(self):
        row = {'date': '2026-11-07', 'code': 2, 'low': 10, 'high': 18, 'rainProbability': 10, 'rainMm': 0, 'windKmh': 8}
        weather = {'regions': {'hangzhou': {'days': [row]}}}
        candidate = {'region': 'hangzhou', 'name': '宝石山', 'type': 'hiking'}
        self.assertTrue(ai.suitable(candidate, '2026-11-07', weather))
        self.assertFalse(ai.suitable(candidate, '2026-11-08', weather))
        self.assertFalse(ai.suitable({**candidate, 'closed': True}, '2026-11-07', weather))
        self.assertFalse(ai.suitable({**candidate, 'start': '2026-11-08', 'end': '2026-11-08'}, '2026-11-07', weather))
        for field, value in [('rainProbability', 70), ('rainMm', 4), ('code', 95), ('windKmh', 35)]:
            changed = {'regions': {'hangzhou': {'days': [{**row, field: value}]}}}
            self.assertFalse(ai.suitable(candidate, '2026-11-07', changed))
            self.assertTrue(ai.suitable({**candidate, 'type': 'rainy'}, '2026-11-07', changed))

    def trip_fixture(self):
        stamp = ai.news.iso(self.now - timedelta(minutes=5))
        places = [{'id': key, 'name': name, 'group': group, 'area': '杭州',
                   'paragraphs': [{'text': name}], 'reviewedOn': '2026-11-01',
                   'links': [{'label': '场地原文', 'url': 'https://example.com/' + key}]}
                  for key, name, group in [('book', '室内书店', 'rainy'), ('craft', '室内手作', 'rainy'),
                      ('theatre', '话剧剧院', 'rainy'), ('hill', '宝石山', 'hiking'),
                      ('climbing', '室内攀岩', 'rainy'), ('skating', '万象城真冰场', 'rainy')]]
        weather = {'updatedAt': stamp, 'regions': {'hangzhou': {'days': [
            {'date': day, 'code': 63, 'low': 10, 'high': 20, 'rainProbability': 90, 'rainMm': 8, 'windKmh': 8}
            for day in ('2026-11-07', '2026-11-08')]}}}
        trip = {'updatedAt': stamp, 'attemptedAt': stamp, 'revision': 'editorial-v1', 'status': 'ok',
                'weekendStart': '2026-11-07', 'weekendEnd': '2026-11-08', 'weather': weather,
                'picks': [{'id': 'place:book', 'day': '2026-11-07', 'reason': '周六可能下雨，可在室内书店阅读。'}]}
        return places, trip

    def test_filtered_picks_are_filled_with_sourced_weather_eligible_choices(self):
        places, trip = self.trip_fixture()
        trip['picks'] += [{'id': 'place:' + key, 'day': '2026-11-07', 'reason': '这是一条旧的室内活动推荐。'}
                          for key in ('climbing', 'skating')]
        result = ai.complete_trip({}, places, {}, trip, self.now)
        self.assertEqual({p['id'] for p in result['picks']}, {'place:book', 'place:craft', 'place:theatre'})
        self.assertTrue(all(p['sources'] for p in result['picks']))
        self.assertEqual([p['selection'] for p in result['picks']], ['ai', 'rules', 'rules'])
        self.assertEqual(result['updatedAt'], trip['updatedAt'])
        self.assertEqual(result['weather']['updatedAt'], trip['weather']['updatedAt'])

    def test_short_ai_response_is_completed_without_another_api_call(self):
        places, trip = self.trip_fixture()
        client = Mock()
        client.ask.return_value = ({'picks': trip['picks']}, {})
        result = ai.recommend(client, {}, places, {}, trip['weather'], self.now)
        self.assertEqual(len(result['picks']), 3)
        client.ask.assert_called_once()

    def test_retry_cooldown_does_not_leave_a_filtered_trip_short(self):
        places, trip = self.trip_fixture()
        previous = {'editorial': {'trip': trip, 'research': {'items': [], 'revision': ai.OUTING_REVISION,
            'searchedAt': trip['updatedAt'], 'attemptedAt': trip['attemptedAt']}}}
        with tempfile.TemporaryDirectory() as folder:
            transport = Mock(side_effect=AssertionError('No API call during cooldown'))
            client = ai.Client('x', self.config, {}, Path(folder) / 'state.json', self.now, transport)
            with patch.object(ai, 'edit_news', return_value={}), patch.object(ai, 'fetch_weather') as weather:
                result = ai.run({}, previous, client.state, client, places, self.now)
            transport.assert_not_called()
            weather.assert_not_called()
            self.assertEqual(len(result['trip']['picks']), 3)
            self.assertEqual(result['trip']['attemptedAt'], trip['attemptedAt'])
            self.assertEqual(result['trip']['updatedAt'], trip['updatedAt'])

    def test_completion_respects_closures_dates_and_forecast_age(self):
        places, trip = self.trip_fixture()
        data = {'placeUpdates': {'places': {'craft': {'items': [{
            'title': '手作场地暂停营业', 'url': 'https://example.com/closure',
            'publishedAt': '2026-11-01T00:00:00Z'}]}}}}
        result = ai.complete_trip(data, places, {}, trip, self.now)
        self.assertEqual({p['id'] for p in result['picks']}, {'place:book', 'place:theatre'})
        for age in (timedelta(hours=25), -timedelta(minutes=5)):
            stale = copy.deepcopy(trip)
            stale['weather']['updatedAt'] = ai.news.iso(self.now - age)
            self.assertEqual(ai.complete_trip({}, places, {}, stale, self.now), stale)
        sunday = ai.news.parse_date('2026-11-08T01:00:00Z')
        trip['weather']['updatedAt'] = ai.news.iso(sunday)
        result = ai.complete_trip({}, places, {}, trip, sunday)
        self.assertEqual(len(result['picks']), 3)
        self.assertTrue(all(p['day'] == '2026-11-08' for p in result['picks']))

    def test_api_failure_keeps_previous_research_and_does_not_advance_success(self):
        state = {}
        previous = {'editorial': {'research': {'items': [], 'searchedAt': '2026-11-01T08:00:00Z', 'revision': ai.REVISION},
                                  'trip': {'picks': [], 'updatedAt': '2026-11-01T08:00:00Z'}}}
        with tempfile.TemporaryDirectory() as folder:
            client = ai.Client('x', self.config, state, Path(folder) / 'state.json', self.now,
                               lambda _: (_ for _ in ()).throw(TimeoutError()))
            data = {'articles': [self.a], 'weekendArticles': []}
            with patch.object(ai, 'fetch_weather', side_effect=TimeoutError()):
                result = ai.run(data, previous, state, client, [], self.now)
            self.assertEqual(result['research']['searchedAt'], '2026-11-01T08:00:00Z')
            self.assertEqual(result['research']['status'], 'unavailable')
            self.assertEqual(data['articles'][0]['title'], self.a['title'])
            self.assertGreater(result['usage']['estimatedUsd'], 0)


if __name__ == '__main__':
    unittest.main()
