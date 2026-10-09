import importlib.util
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
spec = importlib.util.spec_from_file_location('exchange', Path(__file__).resolve().parents[1] / 'scripts/collect_exchange_rates.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)

class ExchangeTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 9, 8, tzinfo=timezone.utc)
        cubes = []
        for n in range(45):
            d = self.now.date() - timedelta(days=n)
            if d.weekday() < 5:
                cubes.append(f'<Cube time="{d}"><Cube currency="USD" rate="1.1"/><Cube currency="CNY" rate="7.7"/></Cube>')
        self.xml = '<Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube>'+''.join(cubes)+'</Cube></Envelope>'

    def test_same_date_cross_rate_and_sorted_history(self):
        points = fx.parse_ecb(self.xml, self.now.date())
        self.assertEqual(points[-1], {'date':'2026-10-09', 'rate':7})
        self.assertEqual(points, sorted(points, key=lambda p:p['date']))
        self.assertGreaterEqual(len(points), 20)
        self.assertTrue(all(date.fromisoformat(p['date']).weekday()<5 for p in points))

    def test_incomplete_invalid_future_and_duplicate_snapshot_rejected(self):
        for xml in (self.xml.replace('rate="1.1"','rate="0"',1),self.xml.replace('rate="7.7"','rate="NaN"',1),self.xml.replace('currency="USD"','currency="EUR"',1),self.xml.replace('2026-10-09','2026-10-12',1),self.xml.replace('2026-10-08','2026-10-09',1),'<html>unavailable</html>'):
            with self.assertRaises(ValueError):fx.parse_ecb(xml,self.now.date())

    def test_failure_retains_history_but_marks_unavailable(self):
        old = fx.collect({}, self.now, lambda url:self.xml)
        def failed(url):raise TimeoutError()
        result = fx.collect(old,self.now+timedelta(days=1),failed)
        self.assertEqual(result['points'],old['points'])
        self.assertEqual(result['lastSuccessAt'],old['lastSuccessAt'])
        self.assertEqual(result['status'],'unavailable')
        self.assertEqual(result['asOfDate'],'2026-10-10')

    def test_source_regression_is_not_accepted(self):
        old = fx.collect({},self.now,lambda url:self.xml)
        older = self.xml.replace('<Cube time="2026-10-09"><Cube currency="USD" rate="1.1"/><Cube currency="CNY" rate="7.7"/></Cube>','')
        result = fx.collect(old,self.now,lambda url:older)
        self.assertEqual(result['points'],old['points'])
        self.assertEqual(result['status'],'unavailable')

    def test_three_pairs_share_one_fetch_and_isolate_missing_currency(self):
        xml = self.xml.replace('<Cube currency="USD"', '<Cube currency="JPY" rate="150"/><Cube currency="THB" rate="35"/><Cube currency="USD"')
        calls = []
        def get(url):
            calls.append(url)
            return xml
        result = fx.collect_all({}, self.now, get)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['points'][-1]['rate'], 7)
        self.assertEqual(result['currencies']['JPY']['points'][-1]['rate'], 0.051333)
        self.assertEqual(result['currencies']['THB']['points'][-1]['rate'], 0.22)
        broken = xml.replace('currency="JPY"', 'currency="GBP"', 1)
        updated = fx.collect_all(result, self.now, lambda url: broken)
        self.assertEqual(updated['status'], 'ok')
        self.assertEqual(updated['currencies']['THB']['status'], 'ok')
        self.assertEqual(updated['currencies']['JPY']['status'], 'unavailable')
        self.assertEqual(updated['currencies']['JPY']['points'], result['currencies']['JPY']['points'])

if __name__=='__main__':unittest.main()
