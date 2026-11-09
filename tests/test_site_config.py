import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from site_config import site_origin


class SiteConfigTests(unittest.TestCase):
    def test_origin_accepts_only_a_deployment_host(self):
        with patch.dict(os.environ, NEWS_SITE_URL='https://Reader.Example.org/'):
            self.assertEqual(site_origin(), 'https://reader.example.org')
        for value in ('', 'http://example.org', '//example.org', 'https://user@example.org',
                      'https://example.org:8443', 'https://example.org/path',
                      'https://example.org/?next=other', 'https://example.org/#fragment',
                      'https://example..org', 'https://-example.org', 'https://example.org/"<script>'):
            with self.subTest(value=value), patch.dict(os.environ, NEWS_SITE_URL=value):
                with self.assertRaises(ValueError):
                    site_origin()
