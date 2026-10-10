#!/usr/bin/env python3
"""Collect public RSS metadata. Standard library only; never execute feed content."""
import argparse
import concurrent.futures
import gzip
import hashlib
import html
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
QUALITY_WINDOW_DAYS = 7
AI_PATTERN = re.compile(
    r'(?<![a-z0-9])(?:AI|AGI|LLMs?|GPT[a-z0-9_.-]*|ChatGPT|OpenAI|Anthropic|'
    r'Claude|Gemini|Copilot|DeepSeek[a-z0-9_.-]*|Qwen[a-z0-9_.-]*|Llama|Codex|'
    r'GLM[a-z0-9_.-]*|Kimi|MiniMax|Grok|Qoder|Cursor|Windsurf|Kiro|'
    r'RAG|MCP|agents?)(?![a-z0-9])|人工智能|大模型|语言模型|生成式|机器学习|'
    r'智能体|通义|千问|智谱|豆包|具身智能', re.I)
FINANCE_TOPIC = re.compile(r'股价|股票|股市|投资标的|标普|纳斯达克|证券|盈利增长|盈利预计|业绩预测|财报')
HARDWARE_TOPIC = re.compile(r'芯片|显卡|处理器|服务器|主板|内存|固态硬盘|显示器|电源|工作站|迷你电脑|'
                            r'(?<![a-z0-9])(?:GPU|CPU|NPU|SSD|RTX|DGX)(?![a-z0-9])', re.I)
SYSTEM_PRODUCT = re.compile(r'(?<![a-z0-9])(?:Edge|Chrome|Firefox|Windows|Android|HarmonyOS|'
                            r'iOS|macOS|Linux)(?![a-z])|安卓|鸿蒙|浏览器|操作系统', re.I)
SYSTEM_UPDATE = re.compile(r'稳定版|测试版|更新|升级|发布|推出|正式版')
ENTERTAINMENT_TOPIC = re.compile(
    r'电影|影视|影坛|电视剧|剧集|网剧|短剧|舞台剧|话剧|歌剧|音乐剧|综艺|票房|演员|导演|'
    r'编剧|艺人|明星|歌手|音乐|乐队|新歌|专辑|演唱会|演出|剧院|艺术节|戏剧|芭蕾|舞蹈|'
    r'脱口秀|娱乐圈|颁奖|飞天奖|金鸡奖|百花奖|戛纳|奥斯卡|格莱美|文艺|文娱|'
    r'小说|作家|文学|出版|鲁奖|舞台|博物馆|越剧|京剧|诺贝尔文学奖|'
    r'\b(?:film|movie|actor|actress|cinema|music|album|singer|concert|theater|theatre|TV)\b', re.I)
ENTERTAINMENT_NOISE = re.compile(r'^梦见|周公解梦|解梦|星座运势|生肖运势|算命|八字命理')
SPORTS_PROMOTION = re.compile(r'彩经|竞彩|足彩|赔率|盘口|投注|半全场|亚盘|让球|胜负彩|投注技巧')
SPORTS_DISCIPLINE = re.compile(r'违规|禁赛|被罚|赌球案|赌博案|投注案|刑事|涉嫌.*(?:赌博|投注)')

MODEL_NAME = re.compile(
    r'GPT[-\s]?\d|gpt-oss|\bo[134](?:\b|-)|Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos|\d)|'
    r'Gemini\s*\d|(?:Embedding)?Gemma|DeepSeek|Qwen[-\w.]*|Llama\s*\d|Grok[-\s]*\d|'
    r'Mistral[-\s]*(?:Large|Small|Medium|Nemo)|GLM[-\s]?\d|Kimi|MiniMax|'
    r'Sora|Veo[-\s]*\d|Imagen[-\s]*\d|Seedream|Seedance|Hunyuan|Wan[-\s]*\d|'
    r'通义|智谱|豆包|混元|文心|千问', re.I)
