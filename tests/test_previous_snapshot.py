import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import previous_snapshot as snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 5, 4, tzinfo=timezone.utc)
        self.data = {'version': 1, 'updatedAt': '2026-11-05T03:00:00Z',
                     'sources': [{'id': 'example'}],
                     'articles': [{'id': 'story', 'title': 'Headline', 'url': 'https://example.com/news',
                                   'sourceId': 'example', 'category': 'general', 'publishedAt': '2026-11-05T02:00:00Z'}],
                     'exchangeRates': {'points': [1, 2]}, 'editorial': {'status': 'ok'},
                     'weekendArticles': [{'id': 'outing'}], 'placeUpdates': {'schema': 1}}
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.backup = Path(self.directory.name) / 'last-good.json'

    def restore(self, get):
        return snapshot.restore('https://example.com/data/news.json', self.backup, get, self.now)

    def test_reads_once_and_preserves_every_section(self):
        get = Mock(return_value=json.dumps(self.data).encode())
        self.assertEqual(self.restore(get), ('published', self.data))
        get.assert_called_once()

    def test_retries_a_temporary_failure_before_using_backup(self):
        get = Mock(side_effect=[TimeoutError(), json.dumps(self.data)])
        self.assertEqual(self.restore(get), ('published', self.data))
        self.assertEqual(get.call_count, 2)

    def test_outage_retains_history_and_original_timestamp(self):
        self.backup.write_text(json.dumps(self.data))
        get = Mock(side_effect=OSError('site unavailable'))
        self.assertEqual(self.restore(get), ('backup', self.data))
        self.assertEqual(get.call_count, 2)

    def test_older_cdn_response_cannot_roll_back_backup(self):
        self.backup.write_text(json.dumps(self.data))
        old = {**self.data, 'updatedAt': '2026-11-05T01:00:00Z'}
        self.assertEqual(self.restore(Mock(return_value=json.dumps(old))), ('backup', self.data))

    def test_news_check_can_precede_publication_but_cannot_advance_past_it(self):
        valid = {**self.data, 'newsCheckedAt': '2026-11-04T13:00:00Z'}
        self.assertEqual(snapshot.validate(valid, self.now), valid)
        for stamp in ('2026-11-05T03:30:00Z', '2026-11-05T02:00:00', 'invalid'):
            with self.assertRaises(ValueError):
                snapshot.validate({**self.data, 'newsCheckedAt': stamp}, self.now)

    def test_bad_backup_does_not_block_valid_publication(self):
        self.backup.write_text('{broken')
        self.assertEqual(self.restore(Mock(return_value=json.dumps(self.data))), ('published', self.data))

    def test_rejects_partial_empty_duplicate_and_future_snapshots(self):
        invalid = [
            {**self.data, 'archive': {'total': 6000}},
            {**self.data, 'articles': []},
            {**self.data, 'articles': self.data['articles'] * 2},
            {**self.data, 'sources': []},
            {**self.data, 'updatedAt': '2026-11-06T03:00:00Z'},
            {**self.data, 'updatedAt': '2026-11-05T03:00:00'},
            {**self.data, 'articles': [{'id': 'broken'}]},
        ]
        for data in invalid:
            with self.subTest(data=data):
                with self.assertRaisesRegex(ValueError, 'No valid previous snapshot'):
                    self.restore(Mock(return_value=json.dumps(data)))

    def test_all_unavailable_stops_without_overwriting_backup(self):
        self.backup.write_text('{broken')
        with self.assertRaises(ValueError):
            self.restore(Mock(side_effect=TimeoutError()))
        self.assertEqual(self.backup.read_text(), '{broken')


if __name__ == '__main__':
    unittest.main()
