"""Public site origin comes from deployment settings, never from source files."""
import os
import re


def site_origin():
    value = os.environ.get('NEWS_SITE_URL', 'https://news.example.com').strip()
    match = re.fullmatch(r'https://([a-z0-9.-]+)/?', value, re.I)
    if not match or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label, re.I)
                        for label in match[1].split('.')):
        raise ValueError('NEWS_SITE_URL must be an HTTPS origin without credentials, port, path, query or fragment')
    return 'https://' + match[1].lower()


def site_url(path='/'):
    return site_origin() + path
