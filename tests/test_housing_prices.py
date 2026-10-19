import importlib.util
import unittest
from datetime import date
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

    def test_official_indices_keep_city_columns_and_reject_future_reports(self):
        url = 'https://www.stats.gov.cn/sj/zxfb/202609/t20260915_1965304.html'
        html = '''<h1>2026年8月份70个大中城市商品住宅销售价格变动情况</h1><p>2026/09/15 09:30</p>
        <p>表1：2026年8月70个大中城市新建商品住宅销售价格指数</p>
        <table><tr><td>城市</td><td>环比</td><td>同比</td><td>平均</td></tr>
        <tr><td>北 京</td><td>99.8</td><td>97.7</td><td>97.8</td><td>杭　州</td><td>100.2</td><td>102.2</td><td>102.3</td></tr></table>
        <p>表2：2026年8月70个大中城市二手住宅销售价格指数</p>
        <table><tr><td>城市</td><td>环比</td><td>同比</td></tr><tr><td>杭州</td><td>99.8</td><td>96.5</td><td>96.1</td></tr></table>'''
        result = prices.parse_official(html, url, self.today)
        self.assertEqual(result['values'], [{'kind': 'new', 'momIndex': 100.2, 'yoyIndex': 102.2}, {'kind': 'resale', 'momIndex': 99.8, 'yoyIndex': 96.5}])
        self.assertEqual(result['periodEnd'], '2026-08-31')
        for bad in (html.replace('2026/09/15', '2027/09/15'), html.replace('99.8</td><td>96.5', '--</td><td>96.5'), html.replace('表2：', '表3：')):
            self.assertIsNone(prices.parse_official(bad, url, self.today))
        self.assertIsNone(prices.parse_official(html, 'https://www.stats.gov.cn.fake.example/report', self.today))

    def test_districts_require_complete_rows_period_and_exact_units(self):
        rows = ''.join(f'<ul><li>{i}</li><li>{name}</li><li>123</li><li>1.25</li><li>4.56</li></ul>' for i, name in enumerate(sorted(prices.DISTRICT_NAMES), 1))
        html = '<h1>杭州商品住宅成交数据</h1><h2>各区县成交排行</h2><p>2026年9月</p><ul><li>成交套数(套)</li><li>成交面积(万㎡)</li><li>成交金额(亿元)</li></ul>'+rows+'<h2>企业权益销售排行</h2>'
        result = prices.parse_districts(html, prices.DISTRICTS, self.today)
        self.assertEqual(len(result['rows']), 10)
        self.assertEqual(result['rows'][0]['amount'], 4.56)
        self.assertNotIn('publishedAt', result)  # The dynamic page does not publish a report date.
        for bad in (html.replace('2026年9月', '2026年10月'), html.replace('西湖区', '杭州全市'), html.replace('成交金额(亿元)', '成交金额(万元)'), html.replace('1.25', '--')):
            self.assertIsNone(prices.parse_districts(bad, prices.DISTRICTS, self.today))

    def test_cric_reads_current_new_home_price_not_land_or_previous_month(self):
        html = '''<h1>2026年8月杭州房地产市场月报</h1><p>克而瑞浙江区域 · 2026-09-06 09:40:08</p>
        <p>土地成交楼面价8051元/㎡。统计口径：普通住宅、别墅。8月新房成交面积27.8万㎡（环比-1%），成交金额113.7亿元；成交均价40924元/㎡。</p>
        <h2>新房市场</h2><p>较7月高点（48582元/㎡）回落。滨江均价70794元/㎡。数据来源：克而瑞数据库</p>'''
        result = prices.parse_cric(html, prices.CRIC_REPORT, self.today)
        self.assertEqual(result['price'], 40924)
        self.assertEqual(result['periodEnd'], '2026-08-31')
        for bad in (html.replace('成交均价40924', '挂牌均价40924'), html.replace('8月新房成交面积', '7月新房成交面积'), html.replace('2026-09-06', '2026-12-06')):
            self.assertIsNone(prices.parse_cric(bad, prices.CRIC_REPORT, self.today))

    def test_market_discovery_failure_retention_and_no_period_regression(self):
        html = '<h1>2026年8月杭州房地产市场月报</h1><p>克而瑞浙江区域·2026-09-06 09:40:08</p><p>新房市场8月新房成交面积27.8万㎡，成交均价40924元/㎡。数据来源：克而瑞</p>'
        old = prices.parse_cric(html, prices.CRIC_REPORT, self.today)
        def failed(url):
            raise TimeoutError()
        result, status = prices.collect_market('cric', old, self.today, failed)
        self.assertEqual(result, old)
        self.assertEqual(status['status'], 'unavailable')
        current_url = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=12345'
        new_html = html.replace('8月', '9月').replace('2026-09-06', '2026-10-06').replace('40924', '41000')
        def current(url):
            if 'interpretation?' in url:
                return f'<a href="{current_url}">2026年9月杭州房地产市场月报</a>'
            return new_html if url == current_url else html
        latest, status = prices.collect_market('cric', old, self.today, current)
        self.assertEqual((latest['periodEnd'], latest['price'], status['status']), ('2026-09-30', 41000, 'ok'))
        result, _ = prices.collect_market('cric', latest, self.today, lambda u: html if 'reviewconsultation?' in u else '')
        self.assertEqual(result, latest)

    def test_cric_updated_heading_and_combined_supply_transaction_sentence(self):
        url = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=7514864418342761745'
        html = '''<h1>2026年9月杭州房地产市场月报</h1><p>克而瑞浙江区域 · 2026-10-11 09:48:07</p>
        <p>土地市场成交楼面价17629元/㎡。数据来源：克而瑞数据库</p>
        <h2>商品住宅市场</h2><p>9月新房供应46.51万㎡（环比+51.20%）、成交29.82万㎡（环比+7.36%），供求比1.56；成交金额116.79亿元；成交均价39171元/㎡（含普通住宅、别墅）。</p>
        <h2>各行政区/板块成交排名</h2><p>滨江区成交均价67255元/㎡。</p>'''
        today = date(2026, 10, 19)
        record = prices.parse_cric(html, url, today)
        self.assertEqual((record['price'], record['periodEnd']), (39171, '2026-09-30'))
        self.assertIn('普通住宅、别墅', record['scope'])
        for bad in (html.replace('成交均价39171', '挂牌均价39171'),
                    html.replace('9月新房供应', '8月新房供应'),
                    html.replace('2026-10-11', '2026-11-11'),
                    html.replace('9月新房供应', '9月二手房供应')):
            self.assertIsNone(prices.parse_cric(bad, url, today))

    def weekly_backup(self):
        return '''<h1>第40周杭州房地产市场周报（10.5-10.11）</h1>
        <p>克而瑞浙江区域 · 2026-10-15 10:26:15</p><h2>核心观点</h2>
        <p>新房成交：445套/6.11万㎡/25.24亿元，套数环比-4%；金额环比-14%。成交均价：41320元/㎡。</p>
        <h2>土地市场</h2><p>成交楼面价17629元/㎡。</p>
        <h2>新房市场</h2><p>滨江区均价78507元/㎡，望天际成交均价118028元/㎡。</p>'''

    def test_weekly_backup_keeps_explicit_week_and_city_new_home_scope(self):
        url = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=7516323544059016278'
        html = self.weekly_backup()
        today = date(2026, 10, 19)
        record, = prices.parse_weekly_backup(html, url, today)
        self.assertEqual((record['price'], record['periodStart'], record['periodEnd']),
                         (41320, '2026-10-05', '2026-10-11'))
        self.assertIn('克而瑞', record['source'])
        for bad in (html.replace('成交均价：41320', '挂牌均价：41320'),
                    html.replace('新房成交：', '二手房成交：'),
                    html.replace('10.5-10.11', '10.5-10.12'),
                    html.replace('2026-10-15', '2026-11-15'),
                    html.replace('杭州房地产市场周报', '宁波房地产市场周报')):
            self.assertFalse(prices.parse_weekly_backup(bad, url, today))
        self.assertFalse(prices.parse_weekly_backup(html, 'https://untrusted.example/story', today))
        cross_year = html.replace('10.5-10.11', '12.28-1.3').replace('2026-10-15', '2027-01-08')
        record, = prices.parse_weekly_backup(cross_year, url, date(2027, 1, 9))
        self.assertEqual((record['periodStart'], record['periodEnd']), ('2026-12-28', '2027-01-03'))

    def test_weekly_source_failure_discovers_backup_without_overwriting_price_identity(self):
        url = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=7516323544059016278'
        old, = prices.parse_new(self.week, self.url, self.today)
        calls = []
        def get(value):
            calls.append(value)
            if value == prices.CIH or value == self.url:
                raise TimeoutError()
            if 'interpretation?' in value:
                return f'<a href="{url}">第40周杭州房地产市场周报（10.5-10.11）</a>'
            return self.weekly_backup() if value == url else ''
        incoming, status = prices.collect_kind('new', [old], date(2026, 10, 19), get)
        latest = prices.merge_records([old] + incoming, date(2026, 10, 19))[0]
        self.assertEqual((latest['price'], latest['periodEnd'], latest['url']), (41320, '2026-10-11', url))
        self.assertEqual(status, {'kind': 'new', 'status': 'partial', 'usingFallback': True})
        self.assertNotIn(prices.CRIC + '2', calls)
        # A backup outage keeps the successful record and never sends its URL to the CIH parser.
        incoming, status = prices.collect_kind('new', [latest], date(2026, 10, 19), lambda value: '')
        self.assertEqual(prices.merge_records([latest] + incoming, date(2026, 10, 19)), [latest])
        self.assertEqual(status['status'], 'unavailable')

    def test_monthly_discovery_checks_beyond_page_two_and_stops_at_current_period(self):
        calls = []
        url = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=12345'
        html = '''<h1>2026年9月杭州房地产市场月报</h1><p>克而瑞浙江区域·2026-10-11 09:48:07</p>
        <p>新房市场9月新房成交面积29.82万㎡，成交均价39171元/㎡。数据来源：克而瑞</p>'''
        def get(value):
            calls.append(value)
            if value == prices.CRIC + '3':
                return f'<a href="{url}">2026年9月杭州房地产市场月报</a>'
            return html if value == url else ''
        result, status = prices.collect_market('cric', {}, date(2026, 10, 19), get)
        self.assertEqual((result['periodEnd'], result['price']), ('2026-09-30', 39171))
        self.assertEqual(calls.count(prices.CRIC + '3'), 1)
        self.assertNotIn(prices.CRIC + '4', calls)
        self.assertEqual(status['status'], 'partial')  # The fallback report could not be verified.


if __name__ == '__main__':
    unittest.main()
