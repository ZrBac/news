#!/usr/bin/env python3
"""Collect explicitly dated transaction averages from public report text.

No listing prices, inferred prices, moving averages or single-home estimates.
Retain the last known period when a source fails or changes its wording.
"""
import argparse
import calendar
import concurrent.futures
import json
import re
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CIH = 'https://www.cih-index.com/citydetail/3146b167-dcc5-4be2-9db2-47f2a6bda5b6'
HZ = 'https://hznews.hangzhou.com.cn/jingji/'


class Document(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.parts, self.links = [], []
        self.skip, self.href, self.label = 0, None, []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag in ('p', 'div', 'br', 'h1', 'h2', 'li'):
            self.parts.append(' ')
        if tag == 'a':
            self.href, self.label = dict(attrs).get('href'), []

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        if tag == 'a' and self.href:
            self.links.append((self.href, ''.join(self.label).strip()))
            self.href = None

    def handle_data(self, value):
        if not self.skip:
            self.parts.append(value)
            if self.href:
                self.label.append(value)

    @property
    def text(self):
        return re.sub(r'\s+', '', ''.join(self.parts))


def fetch(url):
    req = Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)'})
    with urlopen(req, timeout=12) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000:
        raise ValueError('Oversized price report')
    return body.decode('utf-8')


def valid_record(r, today):
    try:
        start, end = date.fromisoformat(r['periodStart']), date.fromisoformat(r['periodEnd'])
        published = date.fromisoformat(r['publishedAt'])
        url = urlsplit(r['url'])
        return (r['kind'] in ('new', 'resale') and type(r['price']) in (int, float)
                and 1000 <= r['price'] <= 300000 and start <= end <= published <= today
                and (end - start).days <= 31 and url.scheme == 'https'
                and url.hostname in ('www.cih-index.com', 'hznews.hangzhou.com.cn', 'tidenews.com.cn')
                and not url.username and not url.password
                and all(isinstance(r.get(k), str) and r[k] for k in ('scope', 'metric', 'source')))
    except (KeyError, TypeError, ValueError):
        return False


def parse_new(html, url, today):
    text = Document(html).text
    if '杭州房地产市场周报' not in text:
        return []
    published = re.search(r'时间(\d{4}-\d{2}-\d{2})', text)
    # Exact series only: exclude the separate four-week moving average below it.
    pattern = r'(\d{4})年(\d{1,2})月(\d{1,2})日[-—至](?:(\d{4})年)?(\d{1,2})月(\d{1,2})日[，,]杭州市商品住宅[（(]不含保障性住房[）)]成交均价为([\d,.]+)元/[㎡平方米²]'
    found = re.search(pattern, text)
    if not published or not found:
        return []
    y, m, d, ey, em, ed, price = found.groups()
    try:
        r = dict(kind='new', price=float(price.replace(',', '')),
                 periodStart=date(int(y), int(m), int(d)).isoformat(),
                 periodEnd=date(int(ey or y), int(em), int(ed)).isoformat(),
                 publishedAt=published[1], scope='杭州市商品住宅（不含保障性住房）',
                 metric='成交均价', source='中指云·杭州房地产市场周报', url=url)
        return [r] if valid_record(r, today) else []
    except ValueError:
        return []


def parse_resale(html, url, today):
    text = Document(html).text
    published = re.search(r'(\d{4}-\d{2}-\d{2})[T\s]?\d{2}:\d{2}', text)
    if not published or '杭州贝壳研究院' not in text or '含富阳、临安' not in text:
        return []
    # Only a complete calendar month and a city-level explicit transaction metric.
    found = re.search(r'(?<![\d\-至])(?:(\d{4})年)?(\d{1,2})月(?:杭州(?:市区|市)?)?二手住宅网签均价(?:为)?([\d,.]+)(万?)元/(?:㎡|平方米)', text)
    if not found:
        return []
    year, month, value, wan = found.groups()
    published_day = date.fromisoformat(published[1])
    year = int(year) if year else published_day.year - (int(month) > published_day.month)
    month = int(month)
    try:
        r = dict(kind='resale', price=round(float(value.replace(',', '')) * (10000 if wan else 1), 2),
                 periodStart=date(year, month, 1).isoformat(),
                 periodEnd=date(year, month, calendar.monthrange(year, month)[1]).isoformat(),
                 publishedAt=published[1], scope='杭州市区二手住宅（含富阳、临安）', metric='网签均价',
                 source='杭州贝壳研究院数据·' + ('潮新闻报道' if urlsplit(url).hostname == 'tidenews.com.cn' else '杭州网报道'), url=url)
        return [r] if valid_record(r, today) else []
    except (ValueError, calendar.IllegalMonthError):
        return []


