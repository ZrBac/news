"""Observe public hot lists and find dated publisher reports, without model calls."""
import concurrent.futures
import copy
import hashlib
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from news_schedule import collection_gap

ROOT = Path(__file__).resolve().parents[1]
SOURCE = {'id': 'hot-discovery', 'name': '热榜补充报道', 'category': 'general',
          'home': 'https://newsnow.busiyi.world/', 'url': 'https://newsnow.busiyi.world/',
          'format': 'hot-discovery', 'color': '#8d443d'}
PUBLISHERS = ('gov.cn', 'cctv.com', 'people.com.cn', 'xinhuanet.com', 'news.cn',
              'chinanews.com.cn', 'cnr.cn', 'thepaper.cn', 'cls.cn', 'yicai.com')
UTC = timezone.utc
FRESH_HOURS = 4


def stamp(value):
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def date(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def allowed_url(value, domains):
    try:
        url = urllib.parse.urlsplit(value)
        return (url.scheme == 'https' and not url.username and not url.password
                and url.port in (None, 443) and url.hostname
                and any(url.hostname == d or url.hostname.endswith('.' + d) for d in domains))
    except (ValueError, TypeError, AttributeError):
        return False


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0',
                                                  'Accept': 'application/json, application/rss+xml, */*'})
    with urllib.request.urlopen(request, timeout=12) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000:
        raise ValueError('Hot-list response too large')
    return body


@lru_cache(maxsize=12000)
def title_key(title):
    return re.sub(r'[^\w\u4e00-\u9fff]', '', unicodedata.normalize('NFKC',
                  title.rsplit(' - ', 1)[0]).casefold()).replace('_', '')


@lru_cache(maxsize=12000)
def grams(key):
    return frozenset(key[i:i + 2] for i in range(len(key) - 1))


def matches(topic, article):
    if topic['url'] in (article.get('url'), article.get('originalUrl')):
        return True
    a, b = title_key(topic['title']), title_key(article['title'])
    if a == b:
        return len(a) >= 6
    short, long = sorted((a, b), key=len)
    if len(short) < 8:
        return False
    numbers_a, numbers_b = set(re.findall(r'\d+', short)), set(re.findall(r'\d+', long))
    if numbers_a and numbers_b and not numbers_a <= numbers_b:
        return False
    if short in long and len(short) >= 10 and len(short) / len(long) >= .35:
        return True
    ga, gb = grams(short), grams(long)
    common = len(ga & gb)
    return common >= 7 and common / len(ga) >= .85 and common / len(ga | gb) >= .5


def parse_board(payload, platform, now):
    if not isinstance(payload, dict) or payload.get('status') not in ('success', 'cache'):
        raise ValueError('Hot list unavailable')
    timestamp = payload.get('updatedTime')
    if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
        raise ValueError('Missing observation time')
    observed = datetime.fromtimestamp(timestamp / 1000, UTC)
    if not now - timedelta(hours=FRESH_HOURS) <= observed <= now + timedelta(minutes=5):
        raise ValueError('Stale or future hot list')
    if not isinstance(payload.get('items'), list):
        raise ValueError('Missing hot-list items')
    items, seen = [], set()
    for rank, row in enumerate(payload['items'][:30], 1):
        if not isinstance(row, dict):
            continue
        title, url = row.get('title'), row.get('url')
        if not isinstance(title, str) or not 4 <= len(title.strip()) <= 240 or not allowed_url(url, [platform['domain']]):
            continue
        # Social search URLs contain changing rank/tracking parameters. Topic
        # identity is independent of them; publisher article URLs are stable.
        key = title_key(title) if platform['id'] in ('baidu', 'weibo') else url
        identity = hashlib.sha256(key.encode()).hexdigest()[:16]
        if identity in seen:
            continue
        seen.add(identity)
        items.append({'id': identity, 'title': title.strip(), 'url': url, 'rank': rank})
    if not items or len(items) < min(len(payload['items'][:30]), 5) / 2:
        raise ValueError('Invalid hot-list items')
    return stamp(observed), items


