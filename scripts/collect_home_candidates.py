#!/usr/bin/env python3
"""Small, bounded public-listing watch. No login, captcha bypass or agent contact.

Prices are observations of source pages, never verified inventory or transactions.
Successful sources replace their own slice; failures retain their last good slice.
"""
import argparse
import concurrent.futures
import datetime as dt
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

MAX_PAGE = 2_500_000
ROOT = Path(__file__).resolve().parents[1]
REVISION = 'pages-candidates-v1'
BEIJING = dt.timezone(dt.timedelta(hours=8))
MAX_SNAPSHOT = 3_000_000


def candidate_fits(item):
    """Only publish known areas of at least 100 square metres and 3+ rooms."""
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


def public_snapshot(value):
    """Allow only public listing fields; never carry notebook data into Pages."""
    if (not isinstance(value, dict) or value.get('schema') != 1
            or not isinstance(value.get('items'), list) or len(value['items']) > 500
            or not isinstance(value.get('sources'), list) or len(value['sources']) > 50):
        raise ValueError('Invalid candidate snapshot')
    checked = dt.datetime.fromisoformat(value['updatedAt'].replace('Z', '+00:00'))
    if checked.tzinfo is None:
        raise ValueError('Candidate timestamp must include timezone')
    result = {k: value[k] for k in ('schema', 'updatedAt', 'scheduleRevision', 'coverage', 'notice') if k in value}
    fields = ('id', 'kind', 'name', 'district', 'region', 'address', 'url', 'unitPrice', 'total',
              'priceBasis', 'areas', 'layout', 'status', 'source', 'sourcePage', 'mixedUse',
              'title', 'orientation', 'opening', 'delivery', 'checkedAt', 'firstSeen', 'missing', 'stale')
    result['items'] = []
    for item in value['items']:
        if not candidate_fits(item):
            continue
        if (not isinstance(item.get('id'), str) or not isinstance(item.get('name'), str)
                or not isinstance(item.get('source'), str) or item.get('kind') not in ('new', 'resale')
                or not re.fullmatch(r'https://(?:hz\.newhouse\.fang\.com/loupan/\d+\.htm|m\.fang\.com/esf/hz/\d+_\d+\.html)', item.get('url', ''))):
            raise ValueError('Invalid public listing')
        row = {k: item[k] for k in fields if k in item}
        row['history'] = [
            {'at': event['at'], 'changes': {k: {p: change.get(p) for p in ('from', 'to')}
             for k, change in event.get('changes', {}).items()
             if k in ('unitPrice', 'total', 'status', 'opening', 'delivery')}}
            for event in item.get('history', [])[-30:]]
        if isinstance(item.get('crossCheck'), dict):
            row['crossCheck'] = {k: item['crossCheck'][k] for k in ('status', 'url', 'checkedAt', 'stale') if k in item['crossCheck']}
        result['items'].append(row)
    result['sources'] = []
    for source in value['sources']:
        row = {k: source[k] for k in ('id', 'name', 'url', 'attemptedAt', 'ok', 'checkedAt', 'count', 'partial', 'error') if k in source}
        row['pages'] = [{k: page[k] for k in ('url', 'ok', 'count', 'errorType', 'checkedAt') if k in page}
                        for page in source.get('pages', [])[:3]]
        result['sources'].append(row)
    return result


def refresh_due(previous, now):
    if previous.get('scheduleRevision') != REVISION:
        return True
    try:
        last = dt.datetime.fromisoformat(previous['updatedAt'].replace('Z', '+00:00'))
        if last.tzinfo is None or last > now:
            return True
    except (KeyError, TypeError, ValueError):
        return True
    local = now.astimezone(BEIJING)
    slot = local.replace(hour=16, minute=0, second=0, microsecond=0)
    if local.hour < 9:
        slot -= dt.timedelta(days=1)
    elif local.hour < 16:
        slot = slot.replace(hour=9)
    if last < slot:
        return True
    # Retry a completely failed check at most hourly, without erasing its data.
    return not any(s.get('ok') or s.get('partial') for s in previous.get('sources', [])) and now - last >= dt.timedelta(hours=1)


