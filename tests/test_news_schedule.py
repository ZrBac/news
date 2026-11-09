import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import news_schedule as schedule


class NewsScheduleTests(unittest.TestCase):
    def test_complete_day_collects_only_seven_slots_despite_other_publications(self):
        midnight = datetime(2026, 11, 9, tzinfo=schedule.BEIJING)
        previous = {'updatedAt': (midnight - timedelta(hours=3)).isoformat()}
        hours = []
        for minute in range(24 * 60):
            now = midnight + timedelta(minutes=minute)
            if schedule.should_collect(previous, now):
                hours.append((now.hour, now.minute))
                previous['newsCheckedAt'] = now.isoformat()
            previous = schedule.reuse(previous, now)
        self.assertEqual(hours, [(hour, 0) for hour in (9, 11, 13, 15, 17, 19, 21)])

    def test_manual_news_can_override_hours_but_outing_refresh_always_skips_news(self):
        for hour in range(24):
            now = datetime(2026, 11, 9, hour, tzinfo=schedule.BEIJING)
            previous = {'updatedAt': now.isoformat()}
            self.assertTrue(schedule.should_collect(previous, now, 'force'))
            self.assertFalse(schedule.should_collect(previous, now, 'skip'))

    def test_utc_day_boundary_and_news_check_determine_due_slot(self):
        now = schedule.parse('2026-11-09T01:00:00Z')
        previous = {'updatedAt': now.isoformat(), 'newsCheckedAt': '2026-11-08T13:05:00Z'}
        self.assertTrue(schedule.should_collect(previous, now))
        self.assertEqual(schedule.latest_slot(now).isoformat(), '2026-11-09T09:00:00+08:00')
        self.assertFalse(schedule.should_collect(previous, now - timedelta(seconds=1)))
        self.assertEqual(schedule.next_slot(schedule.parse('2026-11-08T13:05:00Z')), now)

    def test_reuse_preserves_news_and_metrics_advancing_only_publication(self):
        previous = {'updatedAt': '2026-11-09T07:04:00Z', 'articles': [{'id': 'kept'}],
                    'sourceQuality': {'updatedAt': '2026-11-09T07:04:00Z'},
                    'editorial': {'news': {'processed': 100}}}
        original = copy.deepcopy(previous)
        result = schedule.reuse(previous, schedule.parse('2026-11-09T08:03:00Z'))
        self.assertEqual(result['newsCheckedAt'], previous['updatedAt'])
        self.assertEqual(result['updatedAt'], '2026-11-09T08:03:00Z')
        self.assertEqual(result['articles'], previous['articles'])
        self.assertEqual(result['sourceQuality'], previous['sourceQuality'])
        self.assertEqual(result['editorial'], previous['editorial'])
        result['articles'][0]['id'] = 'changed'
        self.assertEqual(previous, original)

    def test_cli_skip_writes_snapshot_and_workflow_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = root / 'previous.json'
            previous.write_text(json.dumps({'updatedAt': '2026-11-08T13:04:00Z', 'articles': [{'id': 'a'}]}))
            output, gate = root / 'news.json', root / 'gate'
            subprocess.run([sys.executable, str(ROOT / 'scripts/news_schedule.py'), '--previous-file', str(previous),
                            '--output', str(output), '--mode', 'skip'], check=True, capture_output=True,
                           env={**os.environ, 'GITHUB_OUTPUT': str(gate)})
            self.assertEqual(gate.read_text(), 'collect=false\n')
            self.assertEqual(json.loads(output.read_text())['newsCheckedAt'], '2026-11-08T13:04:00Z')
