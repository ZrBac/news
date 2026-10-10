#!/usr/bin/env python3
"""Build the standalone static news portal and its PWA assets."""
import argparse
import hashlib
import json
import os
import re
import shutil
from html import escape as html_escape
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import urlsplit
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]


def build_guide_reader(output):
    """Render a usable first page and split remaining bodies into small chapters."""
    book = json.loads((output / 'guide/book.json').read_text())
    chapters = [{**chapter, 'file': f'/guide/chapters/{chapter["id"]}.{book["revision"][:12]}.json'}
                for chapter in book['chapters']]
    index = {**book, 'chapters': chapters,
             'entries': [{key: value for key, value in entry.items() if key != 'body'}
                         for entry in book['entries']]}
    (output / 'assets/news/guide-index.json').write_text(
        json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n')
    folder = output / 'guide/chapters'
    folder.mkdir(parents=True, exist_ok=True)
    for chapter in chapters:
        body = {'schema': 1, 'revision': book['revision'],
                'entries': [entry for entry in book['entries'] if entry['chapter'] == chapter['id']]}
        (output / chapter['file'].lstrip('/')).write_text(
            json.dumps(body, ensure_ascii=False, separators=(',', ':')) + '\n')
    first = book['entries'][:12]
    bootstrap = {**book, 'chapters': chapters, 'entries': first, 'totalEntries': len(book['entries'])}
    template = (output / 'guide/index.html').read_text()
    directory = ''.join(f'<a href="/guide/read/{chapter["id"]}/" data-read-chapter="{chapter["id"]}">'
                        f'{chapter["id"]}. {html_escape(chapter["title"])}</a>' for chapter in chapters)
    def card(entry, controls=False):
        chapter = next(chapter for chapter in chapters if chapter['id'] == entry['chapter'])
        save = f'<button class="entry-save" data-save="{entry["id"]}" aria-pressed="false">收藏</button>' if controls else ''
        return (f'<article class="guide-entry" data-entry="{entry["id"]}">'
                f'<p class="entry-meta">第 {chapter["id"]} 章 · {html_escape(chapter["title"])} · 第 {entry["number"]} 条 · 证据 {html_escape(entry["grade"] or "未标注")}</p>'
                f'<div class="entry-head"><h2>{html_escape(entry["title"])}</h2>{save}</div>'
                f'<p class="entry-summary">{html_escape(entry["summary"])}</p>'
                f'<details><summary>正文、来源与适用条件</summary><div class="entry-body" data-loaded="true">'
                f'<div class="entry-plain">{html_escape(entry["body"])}</div></div>'
                f'<a class="entry-original" href="{html_escape(entry["url"], quote=True)}" target="_blank" rel="noopener noreferrer">查看原项目本章</a>'
                '</details></article>')
    template = template.replace('__GUIDE_DIRECTORY__', directory)
    template = template.replace('__GUIDE_INITIAL_STATUS__', '首屏正文已可阅读，正在加载完整目录…')
    template = template.replace('__GUIDE_INITIAL_ENTRIES__', ''.join(card(entry, True) for entry in first))
    template = template.replace('__GUIDE_BOOTSTRAP__', json.dumps(bootstrap, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'))
    (output / 'guide/index.html').write_text(template)
    static_paths = []
    for chapter in chapters:
        page_path = f'/guide/read/{chapter["id"]}/'
        static_paths.append(page_path)
        page = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>{html_escape(chapter["title"])} · 生活指南</title>'
                f'<link rel="canonical" href="https://news.zacai.fun{page_path}">'
                '<link rel="stylesheet" href="/assets/news/style.css">'
                '<link rel="stylesheet" href="/assets/news/guide.css"></head><body>'
                '<header class="header"><div class="header-inner"><a class="brand" href="/"><span class="brand-name">资讯</span></a>'
                '<div class="header-actions"><a class="games-link" href="/guide/">返回指南</a></div></div></header>'
                f'<main class="guide-page"><div class="guide-heading"><h1>第 {chapter["id"]} 章 · {html_escape(chapter["title"])}</h1></div>'
                f'<div class="entry-body entry-plain">{html_escape(chapter["intro"])}</div>'
                + ''.join(card(entry) for entry in book['entries'] if entry['chapter'] == chapter['id'])
                + '<footer class="guide-attribution">内容来自 <a href="https://github.com/eternity4719/HowToLiveBetter">eternity4719《高性价比人生指南》</a>，'
                '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>。本站调整了排版，正文保留原文。'
                f'<p>正文版本：{book["revision"][:8]} · <a href="/guide/">返回指南</a></p></footer></main></body></html>')
        folder = output / page_path.lstrip('/')
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'index.html').write_text(page)
    return chapters, static_paths


def build_news_pages(data, output):
    """Keep the full export for collectors; readers fetch a small initial page."""
    size = 150
    articles = data['articles']
    folder = output / 'data/archive'
    folder.mkdir(parents=True, exist_ok=True)
    pages = []
    for offset in range(size, len(articles), size):
        body = json.dumps({'articles': articles[offset:offset + size]}, ensure_ascii=False,
                          separators=(',', ':')).encode()
        name = hashlib.sha256(body).hexdigest()[:16] + '.json'
        (folder / name).write_bytes(body)
        pages.append('/data/archive/' + name)
    # The legacy export stays chronological. New readers use a compact lookup
    # and category chunks, fetching only the pages containing matching stories.
    lookup_pages, rows, categories, locations, shards = [], [], {}, {}, []
    def row(article, page):
        day = datetime.fromisoformat(article['publishedAt'].replace('Z', '+00:00')).astimezone(
            timezone(timedelta(hours=8))).date().isoformat()
        source = article.get('sourceId', '')
        categories.setdefault(article['category'], set()).add(source)
        return [source, article['category'], day,
                (article['title'] + ' ' + article.get('excerpt', '')).lower(), page]
    rows.extend(row(article, -1) for article in articles[:size])
    for category in dict.fromkeys(article['category'] for article in articles):
        pool = [article for article in articles[size:] if article['category'] == category]
        for offset in range(0, len(pool), 100):
            batch = pool[offset:offset + 100]
            body = json.dumps({'articles': batch}, ensure_ascii=False, separators=(',', ':')).encode()
            name = hashlib.sha256(body).hexdigest()[:16] + '.json'
            (folder / name).write_bytes(body)
            page = len(lookup_pages)
            lookup_pages.append('/data/archive/' + name)
            shards.append({'path': lookup_pages[-1], 'category': category,
                           'sources': sorted({article.get('sourceId', '') for article in batch}),
                           'days': sorted({row(article, page)[2] for article in batch}),
                           'newest': batch[0]['publishedAt']})
            for article in batch:
                locations[article['id']] = page
    rows.extend(row(article, locations[article['id']]) for article in articles[size:])
    def write_lookup(selected):
        lookup = json.dumps({'schema': 1, 'pages': lookup_pages, 'rows': selected},
                            ensure_ascii=False, separators=(',', ':')).encode()
        path = '/data/archive/index.' + hashlib.sha256(lookup).hexdigest()[:16] + '.json'
        (output / path.lstrip('/')).write_bytes(lookup)
        return path
    lookup_path = write_lookup(rows)
    indexes = {category: write_lookup([row for row in rows if row[1] == category])
               for category in categories}
    # Model releases are less frequent than general news. Include a compact
    # reading list so opening this section never scans the news archive.
    releases, seen = [], set()
    for article in data.get('modelReleases', articles):
        if article.get('category') != 'models':
            continue
        title = article['title'].rsplit(' - ', 1)[0]
        key = re.sub(r'\W', '', title).casefold()
        if key in seen:
            continue
        seen.add(key)
        releases.append(article)
        if len(releases) == 60:
            break
    housing, seen = [], set()
    for article in data.get('housingArticles', articles):
        if article.get('category') != 'housing':
            continue
        key = re.sub(r'\W', '', article['title'].rsplit(' - ', 1)[0]).casefold()
        if key in seen:
            continue
        seen.add(key)
        housing.append(article)
        if len(housing) == 60:
            break
    # Include several candidates from each category for today/yesterday. A busy
    # sports feed must not hide a day's only model or housing story from the brief.
    brief_days, brief_articles = [], []
    if data.get('updatedAt'):
        today = datetime.fromisoformat(data['updatedAt'].replace('Z', '+00:00')).astimezone(
            timezone(timedelta(hours=8))).date()
        brief_days = [(today - timedelta(days=n)).isoformat() for n in range(2)]
        candidates = sorted(articles + releases + housing, key=lambda a: a['publishedAt'], reverse=True)
        for day in brief_days:
            for category in ('general', 'ai', 'models', 'tech', 'entertainment', 'gaming', 'sports', 'housing'):
                pool, seen = [], set()
                for article in candidates:
                    if article.get('category') != category:
                        continue
                    published = datetime.fromisoformat(article['publishedAt'].replace('Z', '+00:00')).astimezone(
                        timezone(timedelta(hours=8))).date().isoformat()
                    key = re.sub(r'\W', '', article['title'].rsplit(' - ', 1)[0]).casefold()
                    if published == day and key not in seen:
                        pool.append(article)
                        seen.add(key)
                selected, others, counts = [], [], {}
                for article in pool:
                    source = article.get('sourceId', '')
                    if counts.get(source, 0) < 2 and len(selected) < 5:
                        selected.append(article)
                        counts[source] = counts.get(source, 0) + 1
                    else:
                        others.append(article)
                brief_articles.extend(selected + others[:max(0, 5 - len(selected))])
    gaming = [article for article in articles if article.get('category') == 'gaming'][:60]
    latest = {**data, 'articles': articles[:size], 'modelReleases': releases, 'gamingArticles': gaming,
              'housingArticles': housing,
              'briefArticles': brief_articles, 'briefDays': brief_days,
              'archive': {'pages': pages, 'loaded': 0, 'total': len(articles),
                          'lookup': lookup_path,
                          'indexes': indexes, 'shards': shards,
                          'categories': {key: sorted(value) for key, value in categories.items()},
                          'oldest': articles[-1]['publishedAt'] if articles else None}}
    # Observation history is only for the collector. Open the small public
    # summary on demand so source statistics do not slow down the news list.
    latest.pop('sourceQualityState', None)
    quality = latest.pop('sourceQuality', None)
    if quality:
        body = json.dumps(quality, ensure_ascii=False, separators=(',', ':')).encode()
        path = '/data/source-quality.' + hashlib.sha256(body).hexdigest()[:16] + '.json'
        (output / path.lstrip('/')).write_bytes(body)
        latest['sourceQuality'] = {'schema': 1, 'path': path,
                                  'startedAt': quality['startedAt'], 'updatedAt': quality['updatedAt']}
    (output / 'data/latest.json').write_text(
        json.dumps(latest, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, default=ROOT / '_site')
    args = p.parse_args()
    refresh_endpoint = os.environ.get('NEWS_REFRESH_ENDPOINT', '').strip() or 'https://zacai.fun/api/news-refresh'
    endpoint = urlsplit(refresh_endpoint)
    if (endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password
            or endpoint.query or endpoint.fragment or endpoint.path != '/api/news-refresh'):
        raise SystemExit('NEWS_REFRESH_ENDPOINT must be an HTTPS /api/news-refresh URL without credentials or query parameters')
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents:
        raise SystemExit('Unsafe output directory')
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copy2(ROOT / 'news/index.html', output / 'index.html')
    shutil.copytree(ROOT / 'news/games', output / 'games')
    shutil.copytree(ROOT / 'news/guide', output / 'guide')
    shutil.copytree(ROOT / 'news/assets', output / 'assets/news', dirs_exist_ok=True)
    chapters, static_paths = build_guide_reader(output)
    # Keep the previous edition available to older installed readers until they update.
    old_book = (ROOT / 'news/guide/book.json').read_bytes()
    digest = hashlib.sha256(old_book).hexdigest()[:12]
    (output / f'assets/news/guide-book.{digest}.json').write_bytes(old_book)
    # New HTML always requests the matching assets, even with cached older releases.
    homepage = (output / 'index.html').read_text()
    skeleton = ('<div class="article-placeholder skeleton" aria-hidden="true"><div class="article-body">'
                '<span class="skeleton-line short"></span><span class="skeleton-line title"></span>'
                '<span class="skeleton-line title"></span><span class="skeleton-line"></span>'
                '<span class="skeleton-line short"></span></div></div>')
    homepage = homepage.replace('__NEWS_SKELETON__', skeleton * 12)
    homepage = homepage.replace('content="https://zacai.fun/api/news-refresh"',
                                f'content="{html_escape(refresh_endpoint, quote=True)}"')
    pages = {'/': homepage, '/games/': (output / 'games/index.html').read_text(),
             '/guide/': (output / 'guide/index.html').read_text()}
    pages.update({path: (output / path.lstrip('/') / 'index.html').read_text() for path in static_paths})
    shell_files = ['/', '/games/', '/guide/', '/manifest.webmanifest', '/assets/news/icon-180.png',
                   '/assets/news/icon-192.png', '/assets/news/icon-512.png']
    for filename in ('compat.js', 'compat.css', 'archive.js', 'personal.js', 'exchange-core.js', 'app.js', 'pwa.js', 'style.css', 'favicon.svg', 'games.css', 'games-core.js', 'games.js', 'table-games.css', 'table-games-core.js', 'table-games.js', 'extra-games.css', 'extra-games-core.js', 'extra-games.js', 'casual-games.css', 'casual-games-core.js', 'casual-games.js', 'guide-core.js', 'guide.js', 'guide.css', 'guide-index.json'):
        asset = output / 'assets/news' / filename
        digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:12]
        versioned = asset.with_name(f'{asset.stem}.{digest}{asset.suffix}')
        shutil.copy2(asset, versioned)
        for path in pages:
            pages[path] = pages[path].replace(f'"/assets/news/{filename}"', f'"/assets/news/{versioned.name}"')
        shell_files.append(f'/assets/news/{versioned.name}')
    for path, page in pages.items():
        (output / path.lstrip('/') / 'index.html').write_text(page)
    shutil.copy2(ROOT / 'news/manifest.webmanifest', output / 'manifest.webmanifest')
    worker = (ROOT / 'news/sw.js').read_text()
    shell_digest = hashlib.sha256(pages['/'].encode() + worker.encode())
    for path in shell_files[1:]:
        asset = output / path.lstrip('/')
        shell_digest.update((asset / 'index.html' if path.endswith('/') else asset).read_bytes())
    worker = worker.replace('__BUILD_ID__', shell_digest.hexdigest()[:16])
    news_shell = list(dict.fromkeys(['/', '/manifest.webmanifest',
        '/assets/news/icon-180.png', '/assets/news/icon-192.png', '/assets/news/icon-512.png',
        *re.findall(r'/assets/news/[\w.-]+\.[a-f0-9]{12}\.(?:json|js|css|svg)\b', pages['/'])]))
    game_shell = list(dict.fromkeys([*news_shell, '/games/',
        *re.findall(r'/assets/news/[\w.-]+\.[a-f0-9]{12}\.(?:json|js|css|svg)\b', pages['/games/'])]))
    guide_shell = list(dict.fromkeys(['/', '/guide/', '/manifest.webmanifest',
        '/assets/news/icon-180.png', '/assets/news/icon-192.png', '/assets/news/icon-512.png',
        *re.findall(r'/assets/news/[\w.-]+\.[a-f0-9]{12}\.(?:json|js|css|svg)\b', pages['/'] + pages['/guide/'])]))
    worker = worker.replace('__SHELL_FILES__', json.dumps(shell_files))
    worker = worker.replace('__NEWS_SHELL__', json.dumps(news_shell))
    worker = worker.replace('__GAMES_SHELL__', json.dumps(game_shell))
    worker = worker.replace('__GUIDE_SHELL__', json.dumps(guide_shell))
    worker = worker.replace('__GUIDE_FILES__', json.dumps([chapter['file'] for chapter in chapters]))
    worker = worker.replace('__GUIDE_REVISION__', json.dumps(json.loads(old_book)['revision']))
    (output / 'sw.js').write_text(worker)
    shutil.copytree(ROOT / 'news/data', output / 'data', dirs_exist_ok=True)
    (output / '.nojekyll').touch()
    data = json.loads((output / 'data/news.json').read_text())
    price_file = ROOT / 'news/data/housing.json'
    data['housingPrices'] = json.loads((price_file if price_file.exists() else ROOT / 'news/housing-prices.json').read_text())
    # Remove retired sections from older cached price data.
    prices = data['housingPrices']
    prices.pop('samples', None)
    prices.pop('watchlist', None)
    prices.pop('xihuHotspots', None)
    (output / 'data/housing.json').write_text(json.dumps(prices, ensure_ascii=False, separators=(',', ':')) + '\n')
    exchange_file = ROOT / 'news/data/exchange.json'
    data['exchangeRates'] = json.loads((exchange_file if exchange_file.exists() else ROOT / 'news/exchange-rates.json').read_text())
    (output / 'data/news.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    build_news_pages(data, output)
    # A tiny health file avoids downloading and parsing the entire archive in Workers.
    updated_at = data['updatedAt']
    if datetime.fromisoformat(updated_at.replace('Z', '+00:00')).tzinfo is None:
        raise SystemExit('News timestamp must include a timezone')
    (output / 'data/status.json').write_text(json.dumps({'updatedAt': updated_at}) + '\n')
    items = ''.join(f'<item><title>{escape(a["title"])}</title><link>{escape(a["url"])}</link><guid>{escape(a["url"])}</guid><pubDate>{format_datetime(datetime.fromisoformat(a["publishedAt"].replace("Z", "+00:00")))}</pubDate><description>{escape(a["excerpt"])}</description></item>' for a in data['articles'][:50])
    (output / 'news.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>资讯</title><link>https://news.zacai.fun/</link><description>综合热点与 AI 科技资讯。摘要来自原始资讯源。</description>' + items + '</channel></rss>')
    urls = ['https://news.zacai.fun/', 'https://news.zacai.fun/games/', 'https://news.zacai.fun/guide/']
    (output / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join(f'<url><loc>{escape(u)}</loc></url>' for u in urls) + '</urlset>')
    (output / 'robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: https://news.zacai.fun/sitemap.xml\n')
    print(f'Built {output}; {len(data["articles"])} news items.')


if __name__ == '__main__':
    main()
