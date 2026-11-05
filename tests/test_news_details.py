import copy
import json
import sys
import tempfile
import unittest
import urllib.request
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ai_editor as ai
import news_details as detail


class NewsDetailTests(unittest.TestCase):
    def setUp(self):
        self.now = ai.news.parse_date('2026-11-05T08:00:00Z')
        self.article = {'id': 'a', 'title': '星河模型正式版发布', 'excerpt': '星河模型发布新版本。',
                        'category': 'models', 'sourceId': 'example', 'url': 'https://example.com/a',
                        'publishedAt': '2026-11-05T07:00:00Z'}
        self.quote = '星河模型已在开发者平台上线，现有企业用户可申请体验，模型权重计划于下月开源。'
        self.summary = '星河模型已在开发者平台上线，现有企业用户可申请体验；权重计划下月开源。'
        self.body = self.quote + '\n' + '该版本新增图表分析功能，用户可以上传工作中的表格，具体接入方式请参阅开发文档。' * 5
        self.sources = [{'home': 'https://example.com', 'url': 'https://example.com/rss'}]
        self.config = json.loads((ai.ROOT / 'news/editorial.json').read_text())

    def client(self, points=None):
        result = {'items': [{'id': 'a', 'points': points if points is not None else
                            [{'text': self.summary, 'quote': self.quote}]}]}
        return Mock(config=self.config, ask=Mock(return_value=(result, {})))

    def update(self, state, client=None, body=None, now=None):
        return detail.update(client or self.client(), {'articles': [self.article]}, {}, state,
                             now or self.now, self.sources,
                             get=lambda *_: {'url': self.article['url'], 'body': body or self.body})

    def test_article_container_excludes_navigation_and_handles_unclosed_paragraph(self):
        html = f'''<title>{self.article['title']}</title><nav><p>导航内容</p></nav>
          <div class="left_zw"><p>{self.body}<div class="adEditor">编辑广告</div></div>
          <div><p>这里是另一篇文章的推荐，不能被当作本文依据。</p></div>'''
        body = detail.extract_article(html, self.article['title'])
        self.assertIn(self.quote, body)
        self.assertNotIn('导航', body)
        self.assertNotIn('编辑广告', body)
        self.assertNotIn('另一篇', body)

    def test_structured_article_body_must_match_its_headline(self):
        data = {'@graph': [{'headline': '无关消息', 'articleBody': '无关正文' * 80},
                           {'headline': self.article['title'], 'articleBody': self.body}]}
        html = f'<title>{self.article["title"]}</title><script type="application/ld+json">{json.dumps(data)}</script>'
        self.assertIn(self.quote, detail.extract_article(html, self.article['title']))
        for page in ('<title>安全验证</title>' + self.body,
                     f'<title>{self.article["title"]}</title><p>正在加载</p>'):
            with self.assertRaises(ValueError):
                detail.extract_article(page, self.article['title'])

    def test_only_configured_publishers_and_public_https_redirects_are_read(self):
        allowed = detail.domains(self.sources + [{'url': 'https://news.google.com/rss/search?q=site%3Apublisher.cn'}])
        self.assertEqual(detail.source_url({**self.article, 'url': 'http://example.com/a?utm_source=x'}, allowed), self.article['url'])
        self.assertEqual(detail.source_url({'url': 'https://news.publisher.cn/a'}, allowed), 'https://news.publisher.cn/a')
        for url in ('https://127.0.0.1/a', 'https://example.com.evil.test/a',
                    'https://name@example.com/a', 'https://example.com:8080/a', 'file:///tmp/a',
                    'https://news.google.com/rss/articles/abc'):
            self.assertIsNone(detail.source_url({'url': url}, allowed))
        redirect = detail.ArticleRedirect(allowed)
        for url in ('http://example.com/a', 'https://elsewhere.test/a'):
            with self.assertRaises(ValueError):
                redirect.redirect_request(urllib.request.Request(self.article['url']), None, 302, '', {}, url)

    def test_facts_need_literal_evidence_and_add_something_beyond_the_feed(self):
        points = [{'text': self.summary, 'quote': self.quote}]
        self.assertEqual(detail.validate_points(points, self.article, self.body)['summary'], self.summary)
        self.assertIsNone(detail.validate_points(points, self.article, '完全不同的文章'))
        self.assertIsNone(detail.validate_points(points, {**self.article, 'excerpt': self.quote}, self.body))
        self.assertIsNone(detail.validate_points(points * 3, self.article, self.body))
        self.assertIsNone(detail.validate_points(points * 2, self.article, self.body))
        self.assertIsNone(detail.validate_points([{'text': self.summary, 'quote': self.quote + '免费'}], self.article, self.body))

    def test_number_substrings_cannot_support_a_different_date_or_price(self):
        quote = '体验将在11月18日开放，企业用户每月需支付1999元，申请后才能使用全部功能。'
        valid = '企业用户须先申请体验，每月费用为1999元；体验将于11月18日开放。'
        self.assertIsNotNone(detail.validate_points([{'text': valid, 'quote': quote}], self.article, quote))
        for text in (valid.replace('1999', '99'), valid.replace('18日', '8日'), valid.replace('1999', '1999%')):
            self.assertIsNone(detail.validate_points([{'text': text, 'quote': quote}], self.article, quote))

    def test_long_second_point_does_not_remove_first_sentences_conditions(self):
        extra = '新版新增了图表处理功能，需要通过企业账号申请后上传表格，处理完成后可以继续编辑结果。'
        second = extra * 3
        result = detail.validate_points([{'text': self.summary, 'quote': self.quote},
                                         {'text': second, 'quote': second}], self.article, self.body + second)
        self.assertEqual(result, {'summary': self.summary, 'quotes': [self.quote]})

    def test_planned_release_and_self_reported_performance_keep_qualifiers(self):
        quote = '星河模型权重计划于下月开源，采用新的图表解析流程，支持多页表格内容合并。'
        text = '星河模型权重已开源，采用新的图表解析流程，支持多页表格内容合并。'
        self.assertIsNone(detail.validate_points([{'text': text, 'quote': quote}], self.article, quote))
        quote = '官方公布，星河模型在图表解析测试中得分90分，测试覆盖表格合并和内容提取。'
        text = '星河模型在图表解析测试中得分90分，测试覆盖表格合并和内容提取。'
        self.assertIsNone(detail.validate_points([{'text': text, 'quote': quote}], self.article, quote))
        self.assertIsNotNone(detail.validate_points([{'text': '官方公布，' + text, 'quote': quote}], self.article, quote))

    def test_candidates_cover_categories_models_and_do_not_spend_twice_on_one_event(self):
        rows = [{**self.article, 'id': category, 'category': category, 'title': category + ' new update'}
                for category in detail.CATEGORIES]
        older = {**self.article, 'id': 'older', 'title': '旧一些的模型发布', 'publishedAt': '2026-11-03T07:00:00Z'}
        future = {**self.article, 'id': 'future', 'publishedAt': '2026-11-09T07:00:00Z'}
        duplicate = {**rows[0], 'id': 'duplicate', 'title': 'duplicate report'}
        records = {'general': {'eventId': 'same'}, 'duplicate': {'eventId': 'same'}}
        chosen = detail.candidates({'articles': rows + [duplicate, future], 'modelReleases': [older]}, records, self.now)
        self.assertEqual({a['category'] for a in chosen}, set(detail.CATEGORIES))
        self.assertIn('older', [a['id'] for a in chosen])
        self.assertNotIn('future', [a['id'] for a in chosen])
        self.assertNotIn('duplicate', [a['id'] for a in chosen])

    def test_cache_reuses_unchanged_source_without_more_model_calls(self):
        state, client = {}, self.client()
        self.assertEqual(self.update(state, client)['processed'], 1)
        self.assertEqual(self.update(state, client)['attempted'], 0)
        self.assertEqual(self.update(state, client, now=self.now + timedelta(hours=13))['reused'], 1)
        self.assertEqual(client.ask.call_count, 1)
        self.assertNotIn('body', state['newsDetails']['a'])

    def test_no_new_facts_is_cached_as_a_result(self):
        state, client = {}, self.client(points=[])
        self.update(state, client)
        self.update(state, client, now=self.now + timedelta(hours=13))
        self.assertEqual(client.ask.call_count, 1)
        self.assertEqual(state['newsDetails']['a']['status'], 'no_detail')

    def test_source_edits_invalidate_old_details_even_if_next_model_call_fails(self):
        state = {}
        self.update(state)
        client = self.client()
        client.ask.side_effect = TimeoutError()
        self.update(state, client, body='来源已修改开放日期。' + self.body, now=self.now + timedelta(hours=13))
        self.assertIsNone(detail.public_detail(self.article, state['newsDetails']['a']))
        self.assertEqual(self.article['excerpt'], '星河模型发布新版本。')

    def test_failed_fetch_keeps_unchanged_detail_but_not_changed_feed(self):
        state = {}
        self.update(state)
        get = Mock(side_effect=TimeoutError())
        client = self.client()
        detail.update(client, {'articles': [self.article]}, {}, state, self.now + timedelta(hours=13), self.sources, get=get)
        self.assertIsNotNone(detail.public_detail(self.article, state['newsDetails']['a']))
        self.article['excerpt'] = '来源更正了使用条件。'
        detail.update(client, {'articles': [self.article]}, {}, state, self.now + timedelta(hours=13), self.sources, get=get)
        self.assertIsNone(detail.public_detail(self.article, state['newsDetails']['a']))
        client.ask.assert_not_called()

    def test_public_restore_retains_only_summary_and_same_article_attribution(self):
        state = {}
        self.update(state)
        data = {'articles': [copy.deepcopy(self.article)]}
        detail.apply(data, state['newsDetails'])
        published = data['articles'][0]['newsDetail']
        self.assertNotIn('quotes', published)
        self.assertNotIn('body', published)
        restored = {}
        detail.restore(data, restored)
        self.assertEqual(detail.public_detail(self.article, restored['newsDetails']['a']), published)
        published['sourceUrl'] = 'https://unrelated.test/other'
        restored = {}
        detail.restore(data, restored)
        self.assertEqual(restored['newsDetails'], {})
        published['sourceUrl'] = self.article['url']
        data['articles'][0]['excerpt'] = '原摘要已变更'
        detail.restore(data, restored)
        self.assertEqual(restored['newsDetails'], {})

    def test_duplicates_and_other_article_outputs_are_rejected(self):
        client, state = self.client(), {}
        result, _ = client.ask.return_value
        result['items'] *= 2
        result['items'].append({'id': 'unrequested', 'points': []})
        self.assertEqual(self.update(state, client)['processed'], 0)
        self.assertNotIn('unrequested', state['newsDetails'])

    def test_unconfigured_optional_editor_keeps_previous_details_after_collection(self):
        state = {}
        self.update(state)
        previous = {'articles': [copy.deepcopy(self.article)]}
        detail.apply(previous, state['newsDetails'])
        with tempfile.TemporaryDirectory() as folder:
            current, old = Path(folder) / 'current.json', Path(folder) / 'previous.json'
            current.write_text(json.dumps({'articles': [self.article]}))
            old.write_text(json.dumps(previous))
            with patch.dict('os.environ', {'OPENAI_API_KEY': ''}), patch.object(sys, 'argv',
                    ['ai_editor', '--input', str(current), '--previous-file', str(old)]), patch.object(ai, 'Client') as client:
                ai.main()
                client.assert_not_called()
            self.assertEqual(json.loads(current.read_text())['articles'][0]['newsDetail'],
                             previous['articles'][0]['newsDetail'])

    def test_detail_calls_use_the_existing_stronger_model_without_search(self):
        with tempfile.TemporaryDirectory() as folder:
            transport = Mock(return_value={'status': 'completed', 'usage': {'input_tokens': 100, 'output_tokens': 100},
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"items":[]}'}]}]})
            client = ai.Client('test-only', self.config, {}, Path(folder) / 'state.json', self.now, transport)
            client.ask('news_details', detail.PROMPT, [], detail.SCHEMA)
            payload = transport.call_args.args[0]
            self.assertEqual(payload['model'], self.config['researchModel'])
            self.assertTrue(payload['text']['format']['strict'])
            self.assertNotIn('tools', payload)


if __name__ == '__main__':
    unittest.main()