MODEL_TOPIC = re.compile(r'模型|\b(?:models?|LLMs?)\b', re.I)
MODEL_VERSION = re.compile(r'GPT[-\s]?\d|gpt-oss|\bo[134](?:\b|-)|'
                           r'Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)\s*\d|Gemini\s*\d|'
                           r'(?:Embedding)?Gemma|DeepSeek[-\s]?(?:V|R|Math|Coder|OCR)\d|'
                           r'Qwen[-\w.]*\d|Llama\s*\d|Grok[-\s]*\d|GLM[-\s]?\d|'
                           r'Kimi[-\s]?K\d|MiniMax[-\s]?M\d|Mistral[-\s]*(?:Large|Small|Medium)|'
                           r'Seedream|Seedance|Veo[-\s]*\d|Imagen[-\s]*\d', re.I)
MODEL_RELEASE = re.compile(r'发布|推出|上线|开源|升级|开放|正式商用|亮相|'
                           r'\b(?:introducing|announc\w*|launch\w*|releas\w*|unveil\w*|debut\w*|'
                           r'upgrad\w*|available|open[- ](?:source|weight))\b', re.I)
MODEL_RUMOR = re.compile(r'即将|或将|有望|预计|传闻|据传|消息称|爆料|泄露|曝光|不等|提议|计划|'
                         r'\b(?:rumou?rs?|leaked?|reportedly|upcoming|expected)\b', re.I)
MODEL_PRODUCT = re.compile(r'智能体|\bagent\b|插件|画布|登陆|登录|客户端|应用商店|'
                           r'Claude Code|ChatGPT|\b(?:canvas|extension|app)\b', re.I)
MODEL_OTHER_NEWS = re.compile(r'巴士|汽车|氢燃料|基础组件|芯片软件|代码库|开源.*王座|额度|对话服务|'
                              r'早报|午报|新品一览|审批机制|\b(?:DGX|RTX|GPU)\b', re.I)
OFFICIAL_MODEL_SOURCES = {'openai-models', 'gnews-anthropic-models', 'gnews-qwen-models', 'deepmind'}


def is_model_release(title, source_id=''):
    title = title.rsplit(' - ', 1)[0]
    if MODEL_RUMOR.search(title) or MODEL_OTHER_NEWS.search(title):
        return False
    named = MODEL_NAME.search(title)
    topic = MODEL_TOPIC.search(title)
    if not named and not (topic and AI_PATTERN.search(title)):
        return False
    if not topic and not MODEL_VERSION.search(title):
        return False
    # A branded app or agent receiving a feature is not a model launch.
    if MODEL_PRODUCT.search(title):
        return False
    if re.search(r'押注|采用|评测|如何|教程', title) and not re.search(r'发布|推出|上线|升级|开放|亮相', title):
        return False
    if MODEL_RELEASE.search(title):
        return True
    # Official model posts often use “Qwen-X: ...” or “Gemini X: ...”.
    return bool(source_id in OFFICIAL_MODEL_SOURCES and named and named.start() <= 5
                and (':' in title or '：' in title))


def article_category(title, source):
    title = title.rsplit(' - ', 1)[0]
    category = source['category']
    if category == 'entertainment':
        if ENTERTAINMENT_NOISE.search(title):
            return None
        if source.get('titleFilter') == 'entertainment' and not ENTERTAINMENT_TOPIC.search(title):
            return None
        return category
    if category == 'gaming':
        return category
    if category == 'sports':
        return None if SPORTS_PROMOTION.search(title) and not SPORTS_DISCIPLINE.search(title) else category
    if category == 'housing':
        return category if is_hangzhou_housing(title) else None
    if is_model_release(title, source['id']):
        return 'models'
    if category == 'models':
        return None
    if FINANCE_TOPIC.search(title):
        return 'general'
    if HARDWARE_TOPIC.search(title) or (SYSTEM_PRODUCT.search(title) and SYSTEM_UPDATE.search(title)):
        return 'tech'
    if AI_PATTERN.search(title):
        return 'ai'
    # Specialized AI feeds remain useful when the headline omits “AI”.
    if category == 'ai':
        return category
    if category == 'tech' and GAMING_TOPIC.search(title):
        return 'gaming'
    return category

GAMING_TOPIC = re.compile(r'游戏|电玩|电竞|\b(?:Steam|Xbox|PlayStation|PS5|PS6)\b|任天堂|育碧|卡普空|塞尔达|黑神话|宝可梦|怪物猎人', re.I)