def collect_kind(kind, records, today, get=fetch):
    index = CIH if kind == 'new' else HZ
    errors, urls = [], []
    try:
        for href, title in Document(get(index)).links:
            url = urljoin(index, href)
            if kind == 'new':
                match = urlsplit(url).hostname == 'www.cih-index.com' and re.fullmatch(r'/report/detail/\d+\.html', urlsplit(url).path) and '杭州房地产市场周报' in title
            else:
                match = urlsplit(url).hostname == 'hznews.hangzhou.com.cn' and '/jingji/content/' in url and '二手房' in title
            if match and url not in urls:
                urls.append(url)
    except Exception as exc:
        errors.append(type(exc).__name__)
    # At most four current reports plus the most recent known record, no crawling.
    urls = urls[:4]
    old = sorted((r for r in records if r['kind'] == kind), key=lambda r: (r['periodEnd'], r['publishedAt']), reverse=True)
    if old and old[0]['url'] not in urls:
        urls.append(old[0]['url'])
    incoming = []
    parser = parse_new if kind == 'new' else parse_resale
    for url in urls:
        try:
            parsed = parser(get(url), url, today)
            incoming.extend(parsed)
            if not parsed:
                errors.append('NoExplicitPrice')
        except Exception as exc:
            errors.append(type(exc).__name__)
    return incoming, {'kind': kind, 'status': 'ok' if incoming and not errors else 'partial' if incoming else 'unavailable'}


def merge_records(records, today):
    by_period = {}
    for r in records:
        if valid_record(r, today):
            key = (r['kind'], r['periodStart'], r['periodEnd'])
            if key not in by_period or r['publishedAt'] >= by_period[key]['publishedAt']:
                by_period[key] = r
    return sorted(by_period.values(), key=lambda r: (r['periodEnd'], r['publishedAt']), reverse=True)[:24]


NBS = 'https://www.stats.gov.cn/sj/zxfb/'
DISTRICTS = 'https://www.cih-index.com/data/house/hangzhou.html'
CRIC = 'https://www.haofangdp.com/fjdphz/newslist/interpretation?tags_column_id=193&page='
CRIC_REPORT = 'https://www.haofangdp.com/fjdphz/newslist/reviewconsultation?itemId=7502178807479727402'
DISTRICT_NAMES = {'萧山区', '余杭区', '拱墅区', '钱塘区', '临平区', '西湖区', '滨江区', '富阳区', '临安区', '上城区'}


def month_period(year, month):
    year, month = int(year), int(month)
    return dict(periodStart=date(year, month, 1).isoformat(),
                periodEnd=date(year, month, calendar.monthrange(year, month)[1]).isoformat())


def cells(html, row_tag='tr', cell_tag='td'):
    return [[Document(c).text for c in re.findall(fr'<{cell_tag}\b[^>]*>(.*?)</{cell_tag}>', row, re.S | re.I)]
            for row in re.findall(fr'<{row_tag}\b[^>]*>(.*?)</{row_tag}>', html, re.S | re.I)]


