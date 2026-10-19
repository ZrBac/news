#!/usr/bin/env python3
"""Prepare recent Hangzhou outings and a Friday search, without a model API."""
import argparse
import concurrent.futures
import functools
import hashlib
import json
import re
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

import collect_news as news

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    'market': r'市集|集市|夜市|早市|庙会|生活节|美食节|咖啡节|啤酒节|游园会',
    'family': r'亲子|遛娃|手作|手工|工作坊|非遗体验|社教|读书会|阅读会|讲座|体验课|研学|沙龙|科普',
    'culture': r'展览|特展|新展|看展|博物馆|艺术|摄影展|书画|演出|演唱会|音乐|戏剧|话剧|脱口秀|放映|电影节|漫展|文博会|宠物展|花展|车展|书展|茶博会',
    'sport': r'运动体验|观赛|赛事|飞盘|桨板|皮划艇|攀岩',
    'outdoor': r'露营|营地|徒步|登山|骑行|绿道|赏秋|赏桂|赏花|晒秋|银杏|红叶|花海|观鸟|采摘|温泉|秋游',
    'city': r'夜游|灯光|喷泉|灯会|烟花|City\s*Walk|城市漫游|公园|街区',
}
LABEL = r'(?:活动时间|活动日期|举办时间|市集时间|展览时间|展出时间|演出时间|展期|时间安排)\s*[：:]?\s*'
DAY = r'(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?'
DATE_RANGE = re.compile(DAY + r'\s*[-—–~～至到]\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})[日号]?')


