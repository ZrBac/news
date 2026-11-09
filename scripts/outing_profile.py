"""Shared outing preferences; keep raw records out of news snapshots and AI caches."""
import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone

ENDPOINT = 'https://news-refresh.944052796.workers.dev/api/outings/profile'


class ProfileUnavailable(Exception):
    pass


def suggestion_context(profile):
    """Anchor relative dates to when a shared suggestion was written, not each run."""
    raw = (profile or {}).get('settings', {}).get('weekendNoteUpdatedAt')
    try:
        saved = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if saved.tzinfo is None:
            raise ValueError('missing_timezone')
        saved = saved.astimezone(timezone(timedelta(hours=8)))
    except (AttributeError, TypeError, ValueError):
        return {'writtenAt': None, 'relativeDates': None}
    return {'writtenAt': saved.isoformat(timespec='minutes'), 'relativeDates': {
        label: (saved + timedelta(days=days)).date().isoformat()
        for days, label in enumerate(('今天', '明天', '后天'))}}


def suggestion_applies(profile, start, end):
    """Do not turn a clearly dated, one-off plan into a permanent preference.

    Unspecified dates stay applicable. Ambiguous prose is left to the model;
    this guard only handles explicit ISO dates and anchored relative dates.
    """
    note = (profile or {}).get('settings', {}).get('weekendNote', '')
    relative = suggestion_context(profile)['relativeDates'] or {}
    dates = set(re.findall(r'(?<!\d)20\d{2}-\d{2}-\d{2}(?!\d)', note))
    for pattern, label in ((r'今天|今晚|今早|今日', '今天'), (r'明天|明晚|明早|明日', '明天'),
                           (r'后天|后日', '后天')):
        if re.search(pattern, note) and label in relative:
            dates.add(relative[label])
    return not dates or any(str(start) <= day <= str(end) for day in dates)


def load():
    try:
        request = urllib.request.Request(ENDPOINT, headers={
            'User-Agent': 'ZrBacNews/1.0'})
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