def valid_market(kind, value, today):
    try:
        start, end = date.fromisoformat(value['periodStart']), date.fromisoformat(value['periodEnd'])
        url = urlsplit(value['url'])
        hosts = {'official': 'www.stats.gov.cn', 'districts': 'www.cih-index.com', 'cric': 'www.haofangdp.com'}
        if not (start <= end <= today and (end-start).days <= 31 and url.scheme == 'https'
                and url.hostname == hosts[kind] and not url.username and not url.password):
            return False
        if kind != 'districts' and not end <= date.fromisoformat(value['publishedAt']) <= today:
            return False
        if kind == 'official':
            return (len(value['values']) == 2 and {v['kind'] for v in value['values']} == {'new', 'resale'}
                    and all(type(v[k]) in (int, float) and 50 <= v[k] <= 150
                            for v in value['values'] for k in ('momIndex', 'yoyIndex')))
        if kind == 'districts':
            rows = value['rows']
            return (len(rows) == 10 and {r['name'] for r in rows} == DISTRICT_NAMES
                    and all(type(r['count']) is int and 0 <= r['count'] <= 50000
                            and all(type(r[k]) in (int, float) and 0 <= r[k] <= 1000 for k in ('area', 'amount'))
                            and (r['count'] == 0 or r['area'] > 0 and r['amount'] > 0) for r in rows))
        return type(value['price']) in (int, float) and 1000 <= value['price'] <= 300000
    except (KeyError, ValueError, TypeError, OverflowError):
        return False


def parse_official(html, url, today):
    text = Document(html).text
    period = re.search(r'(\d{4})年(\d{1,2})月份70个大中城市商品住宅销售价格变动情况', text)
    published = re.search(r'(\d{4})/(\d{2})/(\d{2})\d{2}:\d{2}', text)
    if not period or not published:
        return None
    values = []
    for number, kind, name in ((1, 'new', '新建商品住宅'), (2, 'resale', '二手住宅')):
        found = None
        for table in re.finditer(r'<table\b[^>]*>.*?</table>', html, re.S | re.I):
            prefix = Document(html[max(0, table.start()-4000):table.start()]).text
            heading = fr'表{number}[：:]\d{{4}}年\d{{1,2}}月70个大中城市{name}销售价格指数'
            if not re.search(heading, prefix):
                continue
            if '环比' not in Document(table[0]).text or '同比' not in Document(table[0]).text:
                continue
            for row in cells(table[0]):
                if '杭州' in row:
                    i = row.index('杭州')
                    try:
                        found = dict(kind=kind, momIndex=float(row[i+1]), yoyIndex=float(row[i+2]))
                    except (ValueError, IndexError):
                        return None
                    break
            if found:
                break
        if not found:
            return None
        values.append(found)
    try:
        result = dict(**month_period(*period.groups()), publishedAt='-'.join(published.groups()),
                      source='国家统计局·70城住宅销售价格指数', scope='杭州·国家统计局调查口径', url=url, values=values)
        return result if valid_market('official', result, today) else None
    except ValueError:
        return None


def parse_districts(html, url, today):
    if '杭州商品住宅成交数据' not in Document(html).text:
        return None
    section = re.search(r'各区县成交排行(.*?)企业权益销售排行', html, re.S)
    if not section:
        return None
    text = Document(section[1]).text
    month = re.search(r'(\d{4})年(\d{1,2})月', text)
    if not month or not all(x in text for x in ('成交套数(套)', '成交面积(万㎡)', '成交金额(亿元)')):
        return None
    rows = []
    try:
        for row in cells(section[1], 'ul', 'li'):
            if len(row) == 5 and row[1] in DISTRICT_NAMES:
                rows.append(dict(name=row[1], count=int(row[2].replace(',', '')),
                                 area=float(row[3].replace(',', '')), amount=float(row[4].replace(',', ''))))
        result = dict(**month_period(*month.groups()), source='中指云·杭州区县成交排行',
                      scope='杭州商品住宅（不含保障性住房）·来源所列十区', url=url, rows=rows)
        return result if valid_market('districts', result, today) else None
    except ValueError:
        return None