def read_previous(path, previous_url=None, seed=None):
    candidates = []
    for local in (path, seed):
        try:
            if local and Path(local).is_file():
                candidates.append(public_snapshot(json.loads(Path(local).read_text())))
        except (OSError, KeyError, TypeError, ValueError):
            pass
    if previous_url:
        # Public snapshots only. No access to the retired private notebook API.
        parsed = urllib.parse.urlsplit(previous_url)
        if parsed.scheme != 'https' or parsed.hostname != 'news.zacai.fun' or parsed.path != '/data/home-candidates.json' or parsed.username or parsed.query or parsed.fragment:
            raise ValueError('Expected the public Pages candidate snapshot')
        try:
            with urllib.request.urlopen(urllib.request.Request(previous_url, headers={'Cache-Control': 'no-cache'}), timeout=20) as response:
                raw = response.read(MAX_SNAPSHOT + 1)
            if len(raw) > MAX_SNAPSHOT:
                raise ValueError('Oversized candidate snapshot')
            candidates.append(public_snapshot(json.loads(raw)))
        except (OSError, KeyError, TypeError, ValueError):
            print('Previous public snapshot unavailable; retaining the local seed.')
    if not candidates:
        return {}
    return max(candidates, key=lambda value: dt.datetime.fromisoformat(value['updatedAt'].replace('Z', '+00:00')))


