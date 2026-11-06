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
            state['usage']['estimatedUsd'] = self.config['monthlyBudgetUsd']
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
        trip = {'updatedAt': stamp, 'attemptedAt': stamp, 'attemptedRevision': ai.OUTING_REVISION, 'revision': ai.OUTING_REVISION, 'status': 'ok',
                'weekendStart': '2026-11-07', 'weekendEnd': '2026-11-08', 'weather': weather,
                'picks': [{'id': 'place:book', 'day': '2026-11-07', 'reason': '周六可能下雨，可在室内书店阅读。'}]}
        return places, trip

    def test_filtered_picks_are_filled_with_sourced_weather_eligible_choices(self):
        places, trip = self.trip_fixture()
        trip['picks'] += [{'id': 'place:' + key, 'day': '2026-11-07', 'reason': '这是一条旧的室内活动推荐。'}
                          for key in ('climbing', 'skating')]
        result = ai.complete_trip({}, places, {}, trip, self.now)
        self.assertEqual({p['id'] for p in result['alternatives']}, {'place:book', 'place:craft', 'place:theatre'})
        self.assertTrue(all(p['sources'] for p in result['alternatives']))
        self.assertEqual([p['selection'] for p in result['alternatives']], ['ai', 'rules', 'rules'])
        self.assertEqual(result['updatedAt'], trip['updatedAt'])
        self.assertEqual(result['weather']['updatedAt'], trip['weather']['updatedAt'])

    def test_short_ai_response_is_completed_without_another_api_call(self):
        places, trip = self.trip_fixture()
        client = Mock()
        client.state = {}
        client.ask.return_value = ({'picks': trip['picks']}, {})
        result = ai.recommend(client, {}, places, {}, trip['weather'], self.now)
        self.assertEqual(len(result['alternatives']), 3)
        client.ask.assert_called_once()

    def discovery_fixture(self):
        title = '杭州周末手作体验新安排'
        date_text = '活动时间：2026年11月7日至11月8日'
        novelty = '本周新增植物拓印双人体验课程。'
        setting = '本场活动在杭州室内展厅举办。'
        item = {**self.item, 'title': title, 'type': 'culture', 'placeIds': [],
                'quote': '杭州周末手作体验推出植物拓印双人课程。',
                'facts': [{'kind': 'date', 'quote': date_text}],
                'event': {'name': title, 'novelty': novelty, 'venue': '杭州室内展厅',
                          'setting': 'indoor', 'settingEvidence': setting, 'bookingUrl': ''}}
        body = '\n'.join(['2026年11月1日', title, item['quote'], date_text, novelty, setting])
        return item, body

    def test_new_events_require_literal_details_and_indoor_evidence(self):
        item, body = self.discovery_fixture()
        valid = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        info = valid['outing']
        self.assertEqual((info['start'], info['end']), ('2026-11-07', '2026-11-08'))
        self.assertEqual(info['setting'], 'indoor')
        invented = copy.deepcopy(item)
        invented['event'].update(novelty='没有出现在来源里的全新课程。', venue='虚构室内场馆',
                                 settingEvidence='这是没有户外区域的室内展馆', bookingUrl='https://www.ooeli.com/fake')
        info = ai.validate_discovery(invented, {item['url']}, body, [], self.now)['outing']
        self.assertNotIn('novelty', info)
        self.assertNotIn('venue', info)
        self.assertNotIn('bookingUrl', info)
        self.assertEqual(info['setting'], 'unknown')

    def test_actual_indoor_events_survive_rain_and_permanent_places_are_separate(self):
        item, body = self.discovery_fixture()
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        places, trip = self.trip_fixture()
        data = {'weekendArticles': [article, {**article, 'id': 'same-event-another-story'}]}
        result = ai.complete_trip(data, places, {}, trip, self.now)
        self.assertEqual(len(result['picks']), 1, 'duplicate event stories yield one suggestion')
        self.assertEqual(len(result['alternatives']), 3)
        self.assertTrue(result['picks'][0]['discovery'])
        for setting in ('outdoor', 'mixed', 'unknown'):
            article['outing']['setting'] = setting
            self.assertEqual(ai.complete_trip(data, places, {}, trip, self.now)['picks'], [])

    def test_more_choices_remain_deduplicated_and_keep_feedback_filters(self):
        item, body = self.discovery_fixture()
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        events = [{**article, 'id': str(i), 'outing': {**article['outing'], 'eventName': f'杭州手作体验{i}'}} for i in range(12)]
        places, trip = self.trip_fixture()
        places += [{**places[0], 'id': f'backup-{i}', 'name': f'杭州备选{i}'} for i in range(8)]
        result = ai.complete_trip({'weekendArticles': events + events}, places, {}, trip, self.now)
        self.assertEqual(len(result['picks']), 8)
        self.assertEqual(len({p['id'] for p in result['picks']}), 8)
        self.assertEqual(len(result['alternatives']), 6)
        dismissed = result['picks'][0]['id']
        profile = {'records': [{'id': dismissed, 'status': 'dismiss'}]}
        updated = ai.complete_trip({'weekendArticles': events}, places, {}, result, self.now, profile)
        self.assertEqual(len(updated['picks']), 8)
        self.assertNotIn(dismissed, [p['id'] for p in updated['picks']])

    def test_advance_announcements_keep_real_dates_only_for_current_weekend(self):
        item, body = self.discovery_fixture()
        item.update(publishedDate='2026-09-18', publishedEvidence='2026年9月18日')
        body = body.replace('2026年11月1日', '2026年9月18日')
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        self.assertTrue(article['publishedAt'].startswith('2026-09-17'))  # midnight Beijing in UTC
        self.assertTrue(ai.discovery_current(article, self.now))
        self.assertFalse(ai.discovery_current(article, self.now + timedelta(days=7)))
        places, trip = self.trip_fixture()
        result = ai.complete_trip({'weekendArticles': []}, places, {'items': [article]}, trip, self.now)
        self.assertEqual(len(result['picks']), 1, 'a full recent-news list must not hide an advance announcement')
        item['facts'] = []
        self.assertIsNone(ai.validate_discovery(item, {item['url']}, body, [], self.now))

    def test_research_covers_two_topics_and_preserves_results_when_one_fails(self):
        item, body = self.discovery_fixture()
        response = {'output': [{'type':'web_search_call', 'action':{'sources':[{'url':item['url']}]}}]}
        client = Mock()
        client.state = {}
        client.ask.side_effect = [({'items':[item]}, response), TimeoutError(), ({'items':[]}, {}), ({'items':[item]}, {})]
        result = ai.discover(client, [], {}, self.now, get=lambda _:body)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['status'], 'partial')
        calls = client.ask.call_args_list
        self.assertNotEqual(calls[0].args[2]['focus'], calls[1].args[2]['focus'])
        self.assertIn(item['url'], calls[1].args[2]['knownUrls'])

    def test_source_detail_batches_reach_past_the_first_six_pages(self):
        item, body = self.discovery_fixture()
        pages = {f'https://hznews.hangzhou.com.cn/event-{i}':body for i in range(14)}
        client = Mock()
        client.state = {}
        client.ask.side_effect = lambda task, instructions, material, schema: ({'items':[
            {**item, 'url': page['url']} for page in material['pages']]}, {})
        records = ai.extract_source_details(client, pages, [], self.now)
        self.assertEqual(len(records), 14)
        self.assertEqual(client.ask.call_count, 3)
        self.assertEqual(ai.extract_source_details(client, pages, [], self.now), [])
        pages['https://hznews.hangzhou.com.cn/new-page'] = body
        self.assertEqual(len(ai.extract_source_details(client, pages, [], self.now)), 1)

    def test_weekend_card_does_not_promote_a_weekday_session(self):
        item, body = self.discovery_fixture()
        weekday = '11月5日将举办绘本分享会和剪纸体验。'
        sunday = '11月8日下午将举办琥珀流光分享会。'
        item['event']['novelty'] = weekday
        item['facts'].append({'kind': 'date', 'quote': sunday})
        article = ai.validate_discovery(item, {item['url']}, body + '\n' + weekday + '\n' + sunday, [], self.now)
        places, trip = self.trip_fixture()
        candidate = ai.trip_candidates({'weekendArticles': [article]}, [], [], self.now)[0]
        trip['picks'] = [{'id': candidate['id'], 'day': '2026-11-08', 'reason': '周日有室内分享会，可以结合展区参观安排。'}]
        result = ai.complete_trip({'weekendArticles': [article]}, places, {}, trip, self.now)
        self.assertEqual(result['picks'][0]['novelty'], sunday)
        self.assertEqual(article['outing']['novelty'], weekday, 'keep the source record intact')
        candidate['novelty'] = '11月7日至8日，新增植物拓印双人体验课程。'
        self.assertEqual(ai.activity_text_for_day(candidate, '2026-11-08'), candidate['novelty'])

    def test_full_article_details_are_verified_and_unchanged_pages_are_not_reprocessed(self):
        item, body = self.discovery_fixture()
        item['event']['settingEvidence'] = '本次安排在五大主题馆举行。'
        body += '\n' + item['event']['settingEvidence']
        client = Mock()
        client.state = {}
        client.ask.return_value = ({'items': [item, {**item, 'url': 'https://www.ooeli.com/not-provided'}]}, {})
        pages = {item['url']: body}
        records = ai.extract_source_details(client, pages, [], self.now)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['outing']['setting'], 'indoor')
        self.assertEqual(ai.extract_source_details(client, pages, [], self.now), [])
        client.ask.assert_called_once()
        ai.extract_source_details(client, {item['url']: body + '\n新公告'}, [], self.now)
        self.assertEqual(client.ask.call_count, 2)

    def test_partial_reextraction_keeps_details_only_while_the_same_event_still_proves_them(self):
        item, body = self.discovery_fixture()
        previous = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        partial = copy.deepcopy(previous)
        del partial['outing']['novelty']
        self.assertEqual(ai.merge_discovery(previous, partial, body)['outing']['novelty'], item['event']['novelty'])
        self.assertNotIn('novelty', ai.merge_discovery(previous, partial, body.replace(item['event']['novelty'], ''))['outing'])
        partial['outing']['eventName'] = '另一个活动'
        self.assertNotIn('novelty', ai.merge_discovery(previous, partial, body)['outing'])

    def test_private_feedback_filters_places_and_events_without_entering_cache(self):
        item, body = self.discovery_fixture()
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        places, trip = self.trip_fixture()
        profile = {'records': [{'id': 'place:craft', 'title': '私人的去过记录', 'status': 'visited'},
                               {'id': 'place:book', 'status': 'dismiss'}, {'id': 'place:theatre', 'status': 'want'}]}
        data = {'weekendArticles': [article]}
        result = ai.complete_trip(data, places, {}, trip, self.now, profile)
        self.assertEqual([p['id'] for p in result['alternatives']], ['place:theatre'])
        self.assertEqual(len(result['picks']), 1)
        profile['records'].append({'id': result['picks'][0]['id'], 'status': 'visited'})
        self.assertEqual(ai.complete_trip(data, places, {}, trip, self.now, profile)['picks'], [])
        self.assertFalse(ai.outing_profile.excludes({'id': 'event:new', 'placeId': 'craft', 'discovery': True}, profile))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            ai.save(path, {'outingProfile': profile, 'trip': result})
            self.assertNotIn('outingProfile', path.read_text())
            self.assertNotIn('私人的去过记录', path.read_text())

    def test_common_event_aliases_share_feedback_identity(self):
        formal = ai.outing_profile.event_key('第二十届杭州文化创意产业博览会', '2026-11-05', '2026-11-09', '杭州白马湖国际会展中心')
        short = ai.outing_profile.event_key('第二十届杭州文博会', '2026-11-05', '2026-11-09', '白马湖国际会展中心')
        self.assertEqual(formal, short)
        different_date = ai.outing_profile.event_key('第二十届杭州文博会', '2026-11-12', '2026-11-15', '白马湖国际会展中心')
        self.assertNotEqual(formal, different_date)

    def test_source_recheck_invalidates_changed_or_cancelled_details_and_preserves_time_on_failure(self):
        item, body = self.discovery_fixture()
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        previous = {'items': [article]}
        later = self.now + timedelta(hours=6)
        confirmed = ai.recheck_discoveries(previous, later, lambda _: body)['items'][0]
        self.assertEqual(confirmed['verifiedAt'], ai.news.iso(later))
        self.assertEqual(confirmed['publishedAt'], article['publishedAt'])
        changed = ai.recheck_discoveries(previous, later, lambda _: body.replace('11月8日', '11月9日'))['items'][0]
        self.assertEqual(changed['sourceStatus'], 'changed')
        self.assertEqual(ai.trip_candidates({'weekendArticles': [changed]}, [], [], later), [])
        cancelled = ai.recheck_discoveries(previous, later, lambda _: body + '\n' + item['title'] + '取消，请勿前往。')['items'][0]
        self.assertTrue(cancelled['outing']['cancelled'])
        failed = ai.recheck_discoveries(previous, later, Mock(side_effect=TimeoutError()))['items'][0]
        self.assertEqual(failed['verifiedAt'], article['verifiedAt'])
        self.assertEqual(ai.trip_candidates({'weekendArticles': [failed]}, [], [], self.now + timedelta(hours=49)), [])

    def test_feed_story_retains_verified_discovery_fields_when_urls_overlap(self):
        item, body = self.discovery_fixture()
        article = ai.validate_discovery(item, {item['url']}, body, [], self.now)
        feed = {**article, 'sourceId': 'local-feed', 'outing': {'type': 'culture'}}
        data = {'weekendArticles': [feed]}
        ai.apply_results(data, {'research': {'items': [article], 'status': 'ok'}}, {}, self.now)
        self.assertEqual(data['weekendArticles'][0]['outing']['novelty'], article['outing']['novelty'])
        self.assertEqual(len(ai.trip_candidates(data, [], [], self.now)), 1)

    def test_profile_loads_without_credentials_and_reports_an_unavailable_store(self):
        with patch.dict('os.environ', {}, clear=True):
            response = Mock()
            response.read.return_value = b'{"schema":1,"records":[]}'
            opener = Mock()
            opener.return_value.__enter__ = Mock(return_value=response)
            opener.return_value.__exit__ = Mock(return_value=False)
            with patch.object(ai.outing_profile.urllib.request, 'urlopen', opener):
                self.assertEqual(ai.outing_profile.load()['records'], [])
            self.assertIsNone(opener.call_args.args[0].get_header('Authorization'))
            with patch.object(ai.outing_profile.urllib.request, 'urlopen', side_effect=TimeoutError()):
                with self.assertRaises(ai.outing_profile.ProfileUnavailable):
                    ai.outing_profile.load()

    def test_retry_cooldown_does_not_leave_a_filtered_trip_short(self):
        places, trip = self.trip_fixture()
        previous = {'editorial': {'trip': trip, 'research': {'items': [], 'revision': ai.OUTING_REVISION,
            'searchedAt': trip['updatedAt'], 'attemptedAt': trip['attemptedAt'], 'attemptedRevision': ai.OUTING_REVISION}}}
        previous['editorial']['tonightHome'] = {'day': '2026-11-02', 'revision': ai.tonight_plans.REVISION, 'ideas': []}
        with tempfile.TemporaryDirectory() as folder:
            transport = Mock(side_effect=AssertionError('No API call during cooldown'))
            client = ai.Client('x', self.config, {}, Path(folder) / 'state.json', self.now, transport)
            with patch.object(ai, 'edit_news', return_value={}), patch.object(ai, 'fetch_weather') as weather:
                result = ai.run({}, previous, client.state, client, places, self.now)
            transport.assert_not_called()
            weather.assert_not_called()
            self.assertEqual(len(result['trip']['alternatives']), 3)
            self.assertEqual(result['trip']['attemptedAt'], trip['attemptedAt'])
            self.assertEqual(result['trip']['updatedAt'], trip['updatedAt'])

    def test_completion_respects_closures_dates_and_forecast_age(self):
        places, trip = self.trip_fixture()
        data = {'placeUpdates': {'places': {'craft': {'items': [{
            'title': '手作场地暂停营业', 'url': 'https://example.com/closure',
            'publishedAt': '2026-11-01T00:00:00Z'}]}}}}
        result = ai.complete_trip(data, places, {}, trip, self.now)
        self.assertEqual({p['id'] for p in result['alternatives']}, {'place:book', 'place:theatre'})
        for age in (timedelta(hours=25), -timedelta(minutes=5)):
            stale = copy.deepcopy(trip)
            stale['weather']['updatedAt'] = ai.news.iso(self.now - age)
            self.assertEqual(ai.complete_trip({}, places, {}, stale, self.now), stale)
        sunday = ai.news.parse_date('2026-11-08T01:00:00Z')
        trip['weather']['updatedAt'] = ai.news.iso(sunday)
        result = ai.complete_trip({}, places, {}, trip, sunday)
        self.assertEqual(len(result['alternatives']), 3)
        self.assertTrue(all(p['day'] == '2026-11-08' for p in result['alternatives']))

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
