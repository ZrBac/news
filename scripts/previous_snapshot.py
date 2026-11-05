#!/usr/bin/env python3
"""Restore one complete snapshot for all collectors, with a validated backup."""
import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


def validate(value, now):
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ValueError('Invalid snapshot version')
    stamp = datetime.fromisoformat(str(value.get('updatedAt', '')).replace('Z', '+00:00'))
    if stamp.tzinfo is None or stamp > now + timedelta(minutes=5):
        raise ValueError('Invalid snapshot timestamp')
    articles = value.get('articles')
    if not isinstance(articles, list) or not articles or len(articles) > 12000:
        raise ValueError('Missing complete news archive')
    if 'archive' in value:
        raise ValueError('A reading page is not a complete archive')
    if not isinstance(value.get('sources'), list) or not value['sources']:
        raise ValueError('Missing source records')
    ids = set()
    for article in articles:
        if not isinstance(article, dict) or not all(isinstance(article.get(key), str) and article[key]
                for key in ('id', 'title', 'url', 'category', 'sourceId', 'publishedAt')):
            raise ValueError('Invalid article')
        published = datetime.fromisoformat(article['publishedAt'].replace('Z', '+00:00'))
        if published.tzinfo is None or article['id'] in ids:
            raise ValueError('Invalid article history')
        ids.add(article['id'])
    return value


def restore(url, backup, get, now):
    candidates = []
    try:
        cached = validate(json.loads(backup.read_text()), now)
        candidates.append(('backup', cached))
    except (OSError, ValueError, TypeError):
        pass
    for _ in range(2):
        try:
            remote = validate(json.loads(get(url)), now)
            candidates.append(('published', remote))
            break
        except Exception:
            # Retry a temporary failure; never replace history with an empty feed.
            continue
    if not candidates:
        raise ValueError('No valid previous snapshot; stop to preserve history')
    return max(candidates, key=lambda item: datetime.fromisoformat(item[1]['updatedAt'].replace('Z', '+00:00')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--backup', type=Path, default=Path('.cache/news-snapshot/last-good.json'))
    parser.add_argument('--output', type=Path, default=Path('.cache/news-snapshot/previous.json'))
    args = parser.parse_args()
    from collect_news import fetch
    try:
        origin, data = restore(args.url, args.backup, lambda url: fetch(url, 30_000_000), datetime.now(timezone.utc))
    except ValueError as error:
        raise SystemExit(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(args.output)
    print(f'Previous snapshot: {origin}, {data["updatedAt"]}, {len(data["articles"])} articles.')
    if origin == 'backup':
        print('::warning::Using the last validated snapshot; the published copy is unavailable or older.')


if __name__ == '__main__':
    main()