class Node:
    def __init__(self, tag='', attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []

    def all(self, tag=None, cls=None):
        for child in self.children:
            if isinstance(child, Node):
                if (tag is None or child.tag == tag) and (cls is None or cls in child.attrs.get('class', '').split()):
                    yield child
                yield from child.all(tag, cls)

    def first(self, tag=None, cls=None):
        return next(self.all(tag, cls), Node())

    def text(self):
        return ' '.join(''.join(c.text() if isinstance(c, Node) else c for c in self.children).split())


class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        if tag == 'li' and self.stack[-1].tag == 'li':
            self.stack.pop()
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in ('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'):
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def positive(value):
    try:
        number = float(value)
        return number if 0 < number < 100_000_000 else None
    except (ValueError, TypeError):
        return None


def area_range(text):
    match = re.search(r'(\d+(?:\.\d+)?)(?:\s*[-–—~]\s*(\d+(?:\.\d+)?))?\s*(?:㎡|平米|平方米)', text)
    if not match:
        return []
    low, high = float(match[1]), float(match[2] or match[1])
    return [low, high] if 20 <= low <= high <= 2000 else []


def jsonld(tree):
    for node in tree.all('script'):
        if node.attrs.get('type') == 'application/ld+json':
            try:
                value = json.loads(node.text())
                if isinstance(value, dict):
                    yield value
            except (ValueError, TypeError):
                continue


def parse_new(source, config):
    tree = Tree(source).root
    if '杭州' not in tree.first('title').text() or config['district'] not in tree.first('title').text():
        raise ValueError('Source city or page type changed')
    listing = next((x for x in jsonld(tree) if x.get('@type') == 'ItemList'), None)
    if not listing:
        raise ValueError('Listing schema missing')
    cards = {n.attrs['id'][3:]: n for n in tree.all('li') if n.attrs.get('id', '').startswith('lp_')}
    result = []
    for entry in listing.get('itemListElement', []):
        item = entry.get('item', {})
        match = re.fullmatch(r'https://hz\.newhouse\.fang\.com/loupan/(\d+)\.htm', item.get('url', ''))
        if not match or match[1] not in cards:
            continue
        card = cards[match[1]]
        tags = card.first(cls='fangyuan')
        property_types = ' '.join(a.text() for a in tags.all('a'))
        # Do not mix office, serviced-apartment or villa offers into family flats.
        if '普通住宅' not in property_types or any(x in property_types for x in ('别墅', '写字楼')):
            continue
        status = tags.first('span').text() or '待核实'
        offer = item.get('offers') or {}
        price, unit = positive(offer.get('price')), offer.get('unitText')
        unit_price = price if unit == 'per平方米' else None
        total = round(price / 10000, 2) if price and unit == 'per套' else None
        match_total = re.search(r'(\d+(?:\.\d+)?)\s*万元/套', card.first(cls='zj_price').text())
        if total is None and match_total:
            total = positive(match_total[1])
        address = card.first(cls='address').first('a').attrs.get('title', '')
        description = item.get('description', '')
        areas = area_range(card.first(cls='house_type').text()) or area_range(description)
        district = config['district']
        region = description.split()[1] if len(description.split()) > 1 else ''
        if '居' in region or '㎡' in region or region == district:
            region = ''
        result.append(dict(id='new-' + match[1], kind='new', name=item['name'].strip(), district=district,
                           region=region, address=address, url=item['url'], unitPrice=unit_price, total=total,
                           priceBasis='project' if total else 'average', areas=areas,
                           layout=card.first(cls='house_type').text(), status=status, source=config['id'],
                           mixedUse=any(x in property_types for x in ('公寓', '商业', '商住'))))
    if not cards:
        raise ValueError('Listing cards missing')
    return result


def parse_resale(source, config):
    tree = Tree(source).root
    if '杭州' not in tree.first('title').text():
        raise ValueError('Source city changed')
    section = next((x for x in tree.all('section') if x.attrs.get('id') == 'wapquanwangso_A03_03'), None)
    if not section:
        raise ValueError('Resale section missing')
    result = []
    for anchor in section.all('a'):
        path = anchor.attrs.get('href', '')
        match = re.fullmatch(r'/esf/hz/(\d+_\d+)\.html', path)
        if not match:
            continue
        title = anchor.first('h3').text()
        # A search page can recommend unrelated communities. Keep explicit name matches only.
        if not any(alias in title for alias in config['aliases']):
            continue
        price = positive(anchor.first(cls='price').first('em').text())
        area = area_range(anchor.first(cls='txt').first('p').text())
        if not price or not area:
            continue
        layout = re.search(r'\d室\d厅(?:\d卫)?', anchor.text())
        result.append(dict(id='resale-' + match[1], kind='resale', name=config['name'], district=config['district'],
                           region=config['region'], address='', title=title, url='https://m.fang.com' + path,
                           unitPrice=None, total=price, priceBasis='listing', areas=area,
                           layout=layout[0] if layout else '', status='平台挂牌', source=config['id']))
    return result


def parse_resale_list(source, config):
    """Read the residential list, not nearby recommendations or search snippets."""
    tree = Tree(source).root
    fields = {n.attrs.get('data-id'): n.attrs.get('value', '') for n in tree.all('input')}
    expected = {'district': config['districtId'], 'comarea': config['regionId'],
                'price': '300^350', 'purpose': '住宅', 'tags': '3', 'pageType': 'esfindex2022'}
    if '杭州' not in tree.first('title').text() or any(fields.get(k) != v for k, v in expected.items()):
        raise ValueError('Residential list filters or city changed')
    section = next((n for n in tree.all('ul') if n.attrs.get('id') == 'content'), None)
    if section is None:
        raise ValueError('Residential list missing')
    cards = list(section.all('li', cls='listhouse'))
    if not cards and fields.get('total') != '0':
        raise ValueError('Residential cards missing')
    result = []
    for card in cards[:30]:
        anchor = card.first('a', cls='listtype')
        url = urllib.parse.urljoin('https://m.fang.com', anchor.attrs.get('href', ''))
        match = re.fullmatch(r'https://m\.fang\.com/esf/hz/(\d+_\d+)\.html', url)
        detail = anchor.first(cls='txt')
        values = [n.text() for n in detail.first('p').all('span')]
        price = positive(detail.first(cls='price').first('em').text())
        areas = area_range(values[0]) if values else []
        if not match or len(values) != 4 or not areas or not price or not 300 <= price <= 350:
            continue
        layout = re.fullmatch(r'\d室\d厅(?:\d卫)?', values[1])
        if not layout or not values[3]:
            continue
        result.append(dict(id='resale-' + match[1], kind='resale', name=values[3], district=config['district'],
                           region=config['region'], address='', title=detail.first('h3').text(), url=url,
                           unitPrice=None, total=price, priceBasis='listing', areas=areas, layout=layout[0],
                           orientation=values[2], status='平台挂牌', source=config['id']))
    return result


def parse_detail(source, item):
    tree = Tree(source).root
    for data in jsonld(tree):
        if data.get('@type') == 'Product':
            props = {x.get('name'): x.get('value') for x in data.get('additionalProperty', []) if isinstance(x, dict)}
            # Opening/delivery dates are platform statements, not independently verified.
            for name, key in [('开盘时间', 'opening'), ('交房时间', 'delivery')]:
                if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(props.get(name, ''))):
                    item[key] = props[name]
    return item


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; PersonalHomeWatch/1.0)', 'Accept': 'text/html'})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=18) as response:
                raw = response.read(MAX_PAGE + 1)
                if len(raw) > MAX_PAGE:
                    raise ValueError('Source exceeds size limit')
                # Chinese mobile sources may omit their encoding in the HTTP header.
                meta = re.search(br'charset=["\s]*([\w-]+)', raw[:3000], re.I)
                encoding = response.headers.get_content_charset() or (meta[1].decode('ascii') if meta else 'utf-8')
                return raw.decode(encoding, errors='replace')
        except urllib.error.HTTPError as error:
            # Never retry an access denial, rate limit or challenge.
            if attempt or error.code not in (500, 502, 503, 504):
                raise
        except (TimeoutError, urllib.error.URLError):
            if attempt:
                raise


