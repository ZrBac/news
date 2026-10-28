import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('weekend', SCRIPTS / 'collect_weekend.py')
weekend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekend)


class WeekendTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 19, 4, tzinfo=timezone.utc)
        self.article = {'id': 'sample', 'title': '杭州周末农夫市集开市', 'publishedAt': '2026-10-19T02:00:00Z',
                        'url': 'https://hznews.hangzhou.com.cn/event.htm', 'excerpt': ''}

    def test_explicit_dates_location_and_price_do_not_use_publication_time(self):
        info = weekend.outing_info(self.article, '发布时间：2026年10月19日\n活动时间：2026年10月23日至25日\n活动地点：良渚暖村一区草坪\n票价：免费入场')
        self.assertEqual((info['start'], info['end'], info['venue'], info['cost']),
                         ('2026-10-23', '2026-10-25', '良渚暖村一区草坪', '免费入场'))
        dated = dict(self.article, title='杭州10月23日至25日秋日市集')
        self.assertEqual(weekend.outing_info(dated)['end'], '2026-10-25')
        self.assertNotIn('end', weekend.outing_info(self.article, '发布时间：2026年10月19日\n本次市集欢迎大家参加'))

    def test_roundups_and_different_event_dates_do_not_get_a_false_end_date(self):
        info = weekend.outing_info(self.article, '活动时间：10月20日至21日\n活动时间：10月24日至25日\n活动地点：良渚草坪\n活动地点：武林广场')
        self.assertNotIn('end', info)
        self.assertNotIn('venue', info)
        self.assertNotIn('end', weekend.outing_info(self.article, '活动时间：10月24日10:00至10月25日18:00'))
        self.assertNotIn('end', weekend.outing_info(self.article, '活动时间：2月30日至31日'))

    def test_single_prose_range_and_end_only_notice_preserve_uncertainty(self):
        info = weekend.outing_info(self.article, '本次秋日市集10月23日至25日在良渚举办，欢迎参加。')
        self.assertEqual(info['end'], '2026-10-25')
        until = weekend.outing_info(self.article, '本次市集将持续至10月20日，线下有多个展区。')
        self.assertEqual(until['until'], '2026-10-20')
        self.assertNotIn('start', until)
        self.assertNotIn('end', until)
        self.assertTrue(weekend.valid_info(until))
        self.assertFalse(weekend.valid_info({'type': 'market', 'until': 'bad'}))

    def test_relative_weekend_stays_with_publication_week_including_sunday(self):
        friday = dict(self.article, title='杭州本周末市集清单', publishedAt='2026-10-16T02:00:00Z')
        info = weekend.outing_info(friday)
        self.assertEqual((info['start'], info['end']), ('2026-10-17', '2026-10-18'))
        friday['publishedAt'] = '2026-10-18T02:00:00Z'
        self.assertEqual(weekend.outing_info(friday)['start'], '2026-10-17')
        self.assertEqual(tuple(map(str, weekend.weekend_days(self.now))), ('2026-10-24', '2026-10-25'))

    def test_cross_year_and_explicit_old_year_are_not_rewritten_as_current(self):
        article = dict(self.article, publishedAt='2026-12-20T02:00:00Z')
        info = weekend.outing_info(article, '展期：2026年12月28日至2027年1月3日')
        self.assertEqual((info['start'], info['end']), ('2026-12-28', '2027-01-03'))
        old = weekend.outing_info(self.article, '活动日期：2025年10月24日至25日')
        self.assertEqual(old['end'], '2025-10-25')
        self.assertFalse(weekend.valid_info({'type': 'culture', 'end': 'bad-date'}))
        calendar = weekend.outing_info(dict(self.article, title='杭州12月话剧演出时间安排'))
        self.assertEqual(calendar['month'], '2026-12')
        self.assertNotIn('start', calendar)

    def test_daily_search_is_once_per_0900_and_1600_beijing_slot(self):
        # Friday 16:00 through Saturday morning, afternoon and Sunday morning.
        previous = {'searchedAt': '2026-10-23T08:00:00Z', 'revision': 'v1'}
        for stamp, due in [('2026-10-24T00:59:59Z', False),
                           ('2026-10-24T01:00:00Z', True)]:
            with self.subTest(stamp=stamp):
                self.assertEqual(weekend.search_due(weekend.news.parse_date(stamp), previous, 'v1'), due)
        morning = {**previous, 'searchedAt': '2026-10-24T01:03:00Z'}
        for stamp, due in [('2026-10-24T01:17:00Z', False),
                           ('2026-10-24T07:59:59Z', False),
                           ('2026-10-24T08:00:00Z', True)]:
            with self.subTest(stamp=stamp):
                self.assertEqual(weekend.search_due(weekend.news.parse_date(stamp), morning, 'v1'), due)
        evening = {**previous, 'searchedAt': '2026-10-24T08:12:00Z'}
        for stamp, due in [('2026-10-24T16:00:00Z', False),
                           ('2026-10-25T00:59:59Z', False),
                           ('2026-10-25T01:00:00Z', True)]:
            with self.subTest(stamp=stamp):
                self.assertEqual(weekend.search_due(weekend.news.parse_date(stamp), evening, 'v1'), due)
        # Delayed hourly runs catch up; failed/malformed searches remain retryable.
        self.assertTrue(weekend.search_due(weekend.news.parse_date('2026-10-24T11:00:00Z'), previous, 'v1'))
        self.assertTrue(weekend.search_due(self.now, {'searchedAt': 'invalid'}, 'v1'))
        self.assertTrue(weekend.search_due(self.now, {}, 'v1'))
        self.assertTrue(weekend.search_due(self.now, previous, 'v2'))

    def test_failed_lookup_keeps_cached_verified_details_and_limits_work(self):
        prior = dict(self.article, outing={'type': 'market', 'start': '2026-10-23', 'end': '2026-10-25',
                                         'when': '10月23日至25日', 'checkedAt': '2026-10-16T02:00:00Z'})
        items = [dict(self.article, id=str(i)) for i in range(30)]
        items[0]['id'] = prior['id']
        calls = []
        def failed(url):
            calls.append(url)
            raise TimeoutError()
        weekend.enrich(items, [prior], self.now, failed)
        self.assertEqual(items[0]['outing']['end'], '2026-10-25')
        self.assertEqual(items[0]['outing']['checkedAt'], '2026-10-16T02:00:00Z')
        self.assertEqual(len(calls), 24)
        weekend.enrich(items[:1], items[:1], self.now, failed)
        self.assertEqual(len(calls), 24)

    def test_expired_cancelled_and_old_undated_results_are_removed(self):
        def item(key, info, **extra):
            return dict(self.article, id=key, title='杭州出游消息'+key, url='https://example.com/'+key, outing=info, **extra)
        items = [item('ended', {'type': 'market', 'start': '2026-10-16', 'end': '2026-10-18'}),
                 item('weekend', {'type': 'market', 'start': '2026-10-24', 'end': '2026-10-25'}),
                 item('cancelled', {'type': 'culture', 'cancelled': True}),
                 item('old-news', {'type': 'culture'}, publishedAt='2026-10-01T00:00:00Z'),
                 item('walk', {'type': 'outdoor'}, publishedAt='2026-10-08T00:00:00Z'),
                 item('future', {'type': 'culture', 'start': '2026-11-01', 'end': '2026-11-05'}),
                 dict(item('concert', {'type': 'culture', 'start': '2026-10-24', 'end': '2026-10-25'}), title='杭州本周末演唱会'),
                 dict(item('fan-show', {'type': 'culture'}), title='杭州歌友会演出预告')]
        self.assertEqual([a['id'] for a in weekend.select_articles(items, self.now)], ['weekend', 'future', 'walk'])

    def test_new_reports_precede_older_dated_events_without_changing_their_dates(self):
        older = dict(self.article, id='older', title='乌镇戏剧节舞台介绍',
                     publishedAt='2026-10-18T01:00:00Z',
                     outing={'type': 'culture', 'start': '2026-10-15', 'end': '2026-10-25',
                             'checkedAt': '2026-10-19T04:00:00Z'})
        newer = dict(self.article, id='newer', title='杭州新展览消息',
                     url='https://example.com/new-exhibition',
                     publishedAt='2026-10-19T03:00:00Z', outing={'type': 'culture'})
        selected = weekend.select_articles([older, newer], self.now)
        self.assertEqual([a['id'] for a in selected], ['newer', 'older'])
        self.assertEqual(selected[1]['publishedAt'], '2026-10-18T01:00:00Z')
        self.assertEqual(selected[1]['outing']['end'], '2026-10-25')

    def test_four_outing_types_put_camping_first_and_fold_legacy_categories(self):
        examples = {'market': '杭州咖啡市集', 'culture': '杭州话剧演出', 'outdoor': '安吉山野徒步',
                    'camping': '安吉周末露营市集'}
        for kind, title in examples.items():
            self.assertTrue(weekend.news.is_hangzhou_local(title))
            self.assertEqual(weekend.outing_info(dict(self.article, title=title))['type'], kind)
        for title, kind in [('杭州非遗手作工作坊', 'culture'), ('杭州城市漫游夜游路线', 'outdoor'),
                            ('杭州飞盘运动体验', 'outdoor')]:
            self.assertEqual(weekend.outing_info(dict(self.article, title=title))['type'], kind)

    def test_cached_camping_keeps_verified_dates_when_reclassified(self):
        old = dict(self.article, title='杭州露营节', outing={'type': 'outdoor', 'start': '2026-10-24',
                   'end': '2026-10-25', 'attemptedAt': weekend.news.iso(self.now)})
        article = dict(old)
        weekend.enrich([article], [old], self.now, lambda u: self.fail('fresh cache must not refetch'))
        self.assertEqual(article['outing']['type'], 'camping')
        self.assertEqual(article['outing']['end'], '2026-10-25')

    def test_camping_survives_busy_list_and_excludes_private_recaps(self):
        articles = [dict(self.article, id=str(i), title='杭州新展览'+str(i),
                         url='https://example.com/'+str(i), outing={'type': 'culture'}) for i in range(60)]
        camp = dict(self.article, id='camp', title='安吉营地开放与预约指南', publishedAt='2026-10-10T02:00:00Z',
                    url='https://example.com/camp', outing={'type': 'camping'})
        noise = [dict(self.article, id='bad'+str(i), title=title, outing={'type': 'culture'}) for i, title in enumerate([
            '杭州市笕和幼儿园举行亲子毅行秋游活动', '平安家族办公室服务周年庆暨公益音乐会在杭州举行',
            '从乌镇戏剧节看长期主义的落地实验', '11天上演74场中外好戏 乌镇戏剧节曲终韵长', '杭州露营产业规模增长'])]
        selected = weekend.select_articles(articles + [camp] + noise, self.now)
        self.assertEqual(len(selected), 48)
        self.assertIn('camp', [a['id'] for a in selected])
        self.assertFalse(any(a['id'].startswith('bad') for a in selected))
        self.assertEqual(selected[-1]['id'], 'camp')

    def test_camping_search_includes_opening_notices_without_weekend_keyword(self):
        urls = []
        source = {'id': 'camp', 'category': 'local', 'titleFilter': 'hangzhou-camping',
                  'url': 'https://news.google.com/rss/search?q=杭州+露营+when:14d'}
        weekend.search_weekend([source], self.now, lambda url: urls.append(url) or b'<rss><channel/></rss>')
        query = weekend.parse_qs(weekend.urlsplit(urls[0]).query)['q'][0]
        self.assertIn('when:21d', query)
        self.assertNotIn('本周末', query)

    def test_scenic_camping_headline_requires_body_evidence(self):
        candidate = dict(self.article, title='大杭州三处旷野，周末直接冲',
                         sourceId='gnews-hangzhou-camping', outing={'type': 'outdoor'})
        self.assertEqual(weekend.select_articles([candidate], self.now), [])
        weekend.enrich([candidate], [], self.now, lambda url: '安屿露营公园一期已经对外开放，可预约自驾营位。\n另有附近市集，活动时间：10月24日至11月22日\n活动地点：市集草坪')
        self.assertEqual(candidate['outing']['type'], 'camping')
        self.assertNotIn('end', candidate['outing'])
        self.assertNotIn('venue', candidate['outing'])
        self.assertEqual(weekend.select_articles([candidate], self.now), [candidate])
        unsupported = dict(self.article, title='杭州周末公园游玩攻略', sourceId='gnews-hangzhou-camping')
        weekend.enrich([unsupported], [], self.now, lambda url: '这里介绍花园和室内书店，没有营地信息。')
        self.assertEqual(weekend.select_articles([unsupported], self.now), [])

    def test_duplicate_event_reports_and_old_undated_echoes_do_not_fill_the_list(self):
        known = dict(self.article, id='known', title='杭州良渚文创市集', outing={'type': 'market', 'until': '2026-10-18'})
        old = dict(self.article, id='echo', title='好逛！良渚文创市集', publishedAt='2026-10-17T02:00:00Z', outing={'type': 'market'})
        newer = dict(self.article, id='new', title='良渚文创市集下周安排', url='https://example.com/new', outing={'type': 'market'})
        duplicate = dict(newer, id='duplicate', title='周末良渚文创集市安排', url='https://example.com/duplicate')
        selected = weekend.select_articles([known, old, newer, duplicate], self.now)
        self.assertEqual([a['id'] for a in selected], ['new'])

    def test_changed_markup_keeps_known_date_and_main_body_excludes_related_events(self):
        old = dict(self.article, outing={'type': 'market', 'start': '2026-10-24', 'end': '2026-10-25'})
        article = dict(self.article)
        weekend.enrich([article], [old], self.now, lambda url: '源站暂时仅显示一个介绍，未解析出新的活动日期。')
        self.assertEqual(article['outing']['end'], '2026-10-25')
        html = '<div class="zhengwen"><p>活动时间：10月24日至25日</p><p>' + '杭州秋日市集欢迎市民游客参与。' * 8 + '</p></div><aside>活动时间：10月1日至7日</aside>'
        info = weekend.outing_info(self.article, weekend.Text(html).text)
        self.assertEqual(info['end'], '2026-10-25')


if __name__ == '__main__':
    unittest.main()
