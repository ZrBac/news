#!/usr/bin/env python3
"""Collect a single, consistent ECB reference-rate series for USD/CNY."""
import argparse
import json
import math
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
SOURCE_URL = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'
NS = '{http://www.ecb.int/vocabulary/2002-08-01/eurofxref}'
SERIES = 'ecb-usd-cny-reference-v1'


def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)'}), timeout=15) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000:
        raise ValueError('Oversized exchange data')
    return body.decode('utf-8')


def valid_point(point, today):
    try:
        day = date.fromisoformat(point['date'])
        return (point['date'] == day.isoformat() and day <= today
                and type(point['rate']) in (int, float) and math.isfinite(point['rate'])
                and 0.1 < point['rate'] < 100)
    except (ValueError, TypeError, KeyError):
        return False


def parse_ecb(xml, today):
    points = {}
    for cube in ET.fromstring(xml).iter(NS + 'Cube'):
        if 'time' not in cube.attrib:
            continue
        day = date.fromisoformat(cube.attrib['time'])
        if day > today or cube.attrib['time'] != day.isoformat():
            raise ValueError('Invalid observation date')
        if day < today - timedelta(days=59):
            continue
        quotes = {c.attrib.get('currency'): c.attrib.get('rate') for c in cube}
        try:
            usd, cny = Decimal(quotes['USD']), Decimal(quotes['CNY'])
            if not usd.is_finite() or not cny.is_finite() or not 0 < usd < 100 or not 0 < cny < 100:
                raise ValueError('Invalid ECB reference quote')
            rate = float((cny / usd).quantize(Decimal('0.000001'), rounding=ROUND_HALF_UP))
        except (KeyError, InvalidOperation, TypeError, ZeroDivisionError) as exc:
            raise ValueError('Incomplete ECB currency pair') from exc
        point = {'date': day.isoformat(), 'rate': rate}
        if not valid_point(point, today) or point['date'] in points:
            raise ValueError('Invalid or duplicated observation')
        points[point['date']] = point
    ordered = sorted(points.values(), key=lambda p: p['date'])
    # The official 90-day file should cover the requested month, not a single quote.
    if len(ordered) < 20 or (date.fromisoformat(ordered[-1]['date']) - date.fromisoformat(ordered[0]['date'])).days < 29:
        raise ValueError('Incomplete exchange history')
    return ordered


def collect(previous, now, get=fetch):
    today = now.astimezone(timezone(timedelta(hours=8))).date()
    retained = []
    if previous.get('series') == SERIES:
        retained = [p for p in previous.get('points', []) if valid_point(p, today)
                    and date.fromisoformat(p['date']) >= today - timedelta(days=59)]
    status, last_success = 'ok', previous.get('lastSuccessAt')
    try:
        incoming = parse_ecb(get(DATA_URL), today)
        if retained and incoming[-1]['date'] < max(p['date'] for p in retained):
            raise ValueError('Source returned an older snapshot')
        # A successful complete snapshot also carries official historical corrections.
        retained = incoming
        last_success = now.isoformat()
    except Exception:
        status = 'unavailable'
    points = sorted({p['date']: p for p in retained}.values(), key=lambda p: p['date'])
    return dict(series=SERIES, base='USD', quote='CNY', source='欧洲央行（ECB）参考汇率交叉换算',
                sourceUrl=SOURCE_URL, dataUrl=DATA_URL, asOfDate=today.isoformat(),
                checkedAt=now.isoformat(), lastSuccessAt=last_success, status=status, points=points)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous-url')
    args = parser.parse_args()
    seed = ROOT / 'news/exchange-rates.json'
    previous = json.loads(seed.read_text()) if seed.exists() else {}
    if args.previous_url:
        try:
            old = json.loads(fetch(args.previous_url)).get('exchangeRates')
            if old and old.get('series') == SERIES:
                previous = old
        except Exception as exc:
            raise SystemExit(f'Cannot retain previous exchange history: {exc}')
    data = collect(previous, datetime.now(timezone.utc))
    output = ROOT / 'news/data/exchange.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'exchangeStatus': data['status'], 'observations': len(data['points']),
                      'latestDate': data['points'][-1]['date'] if data['points'] else None}))


if __name__ == '__main__':
    main()