def sources():
    result = [dict(id='new-' + slug, name=f'房天下 · {district}新房', district=district, kind='new',
                   url=f'https://hz.newhouse.fang.com/house/s/{slug}/', maxPages=3)
              for slug, district in [('xihu', '西湖'), ('yuhang', '余杭'), ('shangcheng', '上城')]]
    for key, name, aliases, district, region in [
        ('xiyatu', '万科融信西雅图', ['西雅图'], '西湖', '三墩'),
        ('xixiyuecheng', '西溪悦城', ['西溪悦城'], '余杭', '西溪'),
        ('zizaicheng', '金地自在城', ['金地自在城'], '西湖', '三墩'),
    ]:
        result.append(dict(id='resale-' + key, name=name, aliases=aliases, district=district, region=region,
                           kind='resale', url='https://m.fang.com/quanwangso/hz/search.html?q=' + urllib.parse.quote(aliases[0])))
    # IDs and the URL template come from the public mobile list's own filter controls.
    for key, district, district_id, region, region_id in [
        ('sandun', '西湖', '151', '三墩', '2349'),
        ('jiangcun', '西湖', '151', '蒋村', '2350'),
        ('liuxia', '西湖', '151', '留下', '5138'),
        ('xixi', '西湖', '151', '西溪', '2347'),
        ('future', '余杭', '155', '未来科技城', '16132'),
        ('xianlin', '余杭', '155', '闲林', '2918'),
        ('cangqian', '余杭', '155', '仓前', '21948'),
        ('liangzhu', '余杭', '155', '良渚', '1270'),
        ('gouzhuang', '余杭', '155', '勾庄', '16134'),
        ('shangcheng', '上城', '149', '', ''),
    ]:
        path = district_id + ('_b' + region_id if region_id else '')
        result.append(dict(id='resale-area-' + key, name=f'房天下 · {region or district} 300–350 万住宅',
                           district=district, region=region, districtId=district_id, regionId=region_id,
                           kind='resale', parser='list', url=f'https://m.fang.com/esf/hz_{path}/m300,350c3/'))
    return result


def read_source(config, loader):
    """Bound pagination and retain page-level success for partial-failure recovery."""
    url = config['url']
    pages, found = [], {}
    parser = parse_new if config['kind'] == 'new' else (parse_resale_list if config.get('parser') == 'list' else parse_resale)
    for page in range(1, config.get('maxPages', 1) + 1):
        try:
            source = loader(url)
            rows = parser(source, config)
            for item in rows:
                found[item['id']] = dict(item, sourcePage=url)
            pages.append({'url': url, 'ok': True, 'count': len(rows)})
        except Exception as error:
            pages.append({'url': url, 'ok': False, 'errorType': type(error).__name__})
            break
        if config['kind'] != 'new':
            break
        # Follow only an actual next-page link under this fixed district URL.
        expected = config['url'] + f'b9{page + 1}/'
        links = [urllib.parse.urljoin(url, a.attrs.get('href', '')) for a in Tree(source).root.all('a')
                 if a.text() == '下一页']
        if expected not in links:
            break
        url = expected
    return config, list(found.values()), pages


def observe(item, old, checked):
    item = dict(item)
    item['checkedAt'] = checked
    item['firstSeen'] = old.get('firstSeen', checked)
    history = list(old.get('history', []))
    fields = ('unitPrice', 'total', 'status', 'opening', 'delivery')
    changes = {key: {'from': old.get(key), 'to': item.get(key)} for key in fields
               if old and old.get(key) != item.get(key) and (key not in ('opening', 'delivery') or key in item)}
    if changes:
        history.append({'at': checked, 'changes': changes})
    item['history'] = history[-30:]
    return item


