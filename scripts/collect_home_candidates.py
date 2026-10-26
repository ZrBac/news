#!/usr/bin/env python3
"""Small, bounded public-listing watch. No login, captcha bypass or agent contact.

Prices are observations of source pages, never verified inventory or transactions.
Successful sources replace their own slice; failures retain their last good slice.
"""
import argparse
import concurrent.futures
import datetime as dt
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request

MAX_PAGE = 2_500_000
ROOT = Path(__file__).resolve().parents[1]


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
    if '杭州' not in tree.first('title').text():
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
    with urllib.request.urlopen(request, timeout=18) as response:
        raw = response.read(MAX_PAGE + 1)
        if len(raw) > MAX_PAGE:
            raise ValueError('Source exceeds size limit')
        # Chinese mobile sources may omit their encoding in the HTTP header.
        meta = re.search(br'charset=["\s]*([\w-]+)', raw[:3000], re.I)
        encoding = response.headers.get_content_charset() or (meta[1].decode('ascii') if meta else 'utf-8')
        return raw.decode(encoding, errors='replace')


def sources():
    result = [dict(id='new-' + slug, name=f'房天下 · {district}新房', district=district, kind='new',
                   url=f'https://hz.newhouse.fang.com/house/s/{slug}/')
              for slug, district in [('xihu', '西湖'), ('yuhang', '余杭'), ('shangcheng', '上城')]]
    for key, name, aliases, district, region in [
        ('xiyatu', '万科融信西雅图', ['西雅图'], '西湖', '三墩'),
        ('xixiyuecheng', '西溪悦城', ['西溪悦城'], '余杭', '西溪'),
        ('zizaicheng', '金地自在城', ['金地自在城'], '西湖', '三墩'),
    ]:
        result.append(dict(id='resale-' + key, name=name, aliases=aliases, district=district, region=region,
                           kind='resale', url='https://m.fang.com/quanwangso/hz/search.html?q=' + urllib.parse.quote(aliases[0])))
    return result


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
    items, checks = [], []

    def load(config):
        try:
            source = loader(config['url'])
            found = (parse_new if config['kind'] == 'new' else parse_resale)(source, config)
            return config, found, None
        except Exception as error:
            return config, None, type(error).__name__

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for config, found, error in pool.map(load, sources()):
            check = {'id': config['id'], 'name': config['name'], 'url': config['url'], 'attemptedAt': checked,
                     'ok': not error, 'checkedAt': old_sources.get(config['id'], {}).get('checkedAt')}
            if error:
                check['error'] = '本次读取失败，保留上次结果'
                items.extend(dict(x, stale=True) for x in old_items.values() if x['source'] == config['id'])
            else:
                check['checkedAt'], check['count'] = checked, len(found)
                found_ids = {x['id'] for x in found}
                items.extend(observe(x, old_items.get(x['id'], {}), checked) for x in found)
                # Absence on a limited search page is not evidence of a sale or delisting.
                items.extend(dict(x, missing=True) for x in old_items.values()
                             if x['source'] == config['id'] and x['id'] not in found_ids)
            checks.append(check)

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
    # Keep a bounded history of items that fell off a source's first page.
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)).isoformat()
    items = [x for x in items if not x.get('missing') or x['checkedAt'] >= cutoff]
    return {'schema': 1, 'updatedAt': checked, 'sources': checks, 'items': items[:400],
            'coverage': '西湖、余杭、上城新房列表首页；西雅图、西溪悦城、金地自在城二手房搜索结果。不是全量房源。',
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
    parser.add_argument('--output', default='/var/lib/zrbac-homes/candidates.json')
    args = parser.parse_args()
    path = Path(args.output)
    previous = json.loads(path.read_text()) if path.exists() else {}
    result = collect(previous)
    write_atomic(path, result)
    print(json.dumps({'items': len(result['items']), 'successfulSources': sum(s['ok'] for s in result['sources'])}))
    if not any(s['ok'] for s in result['sources']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
