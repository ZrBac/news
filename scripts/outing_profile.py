"""Private outing preferences; never include this document in a public snapshot."""
import json
import os
import re
import urllib.request

ENDPOINT = 'https://news-refresh.944052796.workers.dev/api/outings/profile'


class ProfileUnavailable(Exception):
    pass


def load():
    token = os.environ.get('OUTING_PROFILE_TOKEN', '')
    if not token:
        return {}
    try:
        request = urllib.request.Request(ENDPOINT, headers={'Authorization': 'Bearer ' + token,
            'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)'})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read(100_000))
        if result.get('schema') != 1 or not isinstance(result.get('records'), list):
            raise ValueError('invalid_profile')
        return result
    except Exception:
        # Shared build caches are unsuitable for personal records. Keep the last
        # public recommendations if the authenticated store cannot be reached.
        raise ProfileUnavailable('outing_profile_unavailable') from None


def excludes(candidate, profile):
    for record in (profile or {}).get('records', []):
        if record.get('status') not in ('visited', 'dismiss'):
            continue
        if record.get('id') == candidate.get('id'):
            return True
        # A new dated event at a visited venue is still a new experience.
        if candidate.get('placeId') and record.get('id') == 'place:' + candidate['placeId'] and not candidate.get('discovery'):
            return True
    return False


def event_key(name, start, end, venue):
    import hashlib
    text = re.sub(r'[\s\W_]+', '', name + start + end + venue).lower()
    return 'event:' + hashlib.sha256(text.encode()).hexdigest()[:24]
