import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from outing_now import public_context


class OutingNowTests(unittest.TestCase):
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
        self.assertEqual(result['candidates'][2]['end'], '2026-11-08')
        self.assertNotIn('private', str(result))


if __name__ == '__main__':
    unittest.main()
