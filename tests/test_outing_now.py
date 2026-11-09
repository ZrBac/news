import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from outing_now import public_context
from outing_profile import suggestion_applies, suggestion_context


class OutingNowTests(unittest.TestCase):
    def test_saved_relative_dates_use_shanghai_date_and_do_not_drift_with_each_refresh(self):
        profile = {'settings': {'weekendNote': '明天想出门', 'weekendNoteUpdatedAt': '2026-12-31T16:10:00Z'}}
        self.assertEqual(suggestion_context(profile), {
            'writtenAt': '2027-01-01T00:10+08:00',
            'relativeDates': {'今天': '2027-01-01', '明天': '2027-01-02', '后天': '2027-01-03'}})
        for bad in (None, '', 'invalid', '2026-11-08T13:17:00'):
            self.assertIsNone(suggestion_context({'settings': {'weekendNoteUpdatedAt': bad}})['relativeDates'])
        self.assertNotIn('relativeDates', profile['settings'])

    def test_dated_plan_only_applies_to_its_own_dates_without_changing_shared_settings(self):
        settings = {'weekendNote': '明天下雨，上午阅读，下午听雨赏景', 'weekendNoteUpdatedAt': '2026-11-07T16:21:00Z'}
        profile = {'settings': settings}
        self.assertFalse(suggestion_applies(profile, '2026-11-07', '2026-11-08'))
        self.assertTrue(suggestion_applies(profile, '2026-11-09', '2026-11-09'))
        self.assertFalse(suggestion_applies(profile, '2026-11-14', '2026-11-15'))
        self.assertEqual(settings['weekendNote'], '明天下雨，上午阅读，下午听雨赏景')
        for note in ('喜欢安静的地方', '今天或明天都可以', '2026-11-08下午出门'):
            self.assertTrue(suggestion_applies({'settings': {**settings, 'weekendNote': note}}, '2026-11-07', '2026-11-08'))
        self.assertTrue(suggestion_applies({'settings': {'weekendNote': '明天出门'}}, '2026-11-07', '2026-11-08'), 'undated advice is not assigned an invented date')

    def test_home_activity_packet_does_not_assert_the_current_time_is_evening(self):
        packet = public_context({}, {}, {'activities': [
            {'id': 'event:tonight-photo', 'name': '照片小集', 'setting': 'home', 'summary': '每晚挑三张照片。'},
            {'id': 'event:tonight-cook', 'name': '做菜', 'setting': 'home', 'summary': '今晚的晚饭练一道菜。'}]})
        self.assertEqual([p['id'] for p in packet['candidates']], ['event:tonight-photo', 'event:tonight-cook'])
        self.assertNotRegex(' '.join(p['summary'] for p in packet['candidates']), '每晚|今晚|晚饭')

    def test_public_packet_has_only_source_fields_and_preserves_dates(self):
        place = {'id': 'craft', 'name': '手作', 'group': 'rainy', 'reviewedOn': '2026-11-06',
                 'paragraphs': [{'text': '先核对课程'}], 'links': [{'url': 'https://example.com', 'label': '来源'},
                             {'url': 'javascript:alert(1)'}, {'url': 'https://user:pass@example.com'}]}
        event = {'id': 'event:one', 'name': '新展', 'start': '2026-11-06', 'end': '2026-11-08',
                 'sources': [{'url': 'https://example.com/event'}], 'verifiedAt': '2026-11-06T00:00:00Z'}
        data = {'updatedAt': '2026-11-06T00:00:00Z', 'private': 'not-public',
                'editorial': {'trip': {'picks': [event]}, 'outingProfile': {'note': 'private'}}}
        tonight = {'activities': [{'id': 'event:reading', 'name': '阅读', 'setting': 'home', 'project': {'outcome': '理解'}},
                                  {'id': 'event:outside', 'name': '外出', 'setting': 'outdoor'}]}
        result = public_context(data, {'places': [place, {**place, 'id': 'closed', 'sourceStatus': 'closed'}]}, tonight)
        self.assertEqual([p['id'] for p in result['candidates']], ['event:reading', 'place:craft', 'event:one'])
        self.assertEqual(len(result['candidates'][1]['sources']), 1)
        self.assertEqual(result['candidates'][1]['region'], 'hangzhou')
        self.assertEqual(result['candidates'][2]['end'], '2026-11-08')
        self.assertNotIn('private', str(result))
        distant = public_context({}, {'places': [{**place, 'area': '安吉'}]}, {})
        self.assertEqual(distant['candidates'][0]['region'], 'anji')

    def test_current_verified_events_replace_stale_weekend_selection_and_closures(self):
        place = {'id': 'closed', 'name': '临时闭园地点', 'group': 'rainy', 'links': [{'url': 'https://example.com'}]}
        old = {'id': 'event:cancelled', 'name': '已取消', 'start': '2026-11-06', 'end': '2026-11-08', 'sources': place['links']}
        current = {**old, 'id': 'event:weekday', 'name': '今晚课程', 'end': '2026-11-06'}
        data = {'editorial': {'trip': {'picks': [old]}}}
        result = public_context(data, {'places': [place]}, {}, [current, {'id': 'place:closed', 'closed': True}])
        self.assertEqual([p['id'] for p in result['candidates']], ['event:weekday'])


if __name__ == '__main__':
    unittest.main()
