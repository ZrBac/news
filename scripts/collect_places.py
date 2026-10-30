#!/usr/bin/env python3
"""Refresh dated news for curated outdoor places; never infer live opening status."""
import argparse
import concurrent.futures
import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

import collect_news as news
from collect_weekend import fetch_page, search_due

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'outdoor-place-news-v2'
DOMAINS = ('hangzhou.com.cn', 'hangzhou.gov.cn', 'yuhang.gov.cn', 'linan.gov.cn',
           'zjol.com.cn', 'tidenews.com.cn', 'eyh.cn', 'bendibao.com', 'huzhou.gov.cn',
           'hzsc.com.cn', 'hzxh.gov.cn', 'xsnet.cn', 'cst123.cn', 'lanews.com.cn')
TOPICS = {
    'hiking': r'登山|徒步|步道|古道|山路|封山|闭园|开放|限流|预约|赏秋|红叶|银杏|登高|路线|杜鹃|维修|施工|暂停|关闭|恢复',
    'camping': r'露营|营地|用火|卡式炉|停车|预约|营业|开放|暂停|关闭|恢复',
    'cycling': r'骑行|骑游|单车|绿道|自行车|禁骑|封闭|绕行|交通管制|维修|施工|暂停|关闭|恢复',
}
NOISE = re.compile(r'演唱会|歌友会|博物馆|博物院|美术馆|招商|签约|出让|拿地|土拍|楼盘|户型|开盘|销量|财报|概念股|电动自行车|招聘|圆满(?:举办|结束|落幕)|行业报告|市场规模|鸣枪开跑|活动回顾|研学回顾|摄影回顾')


def fetch_feed(url):
    request = Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)',
                                    'Accept': 'application/rss+xml,application/xml'})
    with urlopen(request, timeout=8) as response:
        data = response.read(1_000_001)
    if len(data) > 1_000_000:
        raise ValueError('Oversized RSS response')
    return data


def trusted_publisher(url):
    if not news.safe_url(url):
        return False
    host = (urlsplit(url).hostname or '').lower()
    return any(host == domain or host.endswith('.' + domain) for domain in DOMAINS)


def parse_feed(body, now):
    root = ET.fromstring(body)
    if root.tag != 'rss' or root.find('channel') is None:
        raise ValueError('Expected an RSS feed, not an error page')
    result = []
    for entry in root.findall('./channel/item')[:100]:
        title = news.plain(entry.findtext('title') or '')[:240]
        url = news.safe_url(entry.findtext('link'))
        published = news.parse_date(entry.findtext('pubDate'))
        publisher = entry.find('source')
        if (not title or not url or not published or publisher is None
                or not trusted_publisher(publisher.get('url', ''))
                or not now - timedelta(days=30) <= published <= now + timedelta(minutes=10)):
            continue
        result.append({'title': title, 'url': url, 'publishedAt': news.iso(published),
                       'publisher': news.plain(publisher.text or '')[:60]})
    return result


def matches(place, item, now):
    if not isinstance(item, dict):
        return False
    title = str(item.get('title', '')).rsplit(' - ', 1)[0]
    published = news.parse_date(item.get('publishedAt'))
    evidence = item.get('placeEvidence', {}).get(place['id'], {})
    body_match = (evidence.get('alias') in place['aliases'] and evidence.get('group') == place['group']
                  and news.parse_date(evidence.get('checkedAt')))
    return bool(news.safe_url(item.get('url')) and published
                and now - timedelta(days=30) <= published <= now + timedelta(minutes=10)
                and (body_match or (any(alias.casefold() in title.casefold() for alias in place['aliases'])
                                    and re.search(TOPICS[place['group']], title)))
                and not NOISE.search(title))


def select(place, items, now):
    seen, result = set(), []
    for item in sorted((a for a in items if matches(place, a, now)), key=lambda a: a['publishedAt'], reverse=True):
        key = re.sub(r'\W', '', item['title'].rsplit(' - ', 1)[0]).casefold()
        url = news.publisher_url(item.get('originalUrl')) or item['url']
        if key in seen or url in seen:
            continue
        seen.update((key, url))
        clean = {key: item[key] for key in ('title', 'url', 'publishedAt')}
        clean['publisher'] = str(item.get('publisher') or '去处已收录来源')[:60]
        original = news.publisher_url(item.get('originalUrl'))
        if original:
            clean['originalUrl'] = original
        if item.get('placeEvidence'):
            clean['placeEvidence'] = item['placeEvidence']
        result.append(clean)
        if len(result) == 2:
            break
    return result


def query_url(places):
    aliases = list(dict.fromkeys(alias for place in places for alias in place['aliases']))
    names = '(' + ' OR '.join('"' + name + '"' for name in aliases) + ')'
    topic = {'hiking': '(登山 OR 徒步 OR 山路 OR 古道 OR 封山 OR 登高)',
             'camping': '(露营 OR 营地 OR 用火 OR 预约)',
             'cycling': '(骑行 OR 骑游 OR 绿道 OR 禁骑 OR 交通管制)'}[places[0]['group']]
    # Keep the query short enough for RSS search. Enforce publisher domains on
    # the returned source field, not via a long OR list that dilutes the query.
    region = '(杭州 OR 湖州)' if places[0]['group'] != 'camping' else ''
    query = f'{names} {topic} {region} when:30d'
    return 'https://news.google.com/rss/search?' + urlencode({'q': query, 'hl': 'zh-CN', 'gl': 'CN', 'ceid': 'CN:zh-Hans'})


