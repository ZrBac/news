import copy
import json
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import tonight_plans as tonight


class TonightPlansTests(unittest.TestCase):
    def setUp(self):
        self.now = tonight.news.parse_date('2026-11-05T08:00:00Z')
        self.event = {'id': 'event:example', 'name': '晚间双人工作坊', 'discovery': True, 'region': 'hangzhou',
            'area': '余杭区五常', 'start': '2026-11-05', 'end': '2026-11-07',
            'sources': [{'url': 'https://hznews.hangzhou.com.cn/event'}],
            'facts': [{'kind': 'date', 'text': '11月5日20:00—21:00，晚间双人工作坊。'}]}

    def test_evening_needs_same_day_and_explicit_start_and_end(self):
        self.assertEqual(tonight.evening_slot(self.event, '2026-11-05')['minutes'], 60)
        for text in ('11月5日至7日，晚间双人工作坊。', '11月6日20:00—21:00。',
                     '11月5日14:00—15:00。', '11月5日20:00开始，结束时间待定。',
                     '11月5日19:00—20:00。', '11月5日20:00—23:00。',
                     '11月5日、11月6日分别20:00和21:00开场。'):
            with self.subTest(text=text):
                candidate = {**self.event, 'facts': [{'kind': 'date', 'text': text}]}
                self.assertIsNone(tonight.evening_slot(candidate, '2026-11-05'))
        daily = {**self.event, 'facts': [{'kind': 'date', 'text': '每天20:00—21:00开放。'}]}
        self.assertIsNotNone(tonight.evening_slot(daily, '2026-11-05'))
        self.assertIsNone(tonight.evening_slot(daily, '2026-11-08'))

    def test_no_distant_or_unproved_venues_or_duplicate_events(self):
        wrong = [{**self.event, **change} for change in ({'area': '萧山奥体'}, {'region': 'anji'},
                  {'sources': []}, {'discovery': False}, {'name': '晚间攀岩'})]
        result = tonight.evening_events([self.event, copy.deepcopy(self.event), *wrong], self.now)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['day'], '2026-11-05')

    def test_daily_home_ideas_keep_materials_and_never_publish_preferences(self):
        client = Mock()
        client.state = {'outingProfile': {'settings': {'startArea': 'PRIVATE-ADDRESS'}, 'records': []}}
        def answer(task, instructions, material, schema):
            self.assertTrue(all(p.get('project', {}).get('outcome') for p in material['templates']))
            self.assertIn('下次接着做什么', instructions)
            return {'ideas': [
                {'id': p['id'], 'name': '今晚开始一个小项目', 'summary': '从手边的材料开始，留下一页自己的记录。',
                 'steps': ['拿出家里现有的材料。', '按模板完成一小段，保留自己的作品。', '记下做到哪里，下次接着这个位置继续。'],
                 'materials': '不应透传的新增道具', 'private': '不应公开'} for p in material['templates']]}, {}
        client.ask.side_effect = answer
        first = tonight.update_home(client, {}, self.now)
        self.assertEqual(len(first['ideas']), 8)
        self.assertNotIn('materials', first['ideas'][0])
        self.assertNotIn('private', first['ideas'][0])
        self.assertNotIn('PRIVATE-ADDRESS', str(client.ask.call_args))
        self.assertEqual(tonight.update_home(client, first, self.now + timedelta(hours=5)), first)
        self.assertEqual(client.ask.call_count, 1)
        later = tonight.update_home(client, first, self.now + timedelta(days=1))
        self.assertEqual(later['day'], '2026-11-06')
        self.assertEqual(client.ask.call_count, 2)

    def test_old_daily_play_themes_are_replaced_and_all_dismissed_skips_generation(self):
        client = Mock()
        client.state = {'outingProfile': {'records': [
            {'id': p['id'], 'status': 'dismiss'} for p in tonight.catalog() if p.get('project')]}}
        previous = {'revision': 'tonight-v1', 'day': '2026-11-05', 'ideas': [{'name': '旧小游戏'}]}
        result = tonight.update_home(client, previous, self.now)
        self.assertEqual(result['revision'], tonight.REVISION)
        self.assertEqual(result['ideas'], [])
        client.ask.assert_not_called()

    def test_failure_cooldown_and_invalid_generated_ideas(self):
        client = Mock()
        client.state = {}
        previous = {'status': 'unavailable', 'attemptedAt': tonight.news.iso(self.now)}
        self.assertEqual(tonight.update_home(client, previous, self.now + timedelta(minutes=10)), previous)
        client.ask.assert_not_called()
        client.ask.return_value = ({'ideas': [{'id': 'invented', 'name': '虚构场馆'}]}, {})
        with self.assertRaises(ValueError):
            tonight.update_home(client, {}, self.now)

    def test_late_arrivals_have_multiple_self_contained_offline_options(self):
        all_options = tonight.catalog()
        self.assertEqual(json.loads((tonight.ROOT / 'news/tonight.json').read_text())['revision'], tonight.REVISION)
        self.assertEqual(len({p['id'] for p in all_options}), len(all_options))
        for energy in ('easy', 'active'):
            options = [p for p in all_options if 21 in p['arrivals'] and (energy == 'active' or p['energy'] == energy)]
            self.assertGreaterEqual(len(options), 6)
            self.assertTrue(all(p['minutes'] <= 40 and p['setting'] == 'home' and len(p['steps']) == 3 for p in options))
            self.assertGreaterEqual(len([p for p in options if p.get('project')]), 6)
        for p in all_options:
            if p.get('project'):
                self.assertTrue(all(p['project'].get(k) for k in ('outcome', 'next', 'prompt')))


if __name__ == '__main__':
    unittest.main()
