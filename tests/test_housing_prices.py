import importlib.util
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('prices', Path(__file__).resolve().parents[1] / 'scripts/collect_housing_prices.py')
prices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prices)


class HousingPriceTests(unittest.TestCase):
    def setUp(self):
        self.today = date(2026, 10, 9)
        self.url = 'https://www.cih-index.com/report/detail/123.html'
        self.week = '''<h1>杭州房地产市场周报</h1><p>时间2026-10-08</p>
        <p>2026年9月28日-10月4日，杭州市商品住宅（不含保障性住房）成交均价为42198元/㎡；成交面积为6.73万㎡。</p>
        <p>4周移动平均：成交均价为42137.84元/㎡</p>'''
        self.month = '''<h1>杭州二手房</h1><p>2026-10-02T16:11:41+08:00</p>
        <p>杭州贝壳研究院统计，杭州市区（含富阳、临安）。</p>
        <p>9月杭州市区二手住宅网签均价为2.32万元/㎡。</p>'''

    def test_week_uses_actual_period_not_moving_average(self):
        record, = prices.parse_new(self.week, self.url, self.today)
        self.assertEqual((record['price'], record['periodStart'], record['periodEnd']), (42198, '2026-09-28', '2026-10-04'))
        self.assertFalse(prices.parse_new(self.week.replace('成交均价为42198', '挂牌均价为42198'), self.url, self.today))
        self.assertFalse(prices.parse_new(self.week.replace('2026-10-08', '2026-12-08'), self.url, self.today))
        self.assertFalse(prices.parse_new(self.week.replace('2026年9月28日-10月4日', '2026年10月8日-10月14日'), self.url, self.today))

    def test_resale_rejects_listings_and_incomplete_or_cumulative_periods(self):
        url = 'https://tidenews.com.cn/news.html?id=3576502'
        record, = prices.parse_resale(self.month, url, self.today)
        self.assertEqual((record['price'], record['periodEnd']), (23200, '2026-09-30'))
        for phrase in ['二手住宅挂牌均价', '二手住宅参考均价']:
            self.assertFalse(prices.parse_resale(self.month.replace('二手住宅网签均价', phrase), url, self.today))
        for period in ['10月', '1-9月', '1至9月']:
            self.assertFalse(prices.parse_resale(self.month.replace('9月杭州市区', period + '杭州市区'), url, self.today))
        self.assertFalse(prices.parse_resale(self.month.replace('含富阳、临安', '上城区'), url, self.today))
        self.assertFalse(prices.parse_resale(self.month, 'https://untrusted.example/story', self.today))

    def test_new_year_month_inference_and_year_specific_period(self):
        url = 'https://tidenews.com.cn/news.html?id=3576502'
        html = self.month.replace('2026-10-02', '2027-01-02').replace('9月杭州市区', '12月杭州市区')
        record, = prices.parse_resale(html, url, date(2027, 1, 5))
        self.assertEqual(record['periodEnd'], '2026-12-31')

    def test_failure_retains_previous_and_old_republication_does_not_win(self):
        record, = prices.parse_new(self.week, self.url, self.today)
        def failed(url):
            raise TimeoutError()
        incoming, status = prices.collect_kind('new', [record], self.today, failed)
        self.assertEqual(status['status'], 'unavailable')
        self.assertEqual(prices.merge_records([record] + incoming, self.today), [record])
        older = dict(record, periodStart='2026-09-14', periodEnd='2026-09-20', publishedAt='2026-10-09', price=38000)
        self.assertEqual(prices.merge_records([older, record], self.today)[0], record)

    def test_watchlist_uses_exact_project_and_allowed_publisher(self):
        now = datetime(2026, 10, 9, tzinfo=timezone.utc)
        project = {'aliases': ['云启之江', '鹭云启之江']}
        xml = '''<rss><channel><item><title>云启之江成交情况</title>
        <link>https://news.google.com/rss/articles/test</link>
        <pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate>
        <source url="https://tidenews.com.cn">潮新闻</source></item></channel></rss>'''
        stories = prices.parse_watch_feed(xml, project, now)
        self.assertEqual(len(stories), 1)
        for bad in (xml.replace('云启之江成交情况', '建发云之城成交情况'),
                    xml.replace('tidenews.com.cn', 'tidenews.com.cn.fake.example'),
                    xml.replace('08 Oct 2026', '08 Oct 2027'),
                    xml.replace('08 Oct 2026', '08 Jan 2026'),
                    xml.replace('https://news.google.com/rss/articles/test', 'javascript:alert(1)')):
            self.assertFalse(prices.parse_watch_feed(bad, project, now))
        def failed(url):
            raise TimeoutError()
        result = prices.collect_watch(project, {'stories': stories}, now, failed)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['stories'], stories)


if __name__ == '__main__':
    unittest.main()
