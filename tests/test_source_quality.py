import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('quality_collector', ROOT / 'scripts/collect_news.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class SourceQualityTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 10, 8, tzinfo=timezone.utc)
        self.sources = [{'id': source, 'url': f'https://{source}.example/rss', 'category': 'tech'}
                        for source in ('a', 'b')]

    def article(self, source, key, title=None, published=None, google=False):
        return {'sourceId': source, 'title': title or key,
                'url': ('https://news.google.com/rss/articles/' if google else f'https://{source}.example/') + key,
                'publishedAt': collector.iso(published or self.now)}

    def update(self, state, incoming, now=None, failed=(), baseline=(), sources=None):
        statuses = [{'id': source['id'], 'status': 'unavailable' if source['id'] in failed else 'ok'}
                    for source in (sources or self.sources)]
        state, summary = collector.update_source_quality(
            state, sources or self.sources, statuses, incoming, list(baseline), now or self.now)
        return state, {row['id']: row for row in summary['sources']}, statuses

    def test_first_collection_is_a_baseline_not_a_fabricated_week(self):
        state, public, statuses = self.update(None, [self.article('a', 'old-feed')],
                                             baseline=[self.article('b', 'archived')])
        self.assertEqual([status['newCount'] for status in statuses], [0, 0])
        self.assertEqual(public['a']['newCount'], 0)
        self.assertIsNone(public['a']['duplicateRate'])
        self.assertEqual(public['a']['observedDays'], 1)
        self.assertEqual(public['a']['noNewDays'], 0)
        self.assertEqual(state['startedAt'], collector.iso(self.now))
        self.assertTrue(all(row[3] is None for source in state['sources'].values() for row in source['seen']))

    def test_repeated_polls_and_same_source_revisions_do_not_inflate_new_or_duplicates(self):
        old = self.article('a', 'old')
        state, _, _ = self.update(None, [old])
        incoming = [old, self.article('a', 'one', '模型 3.0 发布'),
                    self.article('a', 'revision', '模型 3.0 发布'),
                    self.article('a', 'unique', '另一则消息'),
                    self.article('b', 'copy', '模型 3.0 发布 - 发布方', google=True)]
        state, public, statuses = self.update(state, incoming, self.now + timedelta(hours=1))
        self.assertEqual([status['newCount'] for status in statuses], [2, 1])
        self.assertEqual(public['a']['duplicateCount'], 1)
        self.assertEqual(public['a']['duplicateRate'], 0.5)
        self.assertEqual(public['b']['duplicateRate'], 1)
        for hour in range(2, 5):
            state, public, statuses = self.update(state, incoming, self.now + timedelta(hours=hour))
            self.assertEqual([status['newCount'] for status in statuses], [0, 0])
            self.assertEqual(public['a']['newCount'], 2)
            self.assertEqual(public['a']['duplicateCount'], 1)
        # Public archive eviction has no bearing on observation history.
        state, public, statuses = self.update(state, incoming, self.now + timedelta(hours=5), baseline=[])
        self.assertEqual(public['a']['newCount'], 2)
        self.assertEqual(statuses[0]['newCount'], 0)

    def test_delayed_cross_source_copy_updates_original_day_and_preserves_versions(self):
        state, _, _ = self.update(None, [])
        original = self.article('a', 'one', '模型 3.0 发布')
        state, public, _ = self.update(state, [original], self.now + timedelta(hours=1))
        self.assertEqual(public['a']['duplicateCount'], 0)
        copy = self.article('b', 'copy', '模型 3.0 发布 - 网站', google=True)
        version = self.article('b', 'other-version', '模型 30 发布')
        state, public, _ = self.update(state, [copy, version], self.now + timedelta(days=1))
        self.assertEqual(public['a']['duplicateCount'], 1)
        self.assertEqual(public['b']['newCount'], 2)
        self.assertEqual(public['b']['duplicateCount'], 1)
        self.assertEqual(public['a']['daily'][0]['duplicateCount'], 1)
        self.assertNotEqual(collector.quality_title_key(original), collector.quality_title_key(version))
        self.assertNotEqual(collector.quality_title_key(self.article('a', 'p', 'Research - Design')),
                            collector.quality_title_key(self.article('b', 'q', 'Research')))

    def test_same_title_on_a_different_beijing_day_is_a_new_daily_report(self):
        state, _, _ = self.update(None, [])
        first = datetime(2026, 10, 10, 15, 55, tzinfo=timezone.utc)
        second = first + timedelta(minutes=10)
        state, public, _ = self.update(state, [self.article('a', 'day-one', '今日播报', first)], first)
        state, public, _ = self.update(state, [self.article('b', 'day-two', '今日播报', second)], second)
        self.assertEqual([row['date'] for row in public['a']['daily']], ['2026-10-10', '2026-10-11'])
        self.assertEqual(public['a']['duplicateCount'], 0)
        self.assertEqual(public['b']['duplicateCount'], 0)

    def test_no_new_duration_requires_continuous_successful_observation(self):
        old = self.article('a', 'old')
        state, _, _ = self.update(None, [old])
        for hour in range(1, 37):
            state, public, _ = self.update(state, [old], self.now + timedelta(hours=hour))
        self.assertEqual(public['a']['noNewDays'], 1)
        for hour in range(37, 40):
            state, public, _ = self.update(state, [], self.now + timedelta(hours=hour), failed=('a',))
        self.assertIsNone(public['a']['noNewDays'])
        self.assertEqual(public['a']['failureStreak'], 3)
        state, public, _ = self.update(state, [old], self.now + timedelta(hours=40))
        self.assertEqual(public['a']['noNewDays'], 0)
        self.assertEqual(public['a']['failureStreak'], 0)
        state, public, _ = self.update(state, [old], self.now + timedelta(hours=45))
        self.assertEqual(public['a']['noNewDays'], 0)
        state, public, _ = self.update(state, [self.article('a', 'new')], self.now + timedelta(hours=46))
        self.assertEqual(public['a']['lastNewAt'], collector.iso(self.now + timedelta(hours=46)))

    def test_week_rolls_by_beijing_day_and_changed_or_removed_sources_reset(self):
        state, _, _ = self.update(None, [])
        for day in range(1, 12):
            now = self.now + timedelta(days=day)
            state, public, _ = self.update(state, [self.article('a', str(day), published=now)], now)
        self.assertEqual(public['a']['newCount'], 7)
        self.assertEqual(public['a']['observedDays'], 7)
        self.assertEqual(public['a']['daily'][0]['date'], '2026-10-15')
        changed = [{**self.sources[0], 'url': 'https://a.example/replacement'}]
        state, public, statuses = self.update(state, [self.article('a', 'replacement')],
                                             self.now + timedelta(days=12), sources=changed)
        self.assertEqual(set(state['sources']), {'a'})
        self.assertEqual(public['a']['observedDays'], 1)
        self.assertEqual(statuses[0]['newCount'], 0)
        self.assertEqual(public['a']['startedAt'], collector.iso(self.now + timedelta(days=12)))

    def test_first_success_after_initial_failure_establishes_the_feed_baseline(self):
        state, _, _ = self.update(None, [], failed=('a',))
        state, public, statuses = self.update(state, [self.article('a', 'existing')],
                                             self.now + timedelta(hours=1))
        self.assertEqual(statuses[0]['newCount'], 0)
        self.assertEqual(public['a']['failureStreak'], 0)
        self.assertEqual(public['a']['noNewDays'], 0)

    def test_invalid_or_future_history_is_rejected_instead_of_silently_reset(self):
        state, _, _ = self.update(None, [])
        invalid = json.loads(json.dumps(state))
        invalid['sources']['a']['daily'][0]['successes'] = 999
        with self.assertRaisesRegex(ValueError, 'quality'):
            self.update(invalid, [])
        with self.assertRaisesRegex(ValueError, 'newer'):
            self.update(state, [], self.now - timedelta(minutes=1))
        collector.validate_quality_state(state)

    def test_build_serves_small_lazy_summary_without_tracking_history_in_first_packet(self):
        state, public, _ = self.update(None, [])
        spec = importlib.util.spec_from_file_location('quality_builder', ROOT / 'scripts/build_news.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        summary = {'schema': 1, 'windowDays': 7, 'startedAt': state['startedAt'],
                   'updatedAt': state['updatedAt'], 'sources': list(public.values())}
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            builder.build_news_pages({'articles': [], 'updatedAt': state['updatedAt'],
                                      'sourceQuality': summary, 'sourceQualityState': state}, output)
            latest = json.loads((output / 'data/latest.json').read_text())
            self.assertNotIn('sourceQualityState', latest)
            self.assertNotIn('sources', latest['sourceQuality'])
            self.assertRegex(latest['sourceQuality']['path'], r'^/data/source-quality\.[a-f0-9]{16}\.json$')
            self.assertEqual(json.loads((output / latest['sourceQuality']['path'].lstrip('/')).read_text()), summary)


if __name__ == '__main__':
    unittest.main()
