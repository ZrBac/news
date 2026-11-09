"""Small, public source packet for on-demand outing advice. No user records."""
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit


def public_context(data, places, tonight, verified=None):
    from ai_editor import place_region

    def clean(value, size=700):
        return str(value or '').strip()[:size]

    def links(rows):
        result = []
        for row in rows:
            url = clean(row.get('url'), 1500)
            try:
                parsed = urlsplit(url)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                    continue
            except ValueError:
                continue
            result.append({'url': url, 'label': clean(row.get('label') or '来源', 60)})
        return result[:3]

    candidates = {}
    for item in tonight.get('activities', []):
        if item.get('setting') != 'home':
            continue
        candidates[item['id']] = {
            'id': item['id'], 'name': item['name'], 'setting': 'home', 'group': 'home',
            # Reuse the activity, not the evening-specific wording of its source.
            'summary': clean(item.get('summary')).replace('每晚', '每次').replace('今晚', '这次').replace('晚饭', '饭菜'),
            'minutes': item.get('minutes', 30),
            'outcome': clean(item.get('project', {}).get('outcome')), 'sources': [],
        }
    editorial = data.get('editorial', {})
    updates = data.get('placeUpdates', {}).get('places', {})
    closed = {p['id'] for p in verified or [] if p.get('closed')}
    for item in places.get('places', []) + editorial.get('placeCatalog', {}).get('places', []):
        if item.get('sourceStatus', 'verified') != 'verified' or 'place:' + item['id'] in closed:
            continue
        group = item.get('group')
        sources = links(item.get('links', []))
        if not sources:
            continue
        candidates['place:' + item['id']] = {
            'id': 'place:' + item['id'], 'name': clean(item['name'], 120),
            'setting': 'indoor' if group == 'rainy' else 'outdoor', 'group': group,
            'area': clean(item.get('area'), 140),
            'region': place_region(item.get('area', '') + item['name']),
            'summary': clean(' '.join(p.get('text', '') for p in item.get('paragraphs', []))),
            'checkedAt': item.get('verifiedAt') or item.get('reviewedOn'),
            'dynamic': bool(item.get('dynamic')),
            'recent': [{'title': clean(p.get('title'), 120), 'date': p.get('publishedAt')}
                       for p in updates.get(item['id'], {}).get('items', [])[:2]],
            'sources': sources,
        }
    trip = editorial.get('trip', {})
    # All verified dated activities are eligible, including weekday sessions.
    # A retained weekend selection must not revive a cancelled/changed event.
    events = verified if verified is not None else trip.get('picks', []) + trip.get('alternatives', [])
    for item in events:
        if not item.get('id', '').startswith('event:') or not item.get('start') or not item.get('end'):
            continue
        sources = links(item.get('sources', []))
        if not sources:
            continue
        candidates[item['id']] = {
            'id': item['id'], 'name': clean(item.get('name'), 120),
            'setting': item.get('setting', 'unknown'), 'group': 'event',
            'area': clean(item.get('area'), 140), 'start': item['start'], 'end': item['end'],
            'region': item.get('region') or place_region(item.get('area', '') + item['name']),
            'summary': clean(item.get('summary') or item.get('novelty')),
            'facts': [{'kind': p.get('kind'), 'text': clean(p.get('text'), 250)} for p in item.get('facts', [])[:6]],
            'checkedAt': item.get('verifiedAt'), 'sources': sources,
        }
    return {'schema': 1, 'updatedAt': data.get('updatedAt'), 'candidates': list(candidates.values())[:100]}


def build(data, root, output):
    from ai_editor import trip_candidates
    places = json.loads((root / 'news/places.json').read_text())
    editorial = data.get('editorial', {})
    verified = trip_candidates(data, places['places'] + editorial.get('placeCatalog', {}).get('places', []),
                               editorial.get('research', {}).get('items', []), datetime.now(timezone.utc))
    packet = public_context(data, places, json.loads((root / 'news/tonight.json').read_text()), verified)
    (output / 'data/outing-now.json').write_text(json.dumps(packet, ensure_ascii=False, separators=(',', ':')) + '\n')
