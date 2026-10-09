#!/usr/bin/env python3
"""Collect public RSS metadata. Standard library only; never execute feed content."""
import argparse
import concurrent.futures
import hashlib
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
AI_PATTERN = re.compile(r"\b(?:AI|AGI|LLM|GPT[\w.-]*|ChatGPT|OpenAI|Anthropic|Claude|Gemini|Copilot|DeepSeek|Qwen|Llama|Codex|RAG|MCP|agents?)\b|人工智能|大模型|语言模型|生成式|机器学习|智能体|通义|智谱|豆包|具身智能|算力", re.I)

HOUSING_LOCATION = re.compile(r'杭州|余杭|萧山|临平|钱塘|拱墅|临安|富阳')
HOUSING_TOPIC = re.compile(r'楼市|房地产|房产|住房|住宅|二手房|新房|购房|买房|卖房|房价|房贷|公积金|土拍|宅地|涉宅|预售|网签|土地出让|地块成交')


def is_hangzhou_housing(title):
    # Google News appends the publisher name; “杭州网” is not story location evidence.
    title = title.rsplit(' - ', 1)[0]
    return bool(HOUSING_LOCATION.search(title) and HOUSING_TOPIC.search(title))


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag in ('p', 'br', 'div', 'li'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(html.unescape(value or ''))
    return re.sub(r'\s+', ' ', ''.join(parser.parts)).strip()


def parse_date(value):
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (ValueError, TypeError, OverflowError):
        try:
            dt = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        except (ValueError, TypeError):
            return None
    # An undated/timezone-less story must not masquerade as a current story.
    return dt.astimezone(UTC) if dt.tzinfo is not None else None


def iso(dt):
    return dt.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def safe_url(value):
    try:
        url = urllib.parse.urlsplit((value or '').strip())
        if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password:
            return None
        query = [(k, v) for k, v in urllib.parse.parse_qsl(url.query, keep_blank_values=True)
                 if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
        return urllib.parse.urlunsplit((url.scheme, url.netloc, url.path, urllib.parse.urlencode(query), ''))
    except ValueError:
        return None


def fetch(url, max_bytes=5_000_000):
    request = urllib.request.Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)', 'Accept': 'application/rss+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.5'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError('Response exceeds size limit')
    return data


def parse_feed(data, source, now):
    root = ET.fromstring(data)
    articles = []
    rss1 = '{http://purl.org/rss/1.0/}'
    # RSS 1.0/RDF uses namespaced fields (for example DW); RSS 2.0 does not.
    items = root.findall('.//item') + root.findall(f'.//{rss1}item')
    for item in items[:120]:
        def field(name):
            return item.findtext(name) or item.findtext(rss1 + name) or ''
        title = plain(field('title'))[:240]
        url = safe_url(field('link'))
        date = parse_date(item.findtext('pubDate') or item.findtext('{http://purl.org/dc/elements/1.1/}date'))
        if not title or not url or not date or date > now + timedelta(minutes=10) or date < now - timedelta(days=30):
            continue
        if source['category'] == 'housing' and not is_hangzhou_housing(title):
            continue
        # Keep only a short publisher-provided excerpt; do not republish feed bodies.
        excerpt = plain(field('description'))
        excerpt = re.sub(r'^(?:IT之家|爱范儿)\s*\d+\s*月\s*\d+\s*日(?:消息|讯)[，,：:\s]*', '', excerpt)
        excerpt = excerpt[:89].rstrip() + '…' if len(excerpt) > 90 else excerpt
        # Dedicated sections stay separate even when a story mentions AI.
        category = source['category'] if source['category'] in ('entertainment', 'sports', 'housing') else ('ai' if AI_PATTERN.search(title) else source['category'])
        articles.append({
            'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'title': title,
            'url': url, 'sourceId': source['id'], 'category': category,
            'publishedAt': iso(date), 'excerpt': excerpt,
        })
    return articles


def collect(source, now):
    status = {k: source[k] for k in ('id', 'name', 'home', 'category', 'color')}
    status['checkedAt'] = iso(now)
    started = time.monotonic()
    try:
        articles = parse_feed(fetch(source['url']), source, now)
        if not articles:
            raise ValueError('No dated articles from the last 30 days')
        status.update(status='ok', fetchedCount=len(articles), latestAt=max(a['publishedAt'] for a in articles),
                      durationMs=round((time.monotonic() - started) * 1000))
        return articles, status
    except Exception as exc:
        print(f"Source {source['id']} unavailable: {exc}", file=sys.stderr)
        status.update(status='unavailable', fetchedCount=0, durationMs=round((time.monotonic() - started) * 1000))
        return [], status


def merge_articles(previous, incoming, now, allowed_sources):
    by_url = {}
    for article in previous + incoming:
        if not isinstance(article, dict):
            continue
        url = safe_url(article.get('url'))
        date = parse_date(article.get('publishedAt'))
        if not url or not date or not now - timedelta(days=30) <= date <= now + timedelta(minutes=10):
            continue
        if article.get('sourceId') not in allowed_sources or article.get('category') not in ('general', 'tech', 'ai', 'entertainment', 'sports', 'housing'):
            continue
        if article.get('category') == 'housing' and not is_hangzhou_housing(str(article.get('title', ''))):
            continue
        clean = {key: str(article.get(key, '')) for key in ('title', 'sourceId', 'category', 'publishedAt', 'excerpt')}
        clean.update(url=url, id=hashlib.sha256(url.encode()).hexdigest()[:16], title=plain(clean['title'])[:240], excerpt=plain(clean['excerpt'])[:90])
        if clean['title']:
            by_url[url] = clean
    # Exact duplicate titles from the same publisher are revisions, not new stories.
    seen = set()
    result = []
    for article in sorted(by_url.values(), key=lambda a: a['publishedAt'], reverse=True):
        key = (article['sourceId'], re.sub(r'\W', '', article['title']).casefold())
        if key not in seen:
            seen.add(key)
            result.append(article)
    return result[:6000]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'news/data/news.json')
    parser.add_argument('--previous-url')
    args = parser.parse_args()
    sources = json.loads((ROOT / 'news/sources.json').read_text())
    previous = []
    if args.output.exists():
        previous = json.loads(args.output.read_text()).get('articles', [])
    if args.previous_url:
        try:
            previous += json.loads(fetch(args.previous_url, 15_000_000)).get('articles', [])
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise SystemExit(f'Cannot safely read previous archive; aborting to preserve history: {exc}')
            print('No previous archive (first deployment).', file=sys.stderr)
        except Exception as exc:
            raise SystemExit(f'Cannot safely read previous archive; aborting to preserve history: {exc}')
    now = datetime.now(UTC)
    incoming, statuses = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for articles, status in pool.map(lambda source: collect(source, now), sources):
            incoming.extend(articles)
            statuses.append(status)
    articles = merge_articles(previous, incoming, now, {s['id'] for s in sources})
    previous_urls = {safe_url(a.get('url')) for a in previous if isinstance(a, dict)}
    for status in statuses:
        status['newCount'] = sum(a['sourceId'] == status['id'] and a['url'] not in previous_urls for a in articles)
        print('SOURCE_METRIC ' + json.dumps({k: status[k] for k in
              ('id', 'checkedAt', 'status', 'fetchedCount', 'newCount', 'durationMs')}))
    if not incoming:
        raise SystemExit('All feeds unavailable. Keep the last successful deployment; do not publish an empty site.')
    result = {'version': 1, 'updatedAt': iso(now), 'retentionDays': 30, 'sources': statuses, 'articles': articles}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Collected {len(incoming)} items; retained {len(articles)} unique items; {sum(s["status"] == "ok" for s in statuses)}/{len(sources)} sources available.')


if __name__ == '__main__':
    main()
