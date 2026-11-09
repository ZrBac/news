"""Daily home variations and conservative, source-proved evening sessions."""
import hashlib
import json
import re
import math
from urllib.parse import urlencode
from datetime import timedelta
from pathlib import Path

import collect_news as news

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'tonight-v2'


def update_weather(previous, now, get=news.fetch):
    """Evening decisions use hourly forecasts, independently of optional AI work."""
    checked = news.parse_date(previous.get('updatedAt'))
    if previous.get('area') == '杭州五常附近' and checked and timedelta(0) <= now-checked < timedelta(minutes=55):
        return previous
    result = dict(previous)
    try:
        query = urlencode({'latitude':30.27, 'longitude':120.02, 'timezone':'Asia/Shanghai',
            'forecast_days':2, 'wind_speed_unit':'kmh',
            'hourly':'precipitation_probability,precipitation,wind_speed_10m,weather_code'})
        data = json.loads(get('https://api.open-meteo.com/v1/forecast?' + query))
        units, hours = data.get('hourly_units',{}), data.get('hourly',{})
        if data.get('timezone') != 'Asia/Shanghai' or units.get('wind_speed_10m') != 'km/h' or units.get('precipitation') != 'mm':
            raise ValueError('weather_units')
        rows = []
        for i, stamp in enumerate(hours.get('time',[])):
            if stamp[11:13] not in ('19','20','21','22'):
                continue
            row = {'time':stamp, **{key:hours[field][i] for key,field in (
                ('rainProbability','precipitation_probability'), ('rainMm','precipitation'),
                ('windKmh','wind_speed_10m'), ('code','weather_code'))}}
            if not all(isinstance(row[k],(int,float)) and math.isfinite(row[k]) for k in ('rainProbability','rainMm','windKmh','code')):
                continue
            rows.append(row)
        if not rows:
            raise ValueError('weather_empty')
        result = {'updatedAt':news.iso(now),'status':'ok','hours':rows,'source':'Open-Meteo','area':'杭州五常附近'}
    except Exception:
        result.update(status='unavailable',attemptedAt=news.iso(now))
    return result


def catalog():
    return json.loads((ROOT / 'news/tonight.json').read_text())['activities']


