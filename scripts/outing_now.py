"""Small, public source packet for on-demand outing advice. No user records."""
import json
from urllib.parse import urlsplit


def public_context(data, places, tonight):
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
            'summary': clean(item.get('summary')), 'minutes': item.get('minutes', 30),
            'outcome': clean(item.get('project', {}).get('outcome')), 'sources': [],
        }
    editorial = data.get('editorial', {})
    updates = data.get('placeUpdates', {}).get('places', {})
    for item in places.get('places', []) + editorial.get('placeCatalog', {}).get('places', []):
        if item.get('sourceStatus', 'verified') != 'verified':
            continue
        group = item.get('group')
        sources = links(item.get('links', []))
        if not sources:
            continue
        candidates['place:' + item['id']] = {
            'id': 'place:' + item['id'], 'name': clean(item['name'], 120),
            'setting': 'indoor' if group == 'rainy' else 'outdoor', 'group': group,
            'area': clean(item.get('area'), 140),
            'summary': clean(' '.join(p.get('text', '') for p in item.get('paragraphs', []))),
            'checkedAt': item.get('verifiedAt') or item.get('reviewedOn'),
            'recent': [{'title': clean(p.get('title'), 120), 'date': p.get('publishedAt')}
                       for p in updates.get(item['id'], {}).get('items', [])[:2]],
            'sources': sources,
        }
    trip = editorial.get('trip', {})
    for item in trip.get('picks', []) + trip.get('alternatives', []):
        if not item.get('id', '').startswith('event:') or not item.get('start') or not item.get('end'):
            continue
        sources = links(item.get('sources', []))
        if not sources:
            continue
        candidates[item['id']] = {
            'id': item['id'], 'name': clean(item.get('name'), 120),
            'setting': item.get('setting', 'unknown'), 'group': 'event',
            'area': clean(item.get('area'), 140), 'start': item['start'], 'end': item['end'],
            'summary': clean(item.get('summary') or item.get('novelty')),
            'facts': [{'kind': p.get('kind'), 'text': clean(p.get('text'), 250)} for p in item.get('facts', [])[:6]],
            'checkedAt': item.get('verifiedAt'), 'sources': sources,
        }
    return {'schema': 1, 'updatedAt': data.get('updatedAt'), 'candidates': list(candidates.values())[:100]}


def build(data, root, output):
    packet = public_context(data, json.loads((root / 'news/places.json').read_text()),
                            json.loads((root / 'news/tonight.json').read_text()))
    (output / 'data/outing-now.json').write_text(json.dumps(packet, ensure_ascii=False, separators=(',', ':')) + '\n')