class Text(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.parts, self.main, self.skip, self.depth = [], [], 0, 0
        self.feed(body)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        root = tag == 'article' or attrs.get('id', '').lower() in ('content', 'article-content', 'artibody', 'zoom', 'article') or bool(
            set(attrs.get('class', '').split()) & {'article-content', 'article_content', 'art_content', 'content-body', 'article-body', 'zhengwen', 'zw'})
        if self.depth and tag not in ('br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr'):
            self.depth += 1
        elif root and not self.main:
            self.depth = 1
        if tag in ('script', 'style', 'nav', 'footer'):
            self.skip += 1
        if tag in ('p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'td') and not self.skip:
            self.parts.append('\n')
            if self.depth:
                self.main.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer'):
            self.skip = max(0, self.skip - 1)
        if self.depth and tag not in ('br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr'):
            self.depth -= 1

    def handle_data(self, text):
        if not self.skip:
            self.parts.append(text)
            if self.depth:
                self.main.append(text)

    @property
    def text(self):
        parts = self.main if len(''.join(self.main).strip()) > 80 else self.parts
        return '\n'.join(re.sub(r'\s+', ' ', line).strip() for line in ''.join(parts).splitlines() if line.strip())


def weekend_days(now):
    today = now.astimezone(news.BEIJING).date()
    saturday = today - timedelta(days=today.weekday()) + timedelta(days=5)
    return saturday, saturday + timedelta(days=1)


def infer_day(year, month, day, published):
    if year:
        return date(int(year), int(month), int(day))
    choices = []
    for y in (published.year - 1, published.year, published.year + 1):
        try:
            choices.append(date(y, int(month), int(day)))
        except ValueError:
            pass
    if not choices:
        raise ValueError('Invalid date')
    return min(choices, key=lambda d: abs((d - published).days))


def outing_info(article, body=''):
    title = article['title'].rsplit(' - ', 1)[0]
    published = news.parse_date(article['publishedAt']).astimezone(news.BEIJING).date()
    info = {'type': next((key for key, pattern in GROUPS.items() if re.search(pattern, title, re.I)), 'city')}
    calendar = re.search(r'(?:(\d{4})年)?(\d{1,2})月.{0,20}(?:日历|时间安排|活动安排)', title)
    if calendar:
        try:
            info['month'] = infer_day(calendar[1], calendar[2], 1, published).isoformat()[:7]
        except ValueError:
            pass
    if re.search(r'取消|延期|暂停|闭园|闭馆', title):
        info['cancelled'] = True
    text = body or title + '\n' + article.get('excerpt', '')
    title_periods = list(DATE_RANGE.finditer(title))
    if len(title_periods) == 1 and not re.search(r'汇总|合集|盘点|清单', title):
        text += '\n活动时间：' + title_periods[0][0]
    if body and not re.search(LABEL, text):
        ranges = {m[0] for m in DATE_RANGE.finditer(text[:6000])}
        # A single explicit range in an activity's main body is useful evidence.
        # Several different ranges in a roundup remain unassigned.
        if len(ranges) == 1:
            text += '\n活动时间：' + next(iter(ranges))
    periods = []
    for match in re.finditer(LABEL + r'([^\n]{3,100})', text):
        phrase = match[1].strip()
        found = DATE_RANGE.search(phrase)
        try:
            if found:
                y, m, d, ey, em, ed = found.groups()
                start = infer_day(y, m, d, published)
                end = date(int(ey or start.year) + (not ey and int(em or m) < int(m)), int(em or m), int(ed))
                when = found[0]
            else:
                single = re.match(DAY, phrase)
                until = re.match(r'(?:即日|今日|即日起|今天)(?:起)?\s*至\s*' + DAY, phrase)
                if until:
                    start, end = published, infer_day(*until.groups(), published)
                    when = until[0]
                elif single and len(re.findall(DAY, phrase)) == 1:
                    start = end = infer_day(*single.groups(), published)
                    when = single[0]
                else:
                    continue
            if start <= end and (end-start).days <= 366:
                periods.append((start.isoformat(), end.isoformat(), when[:45]))
        except ValueError:
            continue
    unique = {(start, end) for start, end, _ in periods}
    if len(unique) == 1:
        info.update(start=periods[0][0], end=periods[0][1], when=periods[0][2])
    elif not unique and re.search(r'本周末|这个周末', title):
        start = published - timedelta(days=published.weekday()) + timedelta(days=5)
        info.update(start=start.isoformat(), end=(start + timedelta(days=1)).isoformat(), when='报道所指的本周末')
    if not unique and 'end' not in info:
        deadlines = set()
        for match in re.finditer(r'(?:活动|市集|展览|特展|展出)?(?:将)?(?:持续|延续)(?:至|到)\s*' + DAY, text):
            try:
                deadlines.add(infer_day(*match.groups(), published).isoformat())
            except ValueError:
                pass
        if len(deadlines) == 1:
            info['until'] = next(iter(deadlines))
    for key, labels in (('venue', '活动地点|市集地点|展览地点|演出地点'), ('cost', '门票价格|活动费用|票价')):
        values = set(re.findall(fr'(?:{labels})\s*[：:]\s*([^\n]{{2,70}})', text))
        if len(values) == 1:
            info[key] = next(iter(values))[:70]
    # Roundups with several dates deliberately have no single inferred end date.
    return info


def valid_info(info):
    if not isinstance(info, dict) or info.get('type') not in GROUPS:
        return False
    try:
        if 'until' in info:
            date.fromisoformat(info['until'])
        if 'month' in info:
            date.fromisoformat(info['month'] + '-01')
        return not ('start' in info or 'end' in info) or (
            date.fromisoformat(info['start']) <= date.fromisoformat(info['end'])
            and (date.fromisoformat(info['end']) - date.fromisoformat(info['start'])).days <= 366)
    except (ValueError, KeyError, TypeError):
        return False


def search_due(now, previous, revision):
    last = news.parse_date(previous.get('searchedAt'))
    if not last or previous.get('revision') != revision:
        return True
    local = now.astimezone(news.BEIJING)
    due = (local - timedelta(days=(local.weekday()-4) % 7)).replace(hour=16, minute=0, second=0, microsecond=0)
    if local < due:
        due -= timedelta(days=7)
    return last < due


def search_weekend(sources, now, get=news.fetch):
    start, end = weekend_days(now)
    dates = f'(本周末 OR 周末 OR {start.month}月{start.day}日 OR {end.month}月{end.day}日)'
    def run(source):
        query = parse_qs(urlsplit(source['url']).query)['q'][0]
        query = re.sub(r'when:\d+d', '', query) + ' ' + dates + ' when:14d'
        url = 'https://news.google.com/rss/search?' + urlencode({'q': query, 'hl': 'zh-CN', 'gl': 'CN', 'ceid': 'CN:zh-Hans'})
        try:
            items = news.parse_feed(get(url), source, now)
            return items, {'id': source['id'], 'status': 'ok', 'count': len(items)}
        except Exception:
            return [], {'id': source['id'], 'status': 'unavailable', 'count': 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run, sources))
    return [a for items, _ in results for a in items], [s for _, s in results]


def fetch_page(url):
    request = Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)'})
    with urlopen(request, timeout=7) as response:
        body = response.read(1_000_001)
    if len(body) > 1_000_000:
        raise ValueError('Oversized event page')
    charset = re.search(rb'charset\s*=\s*["\x27]?([\w-]+)', body[:3000], re.I)
    encoding = charset[1].decode('ascii') if charset else 'utf-8'
    return Text(body.decode(encoding, errors='replace')).text


def enrich(articles, previous, now, get=fetch_page, refresh=False):
    known = {a['id']: a.get('outing') for a in previous if isinstance(a, dict) and a.get('id')}
    queue = []
    for article in articles:
        old = known.get(article['id'])
        article['outing'] = dict(old) if valid_info(old) else outing_info(article)
        attempted = news.parse_date(article['outing'].get('attemptedAt'))
        if len(queue) < 24 and (refresh or not attempted or now-attempted > timedelta(days=1)):
            queue.append(article)
    cached_get = functools.lru_cache(maxsize=32)(get)
    def run(article):
        url = article.get('originalUrl', article['url'])
        article['outing']['attemptedAt'] = news.iso(now)
        if urlsplit(url).hostname in ('news.google.com', 'consent.google.com'):
            return
        try:
            info = outing_info(article, cached_get(url))
            if not any(key in info for key in ('end', 'until')):
                # Unrecognized new markup must not resurrect a previously dated event.
                for key in ('start', 'end', 'until', 'when'):
                    if key in article['outing']:
                        info[key] = article['outing'][key]
            info.update(attemptedAt=news.iso(now), checkedAt=news.iso(now))
            article['outing'] = info
        except Exception:
            pass
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(run, queue))


