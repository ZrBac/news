#!/usr/bin/env python3
"""Build the standalone static news portal and its PWA assets."""
import argparse
import hashlib
import json
import os
import shutil
from html import escape as html_escape
from datetime import datetime
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import urlsplit
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]



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
    latest = {**data, 'articles': articles[:size],
              'archive': {'pages': pages, 'loaded': 0, 'total': len(articles),
                          'oldest': articles[-1]['publishedAt'] if articles else None}}
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
    shutil.copytree(ROOT / 'news/assets', output / 'assets/news', dirs_exist_ok=True)
    # New HTML always requests the matching assets, even with cached older releases.
    homepage = (output / 'index.html').read_text()
    homepage = homepage.replace('content="https://zacai.fun/api/news-refresh"',
                                f'content="{html_escape(refresh_endpoint, quote=True)}"')
    pages = {'/': homepage, '/games/': (output / 'games/index.html').read_text()}
    shell_files = ['/', '/games/', '/manifest.webmanifest', '/assets/news/icon-180.png',
                   '/assets/news/icon-192.png', '/assets/news/icon-512.png']
    for filename in ('compat.js', 'compat.css', 'app.js', 'pwa.js', 'style.css', 'favicon.svg', 'games.css', 'games-core.js', 'games.js', 'table-games.css', 'table-games-core.js', 'table-games.js', 'extra-games.css', 'extra-games-core.js', 'extra-games.js', 'casual-games.css', 'casual-games-core.js', 'casual-games.js'):
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
    worker = worker.replace('__SHELL_FILES__', json.dumps(shell_files))
    (output / 'sw.js').write_text(worker)
    shutil.copytree(ROOT / 'news/data', output / 'data', dirs_exist_ok=True)
    (output / '.nojekyll').touch()
    data = json.loads((output / 'data/news.json').read_text())
    price_file = ROOT / 'news/data/housing.json'
    data['housingPrices'] = json.loads((price_file if price_file.exists() else ROOT / 'news/housing-prices.json').read_text())
    if 'watchlist' not in data['housingPrices']:
        data['housingPrices']['watchlist'] = json.loads((ROOT / 'news/housing-watchlist.json').read_text())
    if 'xihuHotspots' not in data['housingPrices']:
        data['housingPrices']['xihuHotspots'] = json.loads((ROOT / 'news/xihu-hotspots.json').read_text())
    (output / 'data/news.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    build_news_pages(data, output)
    # A tiny health file avoids downloading and parsing the entire archive in Workers.
    updated_at = data['updatedAt']
    if datetime.fromisoformat(updated_at.replace('Z', '+00:00')).tzinfo is None:
        raise SystemExit('News timestamp must include a timezone')
    (output / 'data/status.json').write_text(json.dumps({'updatedAt': updated_at}) + '\n')
    items = ''.join(f'<item><title>{escape(a["title"])}</title><link>{escape(a["url"])}</link><guid>{escape(a["url"])}</guid><pubDate>{format_datetime(datetime.fromisoformat(a["publishedAt"].replace("Z", "+00:00")))}</pubDate><description>{escape(a["excerpt"])}</description></item>' for a in data['articles'][:50])
    (output / 'news.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>资讯</title><link>https://news.zacai.fun/</link><description>综合热点与 AI 科技资讯。摘要来自原始资讯源。</description>' + items + '</channel></rss>')
    urls = ['https://news.zacai.fun/', 'https://news.zacai.fun/games/']
    (output / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join(f'<url><loc>{escape(u)}</loc></url>' for u in urls) + '</urlset>')
    (output / 'robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: https://news.zacai.fun/sitemap.xml\n')
    print(f'Built {output}; {len(data["articles"])} news items.')


if __name__ == '__main__':
    main()