HOUSING_LOCATION = re.compile(r'杭州|余杭|萧山|临平|钱塘|拱墅|临安|富阳')
HOUSING_TOPIC = re.compile(r'楼市|房地产|房产|住房|住宅|二手房|新房|购房|买房|卖房|房价|房贷|公积金|土拍|宅地|涉宅|预售|网签|土地出让|地块成交|楼盘|新盘|户型|示范区|样板房|现房|交房')
HOUSING_NOISE = re.compile(r'票房|电影|演唱会|门票|股市|股指|美股|港股|股债|彩票')


def is_hangzhou_housing(title):
    # Google News appends the publisher name; “杭州网” is not story location evidence.
    title = title.rsplit(' - ', 1)[0]
    return bool(HOUSING_LOCATION.search(title) and HOUSING_TOPIC.search(title) and not HOUSING_NOISE.search(title))


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag in ('p', 'br', 'div', 'li'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(html.unescape(value or ''))
    return re.sub(r'\s+', ' ', ''.join(parser.parts)).strip()


def parse_date(value):
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (ValueError, TypeError, OverflowError):
        try:
            dt = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        except (ValueError, TypeError):
            return None
    # An undated/timezone-less story must not masquerade as a current story.
    return dt.astimezone(UTC) if dt.tzinfo is not None else None


def iso(dt):
    return dt.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def safe_url(value):
    try:
        url = urllib.parse.urlsplit((value or '').strip())
        if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password:
            return None
        query = [(k, v) for k, v in urllib.parse.parse_qsl(url.query, keep_blank_values=True)
                 if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
        return urllib.parse.urlunsplit((url.scheme, url.netloc, url.path, urllib.parse.urlencode(query), ''))
    except ValueError:
        return None


def fetch(url, max_bytes=5_000_000):
    request = urllib.request.Request(url, headers={'User-Agent': 'ZrBacNews/1.0 (+https://news.zacai.fun/)', 'Accept': 'application/rss+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.5'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(max_bytes + 1)
        encoding = response.headers.get('Content-Encoding', '').strip().lower()
    if len(data) > max_bytes:
        raise ValueError('Response exceeds size limit')
    # urllib does not decode compressed HTTP responses. Some feeds send gzip
    # even without Accept-Encoding, and proxies occasionally omit the header.
    if encoding in ('gzip', 'x-gzip') or data.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
            data = compressed.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError('Decompressed response exceeds size limit')
    return data


def parse_feed(data, source, now):
    root = ET.fromstring(data)
    articles = []
    rss1 = '{http://purl.org/rss/1.0/}'
    # RSS 1.0/RDF uses namespaced fields (for example DW); RSS 2.0 does not.
    items = root.findall('.//item') + root.findall(f'.//{rss1}item')
    for item in items[:120]:
        def field(name):
            return item.findtext(name) or item.findtext(rss1 + name) or ''
        title = plain(field('title'))[:240]
        url = safe_url(field('link'))
        date = parse_date(item.findtext('pubDate') or item.findtext('{http://purl.org/dc/elements/1.1/}date'))
        if not title or not url or not date or date > now + timedelta(minutes=10) or date < now - timedelta(days=30):
            continue
        if source['category'] == 'housing' and not is_hangzhou_housing(title):
            continue
        category = article_category(title, source)
        if not category:
            continue
        # Keep only a short publisher-provided excerpt; do not republish feed bodies.
        excerpt = plain(field('description'))
        excerpt = re.sub(r'^(?:IT之家|爱范儿)\s*\d+\s*月\s*\d+\s*日(?:消息|讯)[，,：:\s]*', '', excerpt)
        excerpt = excerpt[:89].rstrip() + '…' if len(excerpt) > 90 else excerpt
        articles.append({
            'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'title': title,
            'url': url, 'sourceId': source['id'], 'category': category,
            'publishedAt': iso(date), 'excerpt': excerpt,
        })
    return articles


class HousingDailyList(HTMLParser):
    """Read the publisher's dated news rows, excluding navigation and sidebars."""
    def __init__(self):
        super().__init__()
        self.items = []
        self.current = None
        self.depth = 0
        self.capture = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'li':
            if self.current is not None:
                self.depth += 1
            elif 'news_item' in attrs.get('class', '').split():
                self.current = {'url': '', 'title': [], 'date': []}
                self.depth = 1
        if self.current is None:
            return
        if tag == 'a' and not self.current['url']:
            self.current['url'] = attrs.get('href', '')
        if tag == 'h2':
            self.capture = 'title'
        if tag == 'span' and 'time' in attrs.get('class', '').split():
            self.capture = 'date'

    def handle_data(self, data):
        if self.current is not None and self.capture:
            self.current[self.capture].append(data)

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if (tag == 'h2' and self.capture == 'title') or (tag == 'span' and self.capture == 'date'):
            self.capture = None
        if tag == 'li':
            self.depth -= 1
            if self.depth == 0:
                self.items.append(self.current)
                self.current = None
                self.capture = None


def parse_housing_daily(data, source, now):
    parser = HousingDailyList()
    parser.feed(data.decode('utf-8'))
    articles = []
    for item in parser.items[:120]:
        url = safe_url(urllib.parse.urljoin(source['url'], item['url']))
        title = plain(''.join(item['title']))[:240]
        date = re.search(r'\d{4}-\d{2}-\d{2}', ''.join(item['date']))
        date = parse_date(date[0] + 'T00:00:00+08:00') if date else None
        # Only accept the source's own daily-bulletin pages and explicit dates.
        if not url or not re.fullmatch(r'https://zzhz\.zjol\.com\.cn/hz/bb/\d{6}/t\d{8}_\d+\.shtml', url):
            continue
        if not title or not date or not now - timedelta(days=30) <= date <= now + timedelta(minutes=10):
            continue
        if article_category(title, source) != 'housing':
            continue
        articles.append({'id': hashlib.sha256(url.encode()).hexdigest()[:16],
                         'title': title, 'url': url, 'sourceId': source['id'],
                         'category': 'housing', 'publishedAt': iso(date), 'excerpt': ''})
    return articles


def collect(source, now):
    status = {k: source[k] for k in ('id', 'name', 'home', 'category', 'color')}
    status['checkedAt'] = iso(now)
    started = time.monotonic()
    try:
        parser = parse_housing_daily if source.get('format') == 'housing-daily-list' else parse_feed
        articles = parser(fetch(source['url']), source, now)
        if not articles:
            raise ValueError('No dated articles from the last 30 days')
        status.update(status='ok', fetchedCount=len(articles), latestAt=max(a['publishedAt'] for a in articles),
                      durationMs=round((time.monotonic() - started) * 1000))
        return articles, status
    except Exception as exc:
        print(f"Source {source['id']} unavailable: {exc}", file=sys.stderr)
        status.update(status='unavailable', fetchedCount=0, durationMs=round((time.monotonic() - started) * 1000))
        return [], status


def merge_articles(previous, incoming, now, allowed_sources):
    by_url = {}
    for article in previous + incoming:
        if not isinstance(article, dict):
            continue
        url = safe_url(article.get('url'))
        date = parse_date(article.get('publishedAt'))
        if not url or not date or not now - timedelta(days=30) <= date <= now + timedelta(minutes=10):
            continue
        if article.get('sourceId') not in allowed_sources or article.get('category') not in ('general', 'tech', 'ai', 'models', 'entertainment', 'gaming', 'sports', 'housing'):
            continue
        if article.get('category') == 'housing' and not is_hangzhou_housing(str(article.get('title', ''))):
            continue
        clean = {key: str(article.get(key, '')) for key in ('title', 'sourceId', 'category', 'publishedAt', 'excerpt')}
        clean.update(url=url, id=hashlib.sha256(url.encode()).hexdigest()[:16], title=plain(clean['title'])[:240], excerpt=plain(clean['excerpt'])[:90])
        # Reapply current source rules to the archive as well as new stories.
        source = allowed_sources[clean['sourceId']] if isinstance(allowed_sources, dict) else {
            'id': clean['sourceId'], 'category': clean['category']}
        clean['category'] = article_category(clean['title'], source)
        if not clean['category']:
            continue
        if clean['title']:
            by_url[url] = clean
    # Exact duplicate titles from the same publisher are revisions, not new stories.
    seen = set()
    result = []
    for article in sorted(by_url.values(), key=lambda a: a['publishedAt'], reverse=True):
        key = (article['sourceId'], re.sub(r'\W', '', article['title']).casefold())
        if key not in seen:
            seen.add(key)
            result.append(article)
    if len(result) <= 6000:
        return result
    # Reserve part of the archive for every category and distribute that reserve
    # among its sources. Unused places go to the newest remaining stories.
    protected = set()
    for category in ('general', 'tech', 'ai', 'models', 'entertainment', 'gaming', 'sports', 'housing'):
        pool = [article for article in result if article['category'] == category]
        if not pool:
            continue
        budget = min(750, len(pool))
        share = max(1, budget // len({article['sourceId'] for article in pool}))
        chosen, counts = [], {}
        for article in pool:
            source = article['sourceId']
            if counts.get(source, 0) < share and len(chosen) < budget:
                chosen.append(article)
                counts[source] = counts.get(source, 0) + 1
        selected = {article['id'] for article in chosen}
        for article in pool:
            if len(selected) >= budget:
                break
            selected.add(article['id'])
        protected.update(selected)
    selected = set(protected)
    for article in result:
        if len(selected) >= 6000:
            break
        selected.add(article['id'])
    return [article for article in result if article['id'] in selected]


def recent_model_releases(previous, incoming, now, allowed_sources):
    def candidates(articles):
        return [a for a in articles if isinstance(a, dict)
                and a.get('category') in ('general', 'tech', 'ai', 'models')
                and is_model_release(str(a.get('title', '')), a.get('sourceId', ''))]
    # Separate retention keeps less-frequent model announcements from being
    # pushed out by the shared 6,000-story archive. The builder removes copies.
    return merge_articles(candidates(previous), candidates(incoming), now, allowed_sources)[:120]


def recent_housing_articles(previous, incoming, now, allowed_sources):
    def candidates(articles):
        return [a for a in articles if isinstance(a, dict) and a.get('category') == 'housing']
    return merge_articles(candidates(previous), candidates(incoming), now, allowed_sources)[:120]


def quality_title_key(article):
    """Match same-day headlines, preserving version numbers and decimal points."""
    title = str(article.get('title', ''))
    if urllib.parse.urlsplit(article.get('url', '')).hostname == 'news.google.com':
        title = title.rsplit(' - ', 1)[0]
    title = re.sub(r'[\s“”‘’"\'「」『』《》〈〉，,。！!？?：:；;、（）()【】\[\]]', '', title).casefold()
    return hashlib.sha256(title.encode()).hexdigest()[:16]


def validate_quality_state(state):
    if (not isinstance(state, dict) or state.get('schema') != 1
            or not parse_date(state.get('startedAt')) or not parse_date(state.get('updatedAt'))
            or not isinstance(state.get('sources'), dict)):
        raise ValueError('Invalid previous source-quality history')
    for source in state['sources'].values():
        if (not isinstance(source, dict) or not isinstance(source.get('identity'), str)
                or not parse_date(source.get('startedAt'))
                or not isinstance(source.get('seen'), list) or not isinstance(source.get('daily'), list)
                or not isinstance(source.get('failureStreak'), int) or source['failureStreak'] < 0):
            raise ValueError('Invalid previous source-quality source')
        for field in ('lastCheckedAt', 'lastNewAt', 'noNewSince'):
            if source.get(field) is not None and not parse_date(source[field]):
                raise ValueError('Invalid previous source-quality timestamp')
        for row in source['seen']:
            if (not isinstance(row, list) or len(row) != 4
                    or not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{16}', value) for value in row[:2])
                    or not parse_date(row[2] + 'T00:00:00+08:00')
                    or (row[3] is not None and not parse_date(str(row[3]) + 'T00:00:00+08:00'))):
                raise ValueError('Invalid previous source-quality article')
        for day in source['daily']:
            if (not isinstance(day, dict) or not parse_date(str(day.get('date', '')) + 'T00:00:00+08:00')
                    or not all(type(day.get(key)) is int and day[key] >= 0
                               for key in ('checks', 'successes', 'newCount'))
                    or day['successes'] > day['checks']):
                raise ValueError('Invalid previous source-quality day')
    return state


def update_source_quality(previous_state, sources, statuses, incoming, baseline, now):
    """Persist observations independently of the shared 6,000-story archive."""
    if previous_state is not None:
        validate_quality_state(previous_state)
        if parse_date(previous_state['updatedAt']) > now:
            raise ValueError('Source-quality history is newer than this collection')
    stamp = iso(now)
    today = now.astimezone(BEIJING).date()
    first_day = (today - timedelta(days=QUALITY_WINDOW_DAYS - 1)).isoformat()
    oldest = (today - timedelta(days=30)).isoformat()
    state = {'schema': 1, 'startedAt': (previous_state or {}).get('startedAt', stamp),
             'updatedAt': stamp, 'sources': {}}
    status_by_id = {item['id']: item for item in statuses}
    incoming_by_source, baseline_by_source = {}, {}
    for collection, grouped in ((incoming, incoming_by_source), (baseline, baseline_by_source)):
        for article in collection:
            if isinstance(article, dict):
                grouped.setdefault(article.get('sourceId'), []).append(article)

    def record(article, observed):
        url, published = safe_url(article.get('url')), parse_date(article.get('publishedAt'))
        if not url or not published or not article.get('title') or not now - timedelta(days=30) <= published <= now + timedelta(minutes=10):
            return None
        return [hashlib.sha256(url.encode()).hexdigest()[:16], quality_title_key(article),
                published.astimezone(BEIJING).date().isoformat(), observed]

    for source in sources:
        source_id = source['id']
        identity = hashlib.sha256(json.dumps({key: source.get(key) for key in
            ('url', 'format', 'category', 'titleFilter')}, sort_keys=True).encode()).hexdigest()[:16]
        old = (previous_state or {}).get('sources', {}).get(source_id)
        fresh = not old or old['identity'] != identity
        if fresh:
            old = {'identity': identity, 'startedAt': stamp, 'seen': [], 'daily': [],
                   'failureStreak': 0, 'lastCheckedAt': None, 'lastNewAt': None, 'noNewSince': None}
        current = {**old, 'seen': [list(row) for row in old['seen']
                                  if row[2] >= oldest or (row[3] and row[3] >= first_day)],
                   'daily': [dict(day) for day in old['daily'] if day['date'] >= oldest]}
        seen = {row[0]: row for row in current['seen']}
        titles = {(row[1], row[2]) for row in current['seen']}
        # The first successful feed is a baseline, including older stories that
        # the public archive may already have evicted. Never invent past totals.
        initializing = fresh or not current.get('lastCheckedAt')
        if initializing:
            for article in baseline_by_source.get(source_id, []):
                row = record(article, None)
                if row:
                    seen[row[0]] = row
                    titles.add((row[1], row[2]))
        new_count = 0
        for article in incoming_by_source.get(source_id, []):
            row = record(article, today.isoformat())
            if not row or row[0] in seen:
                continue
            if initializing or (row[1], row[2]) in titles:
                row[3] = None
            else:
                new_count += 1
            seen[row[0]] = row
            titles.add((row[1], row[2]))
        current['seen'] = list(seen.values())
        day = next((day for day in current['daily'] if day['date'] == today.isoformat()), None)
        if day is None:
            day = {'date': today.isoformat(), 'checks': 0, 'successes': 0, 'newCount': 0}
            current['daily'].append(day)
        status = status_by_id[source_id]
        day['checks'] += 1
        if status['status'] == 'ok':
            day['successes'] += 1
            day['newCount'] += new_count
            # An outage or a gap in collection breaks a continuous successful
            # observation period; it is not evidence that a publisher stopped.
            previous_check = parse_date(current.get('lastCheckedAt'))
            if new_count:
                current['lastNewAt'] = stamp
                current['noNewSince'] = stamp
            elif (not current.get('noNewSince') or current['failureStreak']
                  or not previous_check or now - previous_check > timedelta(hours=3)):
                current['noNewSince'] = stamp
            current['failureStreak'] = 0
            current['lastCheckedAt'] = stamp
        else:
            current['failureStreak'] += 1
            current['noNewSince'] = None
        status['newCount'] = new_count
        state['sources'][source_id] = current

    title_sources = {}
    for source_id, source in state['sources'].items():
        for row in source['seen']:
            title_sources.setdefault((row[1], row[2]), set()).add(source_id)
    public = {'schema': 1, 'startedAt': state['startedAt'], 'updatedAt': stamp,
              'windowDays': QUALITY_WINDOW_DAYS, 'sources': []}
    for source in sources:
        source_id, status = source['id'], status_by_id[source['id']]
        tracked = state['sources'][source_id]
        duplicates = {}
        for row in tracked['seen']:
            if row[3] and row[3] >= first_day and len(title_sources[(row[1], row[2])]) > 1:
                duplicates[row[3]] = duplicates.get(row[3], 0) + 1
        days = [{**day, 'duplicateCount': duplicates.get(day['date'], 0)} for day in tracked['daily']
                if day['date'] >= first_day]
        new_count = sum(day['newCount'] for day in days)
        duplicate_count = sum(day['duplicateCount'] for day in days)
        no_new_since = parse_date(tracked.get('noNewSince'))
        public['sources'].append({'id': source_id, 'startedAt': tracked['startedAt'],
            'newCount': new_count, 'duplicateCount': duplicate_count,
            'duplicateRate': round(duplicate_count / new_count, 4) if new_count else None,
            'checks': sum(day['checks'] for day in days), 'successes': sum(day['successes'] for day in days),
            'observedDays': len(days), 'failureStreak': tracked['failureStreak'],
            'noNewDays': int((now - no_new_since).total_seconds() // 86400) if no_new_since else None,
            'lastNewAt': tracked.get('lastNewAt'), 'daily': days})
    return state, public


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'news/data/news.json')
    parser.add_argument('--previous-url')
    args = parser.parse_args()
    sources = json.loads((ROOT / 'news/sources.json').read_text())
    previous, previous_models, previous_housing, quality_states = [], [], [], []
    if args.output.exists():
        old = json.loads(args.output.read_text())
        previous = old.get('articles', [])
        previous_models = old.get('modelReleases', [])
        previous_housing = old.get('housingArticles', [])
        if old.get('sourceQualityState') is not None:
            quality_states.append(validate_quality_state(old['sourceQualityState']))
    if args.previous_url:
        try:
            old = json.loads(fetch(args.previous_url, 30_000_000))
            previous += old.get('articles', [])
            previous_models += old.get('modelReleases', [])
            previous_housing += old.get('housingArticles', [])
            if old.get('sourceQualityState') is not None:
                quality_states.append(validate_quality_state(old['sourceQualityState']))
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise SystemExit(f'Cannot safely read previous archive; aborting to preserve history: {exc}')
            print('No previous archive (first deployment).', file=sys.stderr)
        except Exception as exc:
            raise SystemExit(f'Cannot safely read previous archive; aborting to preserve history: {exc}')
    now = datetime.now(UTC)
    incoming, statuses = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for articles, status in pool.map(lambda source: collect(source, now), sources):
            incoming.extend(articles)
            statuses.append(status)
    allowed_sources = {s['id']: s for s in sources}
    articles = merge_articles(previous, incoming, now, allowed_sources)
    models = recent_model_releases(previous + previous_models, incoming, now, allowed_sources)
    housing = recent_housing_articles(previous + previous_housing, incoming, now, allowed_sources)
    if not incoming:
        raise SystemExit('All feeds unavailable. Keep the last successful deployment; do not publish an empty site.')
    old_quality = max(quality_states, key=lambda state: state['updatedAt']) if quality_states else None
    quality_state, quality = update_source_quality(old_quality, sources, statuses, incoming,
                                                   previous + previous_models + previous_housing, now)
    for status in statuses:
        print('SOURCE_METRIC ' + json.dumps({k: status[k] for k in
              ('id', 'checkedAt', 'status', 'fetchedCount', 'newCount', 'durationMs')}))
    result = {'version': 1, 'updatedAt': iso(now), 'retentionDays': 30, 'sources': statuses,
              'articles': articles, 'modelReleases': models, 'housingArticles': housing,
              'sourceQualityState': quality_state, 'sourceQuality': quality}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Collected {len(incoming)} items; retained {len(articles)} unique items; {sum(s["status"] == "ok" for s in statuses)}/{len(sources)} sources available.')


if __name__ == '__main__':
    main()