def object_schema(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


HOME_SCHEMA = object_schema({'ideas': {'type': 'array', 'items': object_schema({
    'id': {'type': 'string'}, 'name': {'type': 'string'}, 'summary': {'type': 'string'},
    'steps': {'type': 'array', 'items': {'type': 'string'}},
})}})


def update_home(client, previous, now, force=False):
    today = str(now.astimezone(news.BEIJING).date())
    if not force and previous.get('day') == today and previous.get('revision') == REVISION:
        return previous
    attempted = news.parse_date(previous.get('attemptedAt'))
    if not force and attempted and now - attempted < timedelta(minutes=55):
        return previous
    records = client.state.get('outingProfile', {}).get('records', [])
    dismissed = {r['id'] for r in records if r.get('status') == 'dismiss'}
    templates = [p for p in catalog() if p['setting'] == 'home' and p['id'] not in dismissed and p.get('project')]
    templates.sort(key=lambda p: hashlib.sha256((today + p['id']).encode()).hexdigest())
    selected = templates[:8]
    if not selected:
        return {'revision': REVISION, 'day': today, 'updatedAt': news.iso(now), 'status': 'ok', 'ideas': []}
    result, _ = client.ask('tonight_home',
        '为两个人下班后可持续做的兴趣项目，提供第一次开始时的具体选题，保留id。'
        '每项写短标题、20—45字说明和恰好三步。围绕模板project.outcome，留下能保存的作品、笔记或练习记录。'
        '最后一步必须说清楚留下什么以及下次接着做什么；不要写做完即丢的一次性小游戏。'
        '例如第一次写一个场景、整理一次出游的三张照片、记录一道菜的实际用量，而不是泛泛建议培养兴趣。'
        '这些只是未开始项目的可选起步题；网站会保留已开始项目的进展，不要要求每天换书、换主题或从头再来。'
        '严格保持原有时长、精力要求、已有材料和兴趣方向，不增购道具、不默认有游戏主机或会员。'
        '疲惫时只给轻松的小事，晚到家不安排外出、烹饪大餐或超过40分钟的活动。'
        '阅读、音乐、看片和语言练习用已有内容，不编造作品、原文、平台片源、外语例句或价格。'
        '每步最多65字，标题最多26字。不要外链、健康功效、私人信息、工作任务、打卡口号和消费推荐。'
        '生成的安排公开展示，不提个人记录。最多8项，无法写好可少给。',
        {'date': today, 'templates': selected,
         'recentThemes': [p.get('name', '') for p in previous.get('ideas', [])]}, HOME_SCHEMA)
    allowed = {p['id'] for p in selected}
    ideas, seen = [], set()
    for idea in result.get('ideas', [])[:8]:
        if not isinstance(idea, dict) or idea.get('id') not in allowed or idea['id'] in seen:
            continue
        name, summary, steps = idea.get('name'), idea.get('summary'), idea.get('steps')
        if (not isinstance(name, str) or not 3 <= len(name) <= 40 or
                not isinstance(summary, str) or not 8 <= len(summary) <= 100 or
                not isinstance(steps, list) or len(steps) != 3 or
                not all(isinstance(step, str) and 6 <= len(step) <= 120 for step in steps)):
            continue
        if re.search(r'https?://|<[^>]*>|充值|购买会员|减脂|治疗|治愈失眠', name + summary + ''.join(steps)):
            continue
        ideas.append({'id': idea['id'], 'name': name, 'summary': summary, 'steps': steps})
        seen.add(idea['id'])
    if not ideas:
        raise ValueError('no_valid_home_ideas')
    return {'revision': REVISION, 'day': today, 'updatedAt': news.iso(now), 'status': 'ok', 'ideas': ideas}


def evening_slot(candidate, today):
    """A date range alone does not prove an evening opening or a session time."""
    if not candidate.get('start', '') <= today <= candidate.get('end', ''):
        return None
    month, day = map(int, today[5:].split('-'))
    for fact in candidate.get('facts', []):
        text = fact.get('text', '')
        if fact.get('kind') != 'date':
            continue
        dated = today in text or bool(re.search(rf'(?<!\d)0?{month}月\s*0?{day}日', text))
        daily = bool(re.search(r'每日|每天', text)) and not re.search(r'除外|周[一二三四五六日天]|闭馆', text)
        # Multiple session dates in one sentence are ambiguous; don't move a time
        # from one day to another. A separate, unambiguous date fact is required.
        dates = {(int(m), int(d)) for m, d in re.findall(r'(\d{1,2})月\s*(\d{1,2})日', text)}
        iso_dates = set(re.findall(r'\d{4}-\d{2}-\d{2}', text))
        if len(dates) > 1 or (iso_dates and iso_dates != {today}) or not (dated or daily):
            continue
        times = re.findall(r'(?<!\d)([0-2]?\d)[:：]([0-5]\d)(?!\d)', text)
        if len(times) != 2:
            continue
        start, end = [int(h) * 60 + int(m) for h, m in times]
        if not 20 * 60 <= start < end <= 22 * 60 or not 20 <= end - start <= 90:
            continue
        return {'startTime': f'{start // 60:02}:{start % 60:02}', 'endTime': f'{end // 60:02}:{end % 60:02}',
                'minutes': end - start, 'timeEvidence': text}
    return None


def evening_events(candidates, now):
    today = str(now.astimezone(news.BEIJING).date())
    result, seen = [], set()
    for p in candidates:
        if re.search(r'演唱会|博物馆|亲子|观赛|攀岩|抱石|滑冰|溜冰|冰场', p.get('name', '')):
            continue
        # Nearby is a search area, not a claim about an individual's drive time.
        if not p.get('discovery') or p.get('region') != 'hangzhou' or not re.search(
                r'西湖区|余杭区|五常|未来科技城|蒋村|留下|梦想小镇|文一西路', p.get('area', '')):
            continue
        slot = evening_slot(p, today)
        if not slot or p['id'] in seen or not p.get('sources'):
            continue
        seen.add(p['id'])
        result.append({**p, **slot, 'day': today})
    return result[:8]
