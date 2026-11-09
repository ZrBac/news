"""News collection slots in Beijing time, independent of outing publications."""
import argparse
import copy
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

BEIJING = timezone(timedelta(hours=8))
HOURS = (9, 11, 13, 15, 17, 19, 21)


def parse(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result if result.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def latest_slot(now):
    local = now.astimezone(BEIJING)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return max([day - timedelta(days=1) + timedelta(hours=21)] +
               [day + timedelta(hours=hour) for hour in HOURS if hour <= local.hour])


def next_slot(now):
    local = now.astimezone(BEIJING)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return min([day + timedelta(days=1, hours=9)] +
               [day + timedelta(hours=hour) for hour in HOURS if hour > local.hour])


def should_collect(previous, now, mode='auto'):
    if mode == 'force':
        return True
    if mode == 'skip' or not 9 <= now.astimezone(BEIJING).hour <= 21:
        return False
    checked = parse(previous.get('newsCheckedAt') or previous.get('updatedAt'))
    return not checked or checked < latest_slot(now)


def reuse(previous, now):
    data = copy.deepcopy(previous)
    data['newsCheckedAt'] = previous.get('newsCheckedAt') or previous['updatedAt']
    # Publication time still advances so outing/manual refresh clients can
    # discover the new packet. It must not disguise old news as newly checked.
    data['updatedAt'] = now.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    return data


def collection_gap(previous, now):
    """A missed daytime slot breaks observation; the scheduled night pause doesn't."""
    return now > next_slot(previous) + timedelta(hours=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('news/data/news.json'))
    parser.add_argument('--mode', choices=('auto', 'force', 'skip'), default='auto')
    args = parser.parse_args()
    previous = json.loads(args.previous_file.read_text())
    now = datetime.now(timezone.utc)
    collect = should_collect(previous, now, args.mode)
    if not collect:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(reuse(previous, now), ensure_ascii=False, separators=(',', ':')) + '\n')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'collect={str(collect).lower()}\n')
    print('News collection: ' + ('refresh' if collect else 'reuse previous publication; no news AI calls'))


if __name__ == '__main__':
    main()
