import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guide_sync', ROOT / 'scripts/sync_life_guide.py')
guide = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide)


class GuideTests(unittest.TestCase):
    def test_parser_preserves_multiline_notes_and_discovers_new_chapters(self):
        files = {'README.md': '\n'.join(f'| 第 {n} 个问题 | [{n}. 章节](book/{n:02}-章节.md) |' for n in range(1, 11))}
        note = '- 备注：争议。仅适用于特定人群。\n  另一项研究有反面证据。\n- 来源：<https://example.com/source>\n'
        body = '<!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=金钱 -->\n- 说人话：原文\n- 证据等级：A\n' + note
        for n in range(1, 11):
            files[f'book/{n:02}-章节.md'] = f'# {n}. 章节\n章节引言\n\n' + '\n'.join(f'### {i}. 条目\n{body}' for i in range(1, 11))
        data = guide.parse_book(files, 'a' * 40, '2026-10-10T00:00:00Z')
        self.assertEqual(len(data['entries']), 100)
        self.assertEqual(data['entries'][0]['body'], body.strip())
        self.assertTrue(data['entries'][0]['disputed'])
        self.assertEqual(data['chapters'][0]['intro'], '章节引言')
        self.assertEqual(data['entries'][-1]['id'], '10-10')
        files['book/10-章节.md'] = '# 10. 章节\n'
        with self.assertRaises(ValueError):
            guide.parse_book(files, 'a' * 40, '2026-10-10T00:00:00Z')


if __name__ == '__main__':
    unittest.main()
