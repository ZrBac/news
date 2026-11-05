import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ai_editor as ai
import build_news as builder
import collect_news as news


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.now = news.parse_date('2026-11-05T10:00:00Z')
        self.source = {'id': 'cctv-news', 'name': '央视网新闻', 'category': 'general',
                       'home': 'https://news.cctv.com/', 'color': '#000', 'format': 'cctv-json'}
        self.notice = {'id': 'holiday', 'title': '国务院办公厅关于2027年部分节假日安排的通知',
                       'category': 'livelihood', 'sourceId': 'cctv-news', 'excerpt': '',
                       'publishedAt': '2026-11-05T09:15:00Z',
                       'url': 'https://news.cctv.com/2026/11/05/holiday.shtml'}

    def test_direct_list_keeps_dates_links_and_public_service_category(self):
        row = {'title': self.notice['title'], 'url': self.notice['url'],
               'focus_date': '2026-11-05 17:15:00', 'brief': '<p>春节放假调休共9天。</p>'}
        bad = [dict(row, focus_date=''), dict(row, focus_date='2026-11-08 17:15:00'),
               dict(row, focus_date='2026-09-05 17:15:00'),
               dict(row, url='https://cctv.com.evil.example/story'),
               dict(row, url='javascript:alert(1)')]
        body = ('news(' + json.dumps({'data': {'list': [row] + bad}}) + ');').encode()
        articles = news.parse_cctv(body, self.source, self.now)
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]['publishedAt'], self.notice['publishedAt'])
        self.assertEqual(articles[0]['category'], 'livelihood')
        self.assertEqual(articles[0]['excerpt'], '春节放假调休共9天。')
        self.assertEqual(articles[0]['url'], row['url'])
        for malformed in (b'news({});alert(1)', b'other({"data":{"list":[]}})', b'<html>error</html>'):
            with self.assertRaises(ValueError):
                news.parse_cctv(malformed, self.source, self.now)

    def test_holiday_notice_is_not_technology_and_rules_are_not_year_specific(self):
        for title in ('2027 年放假安排出炉：调休减少', '2028年部分节假日安排公布'):
            self.assertEqual(news.article_category(title, {'id': 'ithome', 'category': 'tech'}), 'livelihood')
        for title in ('网传2027年放假安排尚未公布', '日本公布2027年放假安排', '2027年放假安排预测'):
            self.assertFalse(news.public_notice(dict(self.notice, title=title)))
        self.assertFalse(news.public_notice(dict(self.notice, url='https://news.cctv.com.evil.example/notice')))

    def test_annual_holiday_reports_merge_without_hiding_school_or_other_years(self):
        other = dict(self.notice, id='tech-report', title='2027 年放假安排出炉：春节调休9天',
                     url='https://www.ithome.com/1/test.htm', excerpt='国务院办公厅今日发布2027年部分节假日安排。')
        self.assertEqual(news.holiday_event(other), news.holiday_event(self.notice))
        self.assertEqual(len(news.brief_candidates([other, self.notice])), 1)
        self.assertNotEqual(news.holiday_event(dict(self.notice, title=self.notice['title'].replace('2027', '2028'))),
                            news.holiday_event(self.notice))
        for title in ('某大学2027年放假安排公布', '2027年春节放假安排', '2027年放假安排预测'):
            self.assertEqual(news.holiday_event(dict(other, title=title, excerpt='')), '')

    def test_major_announcements_survive_busy_feeds_and_source_caps(self):
        filler = [dict(self.notice, id='f' + str(i), title='一般社区动态' + str(i),
                       sourceId='filler', url='https://example.com/' + str(i),
                       publishedAt='2026-11-05T09:50:00Z') for i in range(180)]
        important = [dict(self.notice, id='major' + str(i), title='重要公共事件' + str(i),
                          category='general', publishedAt='2026-11-05T07:00:00Z',
                          editorial={'eventId': 'event-' + str(i) * 24, 'priority': 3}) for i in range(3)]
        with tempfile.TemporaryDirectory() as folder:
            builder.build_news_pages({'updatedAt': news.iso(self.now), 'articles': filler + [self.notice] + important}, Path(folder))
            data = json.loads((Path(folder) / 'data/latest.json').read_text())
        self.assertNotIn('holiday', {a['id'] for a in data['articles']})
        selected = {a['id']: a for a in data['briefArticles']}
        self.assertEqual(selected['holiday']['briefPriority'], 3)
        self.assertEqual(selected['holiday']['briefEvent'], 'notice-holidays-2027')
        self.assertTrue(all(a['id'] in selected for a in important))
        self.assertLessEqual(len(data['briefArticles']), 100)
        # A same-title follow-up with no priority must not erase the older event.
        duplicate = dict(important[0], id='copy', publishedAt='2026-11-05T09:59:00Z', editorial={})
        self.assertEqual(news.brief_candidates([duplicate, important[0]])[0]['id'], 'major0')

    def test_batches_keep_successes_when_one_request_fails_and_retry_only_missing(self):
        rows = [dict(self.notice, id=str(i), title='全国公共服务消息第' + str(i) + '条',
                     sourceId='test', url='https://example.com/' + str(i)) for i in range(30)]
        state, calls = {}, []
        def ask(task, instructions, material, schema):
            calls.append(material)
            if len(calls) == 2:
                raise ai.EditorialError('incomplete_response')
            groups = [{'ids': [a['id']], 'summary': a['title'], 'priority': 2, 'isBackground': False,
                       'evidence': [{'id': a['id'], 'quote': a['title']}]} for a in material['articles']
                      if a['id'] in material['newIds']]
            return {'groups': groups}, {}
        with tempfile.TemporaryDirectory() as folder:
            client = Mock(config={'maxNewsPerRun': 60}, path=Path(folder) / 'state.json', ask=ask)
            records = ai.edit_news(client, {'articles': rows}, state, self.now)
            self.assertEqual(len(records), 18)
            self.assertEqual(state['newsBatchIssues'], ['incomplete_response'])
            self.assertEqual(len(json.loads(client.path.read_text())['newsRecords']), 18)
            self.assertTrue(all(len(c['newIds']) <= 12 and len(c['articles']) <= 18 for c in calls))
            completed = set(records)
            ai.edit_news(client, {'articles': rows}, state, self.now + timedelta(minutes=1))
            self.assertEqual(len(state['newsRecords']), 30)
            self.assertFalse(completed.intersection(calls[-1]['newIds']))
            self.assertEqual(state['newsBatchIssues'], [])
            ai.edit_news(client, {'articles': rows}, state, self.now + timedelta(minutes=2))
            self.assertEqual(len(calls), 4)


if __name__ == '__main__':
    unittest.main()
