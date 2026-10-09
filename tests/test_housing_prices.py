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



if __name__ == '__main__':
    unittest.main()
