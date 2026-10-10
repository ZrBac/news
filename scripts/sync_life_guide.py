#!/usr/bin/env python3
"""Mirror the CC BY 4.0 book without changing its entry text."""
import argparse
import io
import json
import re
import subprocess
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
REPO = 'https://github.com/eternity4719/HowToLiveBetter'
OUTPUT = ROOT / 'news/guide/book.json'


def parse_book(files, revision, updated_at):
    readme = files['README.md']
    chapters, entries = [], []
    questions = {path: question.strip() for question, path in re.findall(
        r'^\| ([^|]+) \| \[[^\]]+\]\((book/[^)]+\.md)\) \|', readme, re.M)}
    # Discover chapters from the upstream directory table, not a frozen file list.
    paths = list(questions)
    if not paths:
        raise ValueError('Missing upstream chapter directory')
    for path in paths:
        text = files[path]
        heading = re.search(r'^# (\d+)\. (.+)$', text, re.M)
        if not heading:
            raise ValueError('Invalid chapter: ' + path)
        number, title = int(heading[1]), heading[2].strip()
        matches = list(re.finditer(r'^### (\d+)\. (.+)$', text, re.M))
        intro = text[heading.end():matches[0].start()].strip() if matches else ''
        url = REPO + '/blob/' + revision + '/' + quote(path, safe='/')
        chapter = {'id': number, 'title': title, 'question': questions[path],
                   'intro': intro, 'url': url, 'count': len(matches)}
        chapters.append(chapter)
        for i, match in enumerate(matches):
            body = text[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip()
            tags = dict(re.findall(r'(钱|时间|毅力|收益|口径)=([^\s>]+)', body))
            fields = {}
            for field in ('成本', '说人话', '收益', '证据等级', '来源', '备注'):
                value = re.search(r'^- ' + field + r'[:：]\s*(.*)$', body, re.M)
                fields[field] = value[1].strip() if value else ''
            entries.append({'id': f'{number}-{int(match[1])}', 'chapter': number,
                            'number': int(match[1]), 'title': match[2].strip(),
                            'body': body, 'tags': tags, 'grade': fields['证据等级'],
                            'summary': fields['说人话'], 'url': url,
                            'pending': bool(re.search('待核实|TODO', body)),
                            'disputed': bool(re.search(r'^- 备注[:：].*争议', body, re.M))})
    if len(chapters) < 10 or len(entries) < 100 or len({e['id'] for e in entries}) != len(entries):
        raise ValueError('Incomplete or duplicate guide entries')
    return {'schema': 1, 'title': '高性价比人生指南', 'author': 'eternity4719',
            'source': REPO, 'license': 'https://creativecommons.org/licenses/by/4.0/',
            'revision': revision, 'updatedAt': updated_at,
            'adaptation': '本站调整了排版与检索方式，条目正文保留原文。',
            'chapters': chapters, 'entries': entries}


def download(url, maximum=12_000_000):
    request = urllib.request.Request(url, headers={'User-Agent': 'ZrBac-LifeGuide/1'})
    with urllib.request.urlopen(request, timeout=25) as response:
        body = response.read(maximum + 1)
    if len(body) > maximum:
        raise ValueError('Guide download too large')
    return body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, help='Use a local upstream checkout')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        if args.source:
            revision = subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip()
            updated_at = subprocess.check_output(['git', '-C', str(args.source), 'show', '-s', '--format=%cI', 'HEAD'], text=True).strip()
            files = {'README.md': (args.source / 'README.md').read_text()}
            files.update({str(p.relative_to(args.source)): p.read_text() for p in (args.source / 'book').glob('*.md')})
        else:
            info = json.loads(download('https://api.github.com/repos/eternity4719/HowToLiveBetter/commits/main', 300_000))
            revision = info['sha']
            updated_at = info['commit']['committer']['date']
            if not re.fullmatch('[a-f0-9]{40}', revision):
                raise ValueError('Invalid upstream revision')
            if args.output.exists() and json.loads(args.output.read_text()).get('revision') == revision:
                print('Life guide unchanged: ' + revision[:12])
                return
            archive = zipfile.ZipFile(io.BytesIO(download('https://codeload.github.com/eternity4719/HowToLiveBetter/zip/' + revision)))
            files = {}
            for item in archive.infolist():
                path = item.filename.partition('/')[2]
                if path == 'README.md' or re.fullmatch(r'book/[^/]+\.md', path):
                    if item.file_size > 2_000_000:
                        raise ValueError('Chapter too large')
                    files[path] = archive.read(item).decode('utf-8')
        # Use the commit date so identical upstream revisions produce identical
        # offline assets across hourly builds, even in a fresh Actions checkout.
        updated_at = datetime.fromisoformat(updated_at.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        data = parse_book(files, revision, updated_at)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
        temporary.replace(args.output)
        print(f'Life guide: {len(data["chapters"])} chapters, {len(data["entries"])} entries; {revision[:12]}')
    except Exception as exc:
        if not args.output.exists():
            raise
        # An upstream outage must never erase a working offline book.
        print(f'Life guide sync unavailable ({type(exc).__name__}); retaining the bundled edition.')


if __name__ == '__main__':
    main()