def observe(previous, platform, payload, now):
    """Only a newer valid observation advances ranks, counts, or new labels."""
    previous = previous if isinstance(previous, dict) else {}
    current = copy.deepcopy(previous)
    current.update(checkedAt=stamp(now), status='unavailable')
    try:
        observed, items = parse_board(payload, platform, now)
        old_date = date(previous.get('observedAt'))
        if old_date and date(observed) < old_date:
            raise ValueError('Hot-list timestamp moved backwards')
        if old_date and date(observed) == old_date:
            current['status'] = 'ok'
            return current
        baseline = (old_date and previous.get('status') == 'ok'
                    and not collection_gap(old_date, date(observed)))
        old_items = {row['id']: row for row in previous.get('items', [])}
        history = {key: row for key, row in previous.get('history', {}).items()
                   if date(row.get('lastSeen')) and date(row['lastSeen']) >= now - timedelta(days=7)}
        for item in items:
            before = old_items.get(item['id']) if baseline else None
            known = history.get(item['id'])
            item['new'] = bool(baseline and not known)
            item['previousRank'] = before['rank'] if before else None
            history[item['id']] = {'firstSeen': known['firstSeen'] if known else observed,
                                   'lastSeen': observed, 'bestRank': min(item['rank'], known['bestRank']) if known else item['rank'],
                                   'appearances': (known['appearances'] if known else 0) + 1}
        current.update(status='ok', observedAt=observed, items=items,
                       history=dict(sorted(history.items(), key=lambda pair: pair[1]['lastSeen'], reverse=True)[:300]))
    except (ValueError, TypeError, KeyError, OverflowError, OSError):
        pass
    return current


def fresh(board, now):
    observed = date(board.get('observedAt'))
    return bool(board.get('status') == 'ok' and observed
                and -300 <= (now - observed).total_seconds() <= FRESH_HOURS * 3600)


def category(title):
    import collect_news as news
    if news.GAMING_TOPIC.search(title):
        initial = 'gaming'
    elif news.is_domestic_sports(title) or news.SPORTS_EVENT_TOPIC.search(title):
        initial = 'sports'
    elif news.ENTERTAINMENT_TOPIC.search(title):
        initial = 'entertainment'
    else:
        initial = 'general'
    return news.article_category(title, {'id': SOURCE['id'], 'category': initial})


def search_reports(topic, body, now):
    """A hot topic itself has no publication date and never becomes an article."""
    import collect_news as news
    root = ET.fromstring(body)
    if root.tag != 'rss' or root.find('channel') is None:
        raise ValueError('Invalid report search')
    found = []
    for item in root.findall('./channel/item')[:40]:
        publisher = item.find('source')
        if publisher is None or not allowed_url(publisher.get('url'), PUBLISHERS):
            continue
        title = news.plain(item.findtext('title'))[:240]
        url = news.safe_url(item.findtext('link'))
        published = news.parse_date(item.findtext('pubDate'))
        if (not title or not url or not published or not now - timedelta(hours=48) <= published <= now + timedelta(minutes=10)
                or not (allowed_url(url, PUBLISHERS) or news.GOOGLE_ARTICLE.fullmatch(url))):
            continue
        article = {'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'title': title,
                   'url': url, 'sourceId': SOURCE['id'], 'category': category(title),
                   'publishedAt': stamp(published), 'excerpt': ''}
        if article['category'] and article['category'] != 'local' and matches(topic, article):
            found.append(article)
    return sorted(found, key=lambda a: a['publishedAt'], reverse=True)[:2]


