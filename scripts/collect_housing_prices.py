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
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CIH = 'https://www.cih-index.com/citydetail/3146b167-dcc5-4be2-9db2-47f2a6bda5b6'
HZ = 'https://hznews.hangzhou.com.cn/jingji/'
WATCH_DOMAINS = ('tidenews.com.cn', 'hangzhou.com.cn', 'zjol.com.cn', 'leju.com', 'cih-index.com', 'haofangdp.com')


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


def valid_watch_story(story, project, now):
    try:
        published = datetime.fromisoformat(story['publishedAt'].replace('Z', '+00:00'))
        publisher = urlsplit(story['publisherUrl']).hostname or ''
        url = urlsplit(story['url'])
        return (published.tzinfo is not None and now - timedelta(days=90) <= published <= now + timedelta(minutes=10)
                and any(alias in story['title'] for alias in project['aliases'])
                and any(publisher == d or publisher.endswith('.' + d) for d in WATCH_DOMAINS)
                and url.scheme == 'https' and url.hostname == 'news.google.com'
                and not url.username and not url.password)
    except (KeyError, ValueError, TypeError):
        return False


def parse_watch_feed(xml, project, now):
    stories = []
    for item in ET.fromstring(xml).findall('.//item')[:120]:
        source = item.find('source')
        if source is None:
            continue
        try:
            story = dict(title=Document(item.findtext('title') or '').text[:240],
                         url=item.findtext('link') or '', publisherUrl=source.get('url', ''),
                         source=Document(source.text or '').text[:80],
                         publishedAt=parsedate_to_datetime(item.findtext('pubDate') or '').isoformat())
            if valid_watch_story(story, project, now):
                stories.append(story)
        except (ValueError, TypeError, OverflowError):
            continue
    return stories


def collect_watch(project, previous, now, get=fetch):
    names = '(' + ' OR '.join('"' + alias + '"' for alias in project['aliases']) + ')'
    sites = '(' + ' OR '.join('site:' + domain for domain in WATCH_DOMAINS) + ')'
    url = 'https://news.google.com/rss/search?' + urlencode(dict(q=f'{project.get("queryPrefix", "")} {names} {sites} when:90d', hl='zh-CN', gl='CN', ceid='CN:zh-Hans'))
    stories = [s for s in previous.get('stories', []) if valid_watch_story(s, project, now)]
    status = 'ok'
    try:
        stories += parse_watch_feed(get(url), project, now)
    except Exception:
        status = 'unavailable'
    unique = {s['url']: s for s in stories}
    ordered = sorted(unique.values(), key=lambda s: s['publishedAt'], reverse=True)[:6]
    return dict(project, stories=ordered, checkedAt=now.isoformat(), status=status)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--previous-url')
    args = p.parse_args()
    seed = json.loads((ROOT / 'news/housing-prices.json').read_text())
    previous = seed['records'][:]
    previous_watch = {}
    previous_hotspots = {}
    if args.previous_url:
        try:
            old = json.loads(fetch(args.previous_url)).get('housingPrices', {})
            previous += old.get('records', [])
            previous_watch = {p['id']: p for p in old.get('watchlist', [])}
            previous_hotspots = old.get('xihuHotspots', {})
        except Exception as exc:
            # Prevent replacing a newer live record with the seed during an outage.
            raise SystemExit(f'Cannot retain previous prices: {exc}')
    now = datetime.now(timezone.utc)
    records = merge_records(previous, now.date())
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda k: collect_kind(k, records, now.date()), ('new', 'resale')))
    for incoming, _ in results:
        records += incoming
    projects = json.loads((ROOT / 'news/housing-watchlist.json').read_text())
    hotspots = json.loads((ROOT / 'news/xihu-hotspots.json').read_text())
    previous_watch[hotspots['id']] = previous_hotspots
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        watched = list(pool.map(lambda p: collect_watch(p, previous_watch.get(p['id'], {}), now), projects + [hotspots]))
    payload = dict(checkedAt=now.isoformat(), records=merge_records(records, now.date()),
                   sources=[s for _, s in results], watchlist=watched[:-1], xihuHotspots=watched[-1])
    output = ROOT / 'news/data/housing.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'priceSources': payload['sources'], 'records': len(payload['records'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