def parse_cric(html, url, today):
    text = Document(html).text.split('THEEND')[0]
    title = re.search(r'(\d{4})年(\d{1,2})月杭州房地产市场月报', text[:300])
    published = re.search(r'克而瑞浙江区域[·•](\d{4}-\d{2}-\d{2})\d{2}:\d{2}', text)
    if not title or not published or '新房市场' not in text or '数据来源：克而瑞' not in text:
        return None
    section = text.split('新房市场', 1)[1].split('区域与板块', 1)[0].split('库存与去化', 1)[0]
    # Require current-month transaction language, excluding last month's comparison and district prices.
    month = int(title[2])
    match = re.search(fr'{month}月成交面积[\d.]+万㎡[^。；]{{0,100}}[；。]成交均价(?:为|达)?([\d,]+)元/㎡', section)
    if not match:
        match = re.search(fr'{month}月新房成交面积[\d.]+万㎡[^。]{{0,180}}?成交均价(?:为|达)?([\d,]+)元/㎡', text)
    if not match:
        return None
    try:
        result = dict(**month_period(*title.groups()), publishedAt=published[1],
                      price=float(match[1].replace(',', '')), source='克而瑞浙江区域·杭州市场月报',
                      scope='杭州新房（普通住宅、别墅）' if '统计口径：普通住宅、别墅' in text else '杭州新房·克而瑞报告口径', url=url)
        return result if valid_market('cric', result, today) else None
    except ValueError:
        return None


def collect_market(kind, previous, today, get=fetch):
    parser = {'official': parse_official, 'districts': parse_districts, 'cric': parse_cric}[kind]
    urls, errors = [], []
    if kind == 'districts':
        urls = [DISTRICTS]
    else:
        indices = [NBS] if kind == 'official' else [CRIC + '1', CRIC + '2']
        for index in indices:
            try:
                for href, title in Document(get(index)).links:
                    url = urljoin(index, href)
                    host = urlsplit(url).hostname
                    match = (host == 'www.stats.gov.cn' and '70个大中城市商品住宅销售价格变动情况' in title) if kind == 'official' else (
                        host == 'www.haofangdp.com' and re.search(r'\d{4}年\d{1,2}月杭州房地产市场月报', title)
                        and '/newslist/reviewconsultation?' in url)
                    if match and url not in urls:
                        urls.append(url)
            except Exception:
                errors.append('IndexUnavailable')
        urls = urls[:3]
        fallback = previous.get('url') or (CRIC_REPORT if kind == 'cric' else '')
        if fallback and fallback not in urls:
            urls.append(fallback)
    incoming = []
    for url in urls:
        try:
            parsed = parser(get(url), url, today)
            if parsed:
                incoming.append(parsed)
            else:
                errors.append('UnrecognizedReport')
        except Exception:
            errors.append('SourceUnavailable')
    candidates = incoming + ([previous] if valid_market(kind, previous, today) else [])
    # For the same month prefer freshly fetched data (publishers can revise statistics).
    latest = max(candidates, key=lambda r: (r['periodEnd'], r.get('publishedAt', '')), default=None)
    return latest, dict(kind=kind, status='ok' if incoming and not errors else 'partial' if incoming else 'unavailable')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--previous-url')
    args = p.parse_args()
    seed = json.loads((ROOT / 'news/housing-prices.json').read_text())
    previous = seed['records'][:]
    previous_market = seed.get('market', {}).copy()
    if args.previous_url:
        try:
            old = json.loads(fetch(args.previous_url)).get('housingPrices', {})
            previous += old.get('records', [])
            for kind, record in old.get('market', {}).items():
                if valid_market(kind, record, datetime.now(timezone.utc).date()) and record['periodEnd'] >= previous_market.get(kind, {}).get('periodEnd', ''):
                    previous_market[kind] = record
        except Exception as exc:
            # Prevent replacing a newer live record with the seed during an outage.
            raise SystemExit(f'Cannot retain previous prices: {exc}')
    now = datetime.now(timezone.utc)
    records = merge_records(previous, now.date())
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda k: collect_kind(k, records, now.date()), ('new', 'resale')))
    for incoming, _ in results:
        records += incoming
    kinds = ('official', 'districts', 'cric')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        market_results = list(pool.map(lambda k: collect_market(k, previous_market.get(k, {}), now.date()), kinds))
    payload = dict(checkedAt=now.isoformat(), records=merge_records(records, now.date()),
                   sources=[s for _, s in results], market={k: r for k, (r, _) in zip(kinds, market_results) if r},
                   marketSources=[s for _, s in market_results])
    output = ROOT / 'news/data/housing.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'priceSources': payload['sources'], 'marketSources': payload['marketSources'], 'records': len(payload['records'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