def collect(previous, articles, now, get=fetch):
    config = json.loads((ROOT / 'news/trends.json').read_text())
    previous = previous if isinstance(previous, dict) and previous.get('schema') == 1 else {}
    old_boards = previous.get('platforms', {})
    started = time.monotonic()
    def board(platform):
        try:
            payload = json.loads(get('https://newsnow.busiyi.world/api/s?id=' + platform['id'] + '&latest'))
        except Exception:
            payload = None
        return platform['id'], observe(old_boards.get(platform['id']), platform, payload, now)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        boards = dict(pool.map(board, config['platforms']))
    recent = [a for a in articles if date(a.get('publishedAt')) and now - timedelta(hours=48) <= date(a['publishedAt']) <= now]
    searches = {key: row for key, row in previous.get('searches', {}).items()
                if date(row.get('checkedAt')) and date(row['checkedAt']) >= now - timedelta(days=7)}
    queues = []
    for platform in config['platforms']:
        observed = boards[platform['id']]
        queues.append(observed.get('items', [])[:10] if fresh(observed, now) else [])
    topics, selected = [], []
    # Round-robin sources so one entertainment-heavy list cannot consume all
    # discovery queries. The same unchanged topic is searched at most every 6 h.
    for rank in range(10):
        for queue in queues:
            if rank >= len(queue):
                continue
            topic = queue[rank]
            key = hashlib.sha256(title_key(topic['title']).encode()).hexdigest()[:16]
            last = date(searches.get(key, {}).get('checkedAt'))
            cooldown = 1 if searches.get(key, {}).get('status') == 'unavailable' else 6
            if (last and now - last < timedelta(hours=cooldown)) or any(matches(topic, a) for a in recent + selected):
                continue
            selected.append(topic)
            topics.append((key, topic))
            if len(topics) >= min(6, config['maxSearches']):
                break
        if len(topics) >= min(6, config['maxSearches']):
            break
    def search(pair):
        key, topic = pair
        query = re.sub(r'[^\w\u4e00-\u9fff\s]', ' ', topic['title'])[:150] + ' when:2d'
        url = 'https://news.google.com/rss/search?' + urllib.parse.urlencode(
            {'q': query, 'hl': 'zh-CN', 'gl': 'CN', 'ceid': 'CN:zh-Hans'})
        try:
            return key, search_reports(topic, get(url), now), 'ok'
        except Exception:
            return key, [], 'unavailable'
    incoming, errors = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for key, found, status in pool.map(search, topics):
            searches[key] = {'checkedAt': stamp(now), 'status': status}
            errors += status != 'ok'
            incoming.extend(found)
    incoming = list({a['id']: a for a in incoming}.values())
    state = {'schema': 1, 'updatedAt': stamp(now), 'platforms': boards,
             'searches': dict(sorted(searches.items(), key=lambda pair: pair[1]['checkedAt'], reverse=True)[:300])}
    status = {key: SOURCE[key] for key in ('id', 'name', 'category', 'home', 'color')}
    status.update(checkedAt=stamp(now), status='ok' if any(fresh(b, now) for b in boards.values()) and not errors else 'unavailable',
                  fetchedCount=len(incoming), latestAt=max((a['publishedAt'] for a in incoming), default=None),
                  durationMs=round((time.monotonic() - started) * 1000))
    print(f'Hot lists: {sum(fresh(b, now) for b in boards.values())}/4 fresh; {len(topics)} searches; {len(incoming)} dated reports.')
    return state, incoming, status


def annotate(articles, state, now):
    """Publish compact signals only; observation history stays in the full export."""
    config = json.loads((ROOT / 'news/trends.json').read_text())
    boards = (state or {}).get('platforms', {})
    signals = []
    public = []
    for platform in config['platforms']:
        board = boards.get(platform['id'], {})
        is_fresh = fresh(board, now)
        public.append({'id': platform['id'], 'name': platform['name'],
                       'status': 'ok' if is_fresh else 'unavailable', 'observedAt': board.get('observedAt')})
        observed = date(board.get('observedAt'))
        if not observed or now - observed > timedelta(days=1):
            continue
        for item in board.get('items', []):
            signals.append((item, {'platform': platform['id'], 'name': platform['name'],
                                  'rank': item['rank'], 'previousRank': item.get('previousRank'),
                                  'new': bool(item.get('new')), 'asOf': board['observedAt'], 'stale': not is_fresh}))
    output = []
    for article in articles:
        clean = {key: value for key, value in article.items() if key != 'trend'}
        published = date(article.get('publishedAt'))
        if published and now - timedelta(hours=48) <= published <= now + timedelta(minutes=10):
            by_platform = {}
            for item, signal in signals:
                if signal['platform'] not in by_platform and matches(item, article):
                    by_platform[signal['platform']] = signal
            if by_platform:
                clean['trend'] = list(by_platform.values())
        output.append(clean)
    return output, {'schema': 1, 'platforms': public}


def score(article):
    signals = [s for s in article.get('trend', []) if not s.get('stale')]
    if not signals:
        return 0
    return max(31 - s['rank'] for s in signals) + 5 * (len(signals) - 1)