def collect(previous=None, loader=fetch):
    previous = previous or {}
    old_items = {x['id']: x for x in previous.get('items', [])}
    old_sources = {x['id']: x for x in previous.get('sources', [])}
    checked = stamp()
    fresh, checks, outcomes = {}, [], {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for config, found, pages in pool.map(lambda c: read_source(c, loader), sources()):
            success = all(p['ok'] for p in pages)
            old_check = old_sources.get(config['id'], {})
            old_pages = {p['url']: p for p in old_check.get('pages', [])}
            for page in pages:
                page['checkedAt'] = checked if page['ok'] else old_pages.get(page['url'], {}).get('checkedAt')
            check = {'id': config['id'], 'name': config['name'], 'url': config['url'], 'attemptedAt': checked,
                     'ok': success, 'checkedAt': checked if success else old_check.get('checkedAt'),
                     'count': len(found), 'pages': pages}
            if not success:
                check['partial'] = any(p['ok'] for p in pages)
                check['error'] = '部分页面未更新，保留其上次结果' if check['partial'] else '本次读取失败，保留上次结果'
            # Deduplicate across pages and overlapping sources before marking absences.
            for item in found:
                fresh[item['id']] = observe(item, old_items.get(item['id'], {}), checked)
            outcomes[config['id']] = (config, pages, success)
            checks.append(check)

    items = list(fresh.values())
    retained = []
    for item in old_items.values():
        if item['id'] in fresh:
            continue
        outcome = outcomes.get(item['source'])
        read_ok = False
        if outcome:
            _, _, read_ok = outcome
        # An unseen row may have moved onto a failed page. Never infer absence
        # from an incomplete source scan or refresh the old observation date.
        retained.append(dict(item, **({'missing': True} if read_ok else {'stale': True})))
    items.extend(sorted(retained, key=lambda x: x.get('checkedAt', ''), reverse=True))

    # A second platform marks 云耀住宅售罄; keep conflicting availability visible.
    yunyao = next((x for x in items if x['id'] == 'new-2010201182'), None)
    if yunyao:
        url = 'https://hz.cdgoufangtong.com/building/13053?category=hot'
        check = {'id': 'yunyao-check', 'name': '购房通 · 云耀状态核对', 'url': url, 'attemptedAt': checked, 'ok': False}
        try:
            tree = Tree(loader(url)).root
            tags = tree.first(cls='tags').text()
            if '云耀之城' not in tree.first('h1').text() or not tags:
                raise ValueError('Project page changed')
            check.update(ok=True, checkedAt=checked)
            yunyao['crossCheck'] = {'status': '住宅售罄' if '住宅售罄' in tags else tags, 'url': url, 'checkedAt': checked}
        except Exception:
            old = old_items.get(yunyao['id'], {}).get('crossCheck')
            if old:
                yunyao['crossCheck'] = dict(old, stale=True)
            check['error'] = '本次状态核对失败'
        checks.append(check)
    # Keep a bounded history of items that fell off the sampled pages.
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)).isoformat()
    items = [x for x in items if not x.get('missing') or x['checkedAt'] >= cutoff]
    return {'schema': 1, 'updatedAt': checked, 'sources': checks, 'items': items[:500],
            'coverage': '西湖、余杭、上城新房各最多 3 页；二手房覆盖三墩、蒋村、留下、西溪、未来科技城、闲林、仓前、良渚、勾庄及上城，读取各自 300–350 万住宅列表前 30 条，并保留原有 3 个小区搜索。按房源编号去重，不同编号仍可能为同一套房。不是全量市场。',
            'notice': '页面报价不等于成交价或可售承诺；税费、车位和装修另核实。每日上午 9 点、下午 4 点检查。通勤尚未核实。'}


def write_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.candidates-')
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, separators=(',', ':'))
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'news/data/home-candidates.json')
    parser.add_argument('--previous-url')
    parser.add_argument('--seed', type=Path, default=ROOT / 'news/assets/home-candidates.json')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    path = Path(args.output)
    previous = read_previous(path, args.previous_url, args.seed)
    if previous and not args.force and not refresh_due(previous, dt.datetime.now(dt.timezone.utc)):
        write_atomic(path, previous)
        print(json.dumps({'items': len(previous['items']), 'collection': 'not-due', 'checkedAt': previous['updatedAt']}))
        return
    result = public_snapshot(collect(previous))
    result['scheduleRevision'] = REVISION
    write_atomic(path, result)
    print(json.dumps({'items': len(result['items']), 'successfulSources': sum(s['ok'] for s in result['sources'])}))
    # A source outage must not prevent other news sections from publishing.
    if not any(s['ok'] or s.get('partial') for s in result['sources']):
        print('::warning::All listing sources failed; previous observations are retained with their original dates.')


if __name__ == '__main__':
    main()
