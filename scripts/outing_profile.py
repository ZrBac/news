"""Shared outing preferences; keep raw records out of news snapshots and AI caches."""
import json
import re
import urllib.request

ENDPOINT = 'https://news-refresh.944052796.workers.dev/api/outings/profile'


class ProfileUnavailable(Exception):
    pass


def load():
    try:
        request = urllib.request.Request(ENDPOINT, headers={
            'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)'})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read(100_000))
        if result.get('schema') != 1 or not isinstance(result.get('records'), list):
            raise ValueError('invalid_profile')
        return result
    except Exception:
        # Keep the last recommendations when shared feedback cannot be reached;
        # an outage must not be treated as an empty preference list.
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
    # Local publishers use both the formal exhibition name and its common
    # abbreviation, and often omit the city prefix from the same venue.
    name = name.replace('文化创意产业博览会', '文博会').replace('文化创意博览会', '文博会')
    venue = re.sub(r'^杭州市?', '', venue)
    text = re.sub(r'[\s\W_]+', '', name + start + end + venue).lower()
    return 'event:' + hashlib.sha256(text.encode()).hexdigest()[:24]