def enrich(places, items, previous, now, get_page=fetch_page):
    known = {a['url']: a.get('placeEvidence', {}) for a in previous}
    for item in items:
        item['placeEvidence'] = {**known.get(item['url'], {}), **item.get('placeEvidence', {})}
    by_url = {item.get('originalUrl') or item['url']: item for item in items
              if not NOISE.search(item['title']) and re.search(r'登山|徒步|登高|古道|路线|骑行|骑游|绿道|露营|营地|周末|攻略|旷野|出游|交通管理|交通管制|通告|封闭|开放|桃花源|赏秋|打卡|走读', item['title'])}
    queue = [item for url, item in by_url.items() if news.publisher_url(url) and not item['placeEvidence']
             and not any(matches(place, item, now) for place in places if place['aliases'] and place['group'] in TOPICS)]
    queue.sort(key=lambda a: a['publishedAt'], reverse=True)
    deadline = time.monotonic() + 20
    def run(item):
        if time.monotonic() >= deadline:
            return
        try:
            body = get_page(item.get('originalUrl') or item['url'])[:16000]
        except Exception:
            return
        for place in places:
            if place['group'] not in TOPICS or not place['aliases']:
                continue
            for alias in place['aliases']:
                # Evidence must be in the same small passage as the place,
                # not in a page-wide navigation or an unrelated roundup section.
                passages = re.findall(r'[^\n。]{0,100}' + re.escape(alias) + r'[^\n。]{0,100}', body, re.I)
                if any(re.search(TOPICS[place['group']], passage) for passage in passages):
                    item['placeEvidence'][place['id']] = {'alias': alias, 'group': place['group'], 'checkedAt': news.iso(now)}
                    break
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(run, queue[:16]))
    # Copies of the same report may have appeared in several search batches.
    evidence = {item['url']: item['placeEvidence'] for item in by_url.values()}
    for item in items:
        item['placeEvidence'].update(evidence.get(item['url'], {}))


def refresh(places, previous, candidates, now, get=fetch_feed, resolve=news.resolve_original_links, force=False, get_page=fetch_page):
    prior = previous.get('places', {}) if isinstance(previous, dict) else {}
    records, pending = {}, []
    for place in places:
        if not place['aliases'] or place['group'] not in TOPICS:
            continue
        old = prior.get(place['id'], {})
        record = {k: old[k] for k in ('searchedAt', 'attemptedAt', 'status', 'revision') if k in old}
        record['items'] = select(place, old.get('items', []) + candidates, now)
        records[place['id']] = record
        revision = hashlib.sha256((REVISION + json.dumps([place['aliases'], place['group'], DOMAINS], ensure_ascii=False)).encode()).hexdigest()[:12]
        if force or search_due(now, record, revision):
            pending.append((place, revision))

    # At most four places per feed; no network calls from the reader's browser.
    batches = []
    for group in TOPICS:
        selected = [pair for pair in pending if pair[0]['group'] == group]
        batches.extend(selected[i:i + 4] for i in range(0, len(selected), 4))
    def search(batch):
        try:
            return batch, parse_feed(get(query_url([p for p, _ in batch])), now), True
        except Exception:
            return batch, [], False
    collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for batch, items, ok in pool.map(search, batches):
            collected.extend(items)
            for place, revision in batch:
                record = records[place['id']]
                record.update(attemptedAt=news.iso(now), status='ok' if ok else 'unavailable')
                if ok:
                    record.update(searchedAt=news.iso(now), revision=revision)
                    record['items'] = select(place, record['items'] + items, now)
                # Failure never advances searchedAt or removes recent cached reports.

    # Recheck named places inside scenic/notice headlines using the publisher's
    # main body. No AI-generated facts or automatic business-rule changes.
    all_items = [item for record in records.values() for item in record['items']] + collected + [dict(item) for item in candidates]
    old_items = [item for record in prior.values() for item in record.get('items', [])]
    resolve(all_items, old_items, limit=16, budget=12)
    if pending:
        enrich(places, all_items, old_items, now, get_page)
    for place in places:
        if place['id'] in records:
            records[place['id']]['items'] = select(place, all_items, now)
    return {'schema': 1, 'checkedAt': news.iso(now), 'places': records}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous-url')
    parser.add_argument('--force-search', action='store_true')
    args = parser.parse_args()
    path = ROOT / 'news/data/news.json'
    data = json.loads(path.read_text())
    old = json.loads(news.fetch(args.previous_url).decode('utf-8')) if args.previous_url else data
    places = json.loads((ROOT / 'news/places.json').read_text())['places']
    candidates = data.get('weekendArticles', []) + [a for a in data.get('articles', []) if a.get('category') == 'local']
    data['placeUpdates'] = refresh(places, old.get('placeUpdates', {}), candidates, datetime.now(news.UTC), force=args.force_search)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    records = data['placeUpdates']['places']
    print(json.dumps({'places': len(records), 'withRecentNews': sum(bool(p['items']) for p in records.values()),
                      'unavailable': sum(p.get('status') == 'unavailable' for p in records.values())}))


if __name__ == '__main__':
    main()