def event_key(article):
    title = re.sub(r'\d{4}年?|第?\d+届|\W', '', article['title'].rsplit(' - ', 1)[0])
    name = re.search(r'(.{2,4})(市集|集市|生活节|美食节|咖啡节|啤酒节|戏剧节|音乐节|艺术节)', title)
    if not name or article['outing']['type'] not in ('market', 'culture'):
        return None
    return (name[1] if name[2] in ('市集', '集市') else name[1][-2:]) + name[2].replace('集市', '市集')


def select_articles(articles, now):
    today = now.astimezone(news.BEIJING).date()
    start, end = weekend_days(now)
    expired = {}
    for article in articles:
        key = event_key(article)
        deadline = article['outing'].get('end', article['outing'].get('until'))
        if key and deadline and deadline < today.isoformat():
            expired[key] = max(expired.get(key, ''), deadline)
    selected = []
    for article in articles:
        info = article['outing']
        if info.get('cancelled') or info.get('end', info.get('until', today.isoformat())) < today.isoformat():
            continue
        pub_day = news.parse_date(article['publishedAt']).astimezone(news.BEIJING).date().isoformat()
        if not info.get('end', info.get('until')) and event_key(article) in expired and pub_day <= expired[event_key(article)]:
            continue
        age = (today - news.parse_date(article['publishedAt']).astimezone(news.BEIJING).date()).days
        if 'end' not in info and 'until' not in info and age > (21 if info['type'] == 'outdoor' else 10):
            continue
        selected.append(article)
    def priority(article):
        info = article['outing']
        deadline = info.get('end', info.get('until'))
        overlaps = info.get('start', start.isoformat()) <= end.isoformat() and (deadline or end.isoformat()) >= start.isoformat()
        rank = 0 if deadline and overlaps else 1 if deadline and deadline < start.isoformat() else 2 if not deadline else 3
        return rank, -news.parse_date(article['publishedAt']).timestamp()
    result, urls, events = [], set(), set()
    for article in sorted(selected, key=priority):
        url = article.get('originalUrl', article['url'])
        key = event_key(article)
        if url in urls or key and key in events:
            continue
        urls.add(url)
        if key:
            events.add(key)
        result.append(article)
        if len(result) == 48:
            break
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous-url')
    parser.add_argument('--input', type=Path, default=ROOT / 'news/data/news.json')
    parser.add_argument('--force-search', action='store_true')
    args = parser.parse_args()
    path = args.input
    data = json.loads(path.read_text())
    old = {}
    if args.previous_url:
        # Abort rather than silently lose a successful search or cached outings.
        old = json.loads(news.fetch(args.previous_url).decode('utf-8'))
    now = datetime.now(news.UTC)
    sources = [s for s in json.loads((ROOT / 'news/sources.json').read_text()) if s['category'] == 'local']
    revision = hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest()[:12]
    previous = old.get('weekendArticles', [])
    search = old.get('weekendGuide', {}).get('search', {})
    incoming = []
    did_search = args.force_search or search_due(now, search, revision)
    if did_search:
        incoming, results = search_weekend(sources, now)
        ok = sum(s['status'] == 'ok' for s in results)
        search = {**search, 'attemptedAt': news.iso(now), 'status': 'ok' if ok == len(sources) else 'partial' if ok else 'unavailable',
                  'results': len(incoming), 'sources': results}
        if ok:
            search.update(searchedAt=news.iso(now), revision=revision)
    allowed = {s['id']: s for s in json.loads((ROOT / 'news/sources.json').read_text())}
    pool = news.merge_articles(previous + data['articles'], incoming, now, allowed)
    candidates, seen = [], set()
    for article in pool:
        title = re.sub(r'^述评[：:]\s*', '', article['title'].rsplit(' - ', 1)[0])
        key = re.sub(r'\W', '', title).casefold()
        if article['category'] == 'local' and key not in seen:
            candidates.append(article)
            seen.add(key)
        if len(candidates) == 100:
            break
    news.resolve_original_links(candidates, previous, limit=24, budget=14)
    enrich(candidates, previous, now, refresh=did_search)
    data['weekendArticles'] = select_articles(candidates, now)
    start, end = weekend_days(now)
    data['weekendGuide'] = {'checkedAt': news.iso(now), 'weekendStart': start.isoformat(), 'weekendEnd': end.isoformat(), 'search': search}
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'outings': len(data['weekendArticles']), 'dated': sum('end' in a['outing'] for a in data['weekendArticles']),
                      'searched': did_search, 'searchStatus': search.get('status'), 'weekend': [str(start), str(end)]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
