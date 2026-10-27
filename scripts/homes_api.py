#!/usr/bin/env python3
"""Private single-household notebook and public candidate feed (WSGI).

Serve behind HTTPS with gunicorn. Only a SHA-256 access-token hash is configured;
there is no public registration or arbitrary URL fetching endpoint.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import urllib.parse

MAX_BODY = 60 * 1024 * 1024
ID = re.compile(r'[a-zA-Z0-9_-]{1,80}\Z')


def candidate_fits(item):
    """Public candidates must meet both requirements; unknowns stay excluded."""
    if not isinstance(item, dict):
        return False
    areas, layout = item.get('areas'), item.get('layout')
    if (not isinstance(areas, list) or len(areas) != 2
            or any(type(a) not in (int, float) or not math.isfinite(a) for a in areas)
            or not 100 <= areas[0] <= areas[1] or not isinstance(layout, str)):
        return False
    numerals = dict(zip('零〇一二两三四五六七八九十', (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10)))
    layout = re.sub(r'[零〇一二两三四五六七八九十]+', lambda m: str(numerals.get(m[0], 0)), layout)
    groups = re.findall(r'(\d+(?:\.\d+)?(?:\s*[-–—~/、至到]\s*\d+(?:\.\d+)?)*)\s*(?:室|居)', layout)
    rooms = [float(n) for group in groups for n in re.findall(r'\d+(?:\.\d+)?', group)]
    return bool(rooms) and all(n.is_integer() and n >= 3 for n in rooms)


def require(test, message='记录格式不正确'):
    if not test:
        raise ValueError(message)


def object_value(value):
    require(isinstance(value, dict))
    return value


def text_value(value, limit):
    require(isinstance(value, str) and len(value) <= limit)


def number(value, limit=100000, minimum=0, nullable=True):
    if value is None and nullable:
        return
    require(type(value) in (int, float) and math.isfinite(value) and minimum <= value <= limit)


def choice(value, values):
    require(value in values)


def valid_date(value, optional=False):
    if value == '' and optional:
        return
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value))
    dt.date.fromisoformat(value)


def valid_stamp(value):
    text_value(value, 40)
    dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def entries(value, limit):
    require(isinstance(value, list) and len(value) <= limit)
    seen = set()
    for item in value:
        object_value(item)
        key = item.get('id')
        require(isinstance(key, str) and ID.fullmatch(key) and key not in seen)
        seen.add(key)
    return value


def validate(state):
    object_value(state)
    require(state.get('schema') == 1 and type(state.get('schema')) is int, '不支持此记录版本')
    require(type(state.get('revision')) is int and 0 <= state['revision'] < 2**53)
    p = object_value(state.get('profile'))
    for field in ('budgetMin', 'budgetMax'):
        number(p.get(field))
    if p.get('budgetMin') is not None and p.get('budgetMax') is not None:
        require(p['budgetMin'] <= p['budgetMax'])
    text_value(p.get('areas'), 300)
    choice(p.get('priority'), ('new', 'resale', 'any'))
    choice(p.get('driver'), ('undecided', 'yungu', 'xixi'))
    for field in ('maxDrive', 'maxTransit'):
        number(p.get(field), 600)
    for home in entries(state.get('homes'), 500):
        for field, limit in [('name', 100), ('district', 100), ('address', 300), ('layout', 100), ('detail', 1000), ('reason', 1000), ('sourceUrl', 2000)]:
            text_value(home.get(field), limit)
        require(bool(home['name'].strip()))
        if home['sourceUrl']:
            url = urllib.parse.urlsplit(home['sourceUrl'])
            require(url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password)
        for field in ('createdAt', 'updatedAt'):
            valid_stamp(home.get(field))
        choice(home.get('kind'), ('new', 'resale'))
        choice(home.get('status'), ('planned', 'visited', 'shortlist', 'rejected'))
        number(home.get('size'), 10000, .01)
        costs = object_value(home.get('costs'))
        for field in ('parking', 'tax', 'decoration'):
            number(costs.get(field))
        c = object_value(home.get('commute'))
        choice(c.get('driver'), ('undecided', 'yungu', 'xixi'))
        text_value(c.get('station'), 100)
        text_value(c.get('note'), 1000)
        valid_date(c.get('date'), optional=True)
        for field in ('driverTotal', 'detour', 'drop', 'wait', 'metro', 'lastLeg'):
            number(c.get(field), 600)
        for price in entries(home.get('prices'), 300):
            number(price.get('amount'), minimum=.01, nullable=False)
            choice(price.get('type'), ('asking', 'quoted', 'contract'))
            text_value(price.get('source'), 300)
            valid_date(price.get('date'))
            valid_stamp(price.get('createdAt'))
        for visit in entries(home.get('visits'), 200):
            valid_date(visit.get('date'))
            text_value(visit.get('note'), 4000)
            photos = visit.get('photos')
            require(isinstance(photos, list) and len(photos) <= 6)
            for photo in photos:
                text_value(photo, 1500000)
                require(re.fullmatch(r'data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}', photo))
    return state


@contextmanager
def connect(path):
    conn = sqlite3.connect(path, timeout=10)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('CREATE TABLE IF NOT EXISTS notebook (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, state TEXT, saved_at TEXT)')
    conn.execute('INSERT OR IGNORE INTO notebook VALUES (1, 0, NULL, NULL)')
    conn.commit()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


class Application:
    def __init__(self, directory=None, token_hash=None, origins=None):
        self.directory = Path(directory or os.environ.get('HOMES_STATE_DIR', '/var/lib/zrbac-homes'))
        self.directory.mkdir(parents=True, exist_ok=True)
        self.token_hash = token_hash if token_hash is not None else os.environ.get('HOMES_TOKEN_SHA256', '')
        require(bool(re.fullmatch(r'[a-f0-9]{64}', self.token_hash)), 'HOMES_TOKEN_SHA256 is required')
        self.origins = set(origins or ['https://news.zacai.fun'])
        self.path = self.directory / 'notebook.sqlite3'
        with connect(self.path):
            pass

    def __call__(self, env, respond):
        path, method, origin = env.get('PATH_INFO', ''), env['REQUEST_METHOD'], env.get('HTTP_ORIGIN', '')
        headers = [('Content-Type', 'application/json; charset=utf-8'), ('Cache-Control', 'no-store'),
                   ('X-Content-Type-Options', 'nosniff'), ('Vary', 'Origin')]
        if origin in self.origins:
            headers.append(('Access-Control-Allow-Origin', origin))
        def answer(code, value, extra=()):
            raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
            titles = {200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
                      405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type', 503: 'Service Unavailable'}
            respond(f'{code} {titles[code]}', headers + list(extra) + [('Content-Length', str(len(raw)))])
            return [raw]
        if origin and origin not in self.origins:
            return answer(403, {'error': '此来源不允许访问'})
        if path not in ('/api/homes/candidates', '/api/homes/notebook', '/api/homes/health'):
            return answer(404, {'error': '未找到'})
        if method == 'OPTIONS':
            return answer(200, {}, [('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS'),
                                    ('Access-Control-Allow-Headers', 'Authorization, Content-Type'), ('Access-Control-Max-Age', '3600')])
        if path == '/api/homes/health' and method == 'GET':
            return answer(200, {'ok': True})
        if path == '/api/homes/candidates' and method == 'GET':
            try:
                data = json.loads((self.directory / 'candidates.json').read_text())
            except (OSError, ValueError):
                return answer(503, {'error': '候选列表暂未准备好'})
            data['items'] = [item for item in data.get('items', []) if candidate_fits(item)]
            return answer(200, data)
        if path != '/api/homes/notebook' or method not in ('GET', 'PUT'):
            return answer(405, {'error': '不支持此操作'})
        auth = env.get('HTTP_AUTHORIZATION', '')
        supplied = auth[7:] if auth.startswith('Bearer ') else ''
        if len(supplied) > 200 or not hmac.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(), self.token_hash):
            return answer(401, {'error': '请输入有效的私人同步码'})
        if method == 'GET':
            with connect(self.path) as conn:
                revision, state, saved_at = conn.execute('SELECT revision,state,saved_at FROM notebook WHERE id=1').fetchone()
            since = urllib.parse.parse_qs(env.get('QUERY_STRING', '')).get('since', [''])[0]
            if since == str(revision):
                return answer(200, {'revision': revision, 'savedAt': saved_at, 'unchanged': True})
            return answer(200, {'revision': revision, 'state': json.loads(state) if state else None, 'savedAt': saved_at})
        if env.get('CONTENT_TYPE', '').split(';')[0].strip() != 'application/json':
            return answer(415, {'error': '需要 JSON 记录'})
        try:
            length = int(env.get('CONTENT_LENGTH', '0'))
        except ValueError:
            return answer(400, {'error': '请求长度无效'})
        if not 0 < length <= MAX_BODY:
            return answer(413, {'error': '记录和照片最多 60 MB'})
        try:
            data = json.loads(env['wsgi.input'].read(length))
            object_value(data)
            base = data.get('baseRevision')
            require(type(base) is int and base >= 0)
            state = validate(data.get('state'))
            encoded = json.dumps(state, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
            return answer(400, {'error': '记录格式无效，服务器上的原有记录未改变'})
        saved_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
        with connect(self.path) as conn:
            conn.execute('BEGIN IMMEDIATE')
            revision = conn.execute('SELECT revision FROM notebook WHERE id=1').fetchone()[0]
            if revision != base:
                return answer(409, {'error': '另一设备已更新，请先合并两边记录', 'revision': revision})
            conn.execute('UPDATE notebook SET revision=?,state=?,saved_at=? WHERE id=1', (revision + 1, encoded, saved_at))
        return answer(200, {'revision': revision + 1, 'savedAt': saved_at})


def backup(directory):
    directory = Path(directory)
    target = directory / 'backups'
    target.mkdir(mode=0o700, exist_ok=True)
    path = target / (dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d') + '.sqlite3')
    with connect(directory / 'notebook.sqlite3') as source, sqlite3.connect(path) as dest:
        source.backup(dest)
    for old in sorted(target.glob('*.sqlite3'))[:-14]:
        old.unlink()


def create_app():
    return Application()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--directory', default='/var/lib/zrbac-homes')
    args = parser.parse_args()
    if args.backup:
        backup(args.directory)
