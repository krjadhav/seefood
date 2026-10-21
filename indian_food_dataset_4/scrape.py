"""Resumable, rate-limited recipe-scrapers collection; see README.md."""
import argparse
import concurrent.futures as cf
import csv
import hashlib
import json
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup
from lxml import etree
from recipe_scrapers import scrape_html

ROOT = Path(__file__).resolve().parent
SITES = ['www.indianhealthyrecipes.com', 'www.vegrecipesofindia.com',
         'www.archanaskitchen.com', 'ministryofcurry.com', 'www.bongeats.com']
UA = 'SeefoodRecipeCollector/1.0 (+https://github.com/krjadhav/seefood)'
FIELDS = ['source', 'url', 'title', 'ingredients', 'instructions', 'total_time',
          'prep_time', 'cook_time', 'yields', 'category', 'cuisine', 'nutrients',
          'image', 'author', 'ratings', 'scraped_at']

def now():
    return datetime.now(timezone.utc).isoformat()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)

def normalize(url):
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path or '/', '', ''))

class Site:
    def __init__(self, host, delay):
        self.host, self.base = host, 'https://' + host
        self.delay = delay
        self.lock = threading.Lock()
        self.last = 0
        self.robot = None
        self.errors = []
        self.cache = ROOT / '.cache' / host
        self.cache.mkdir(parents=True, exist_ok=True)

    def get(self, url):
        if urlsplit(url).netloc != self.host:
            raise ValueError('Off-site URL: ' + url)
        if self.robot and not self.robot.can_fetch(UA, url):
            raise PermissionError('robots.txt disallows ' + url)
        for attempt in range(3):
            with self.lock:
                time.sleep(max(0, self.last + self.delay - time.monotonic()))
                self.last = time.monotonic()
            r = requests.get(url, headers={'User-Agent': UA}, timeout=(15, 60))
            if r.status_code == 429 or r.status_code >= 500:
                if attempt < 2:
                    retry = r.headers.get('Retry-After', '')
                    time.sleep(min(120, int(retry)) if retry.isdigit() else 5 * (attempt + 1))
                    continue
            r.raise_for_status()
            return r

    def discover(self):
        r = self.get(self.base + '/robots.txt')
        robot = RobotFileParser()
        robot.parse(r.text.splitlines())
        self.robot = robot
        self.delay = max(self.delay, robot.crawl_delay(UA) or 0)
        write_json(self.cache / 'robots.json', {'url': r.url, 'retrieved_at': now(), 'text': r.text})
        if 'bongeats' in self.host:
            # The public recipe index is complete HTML, with no working XML sitemap.
            todo, seen, found = [self.base + '/recipes'], set(), set()
            while todo:
                url = todo.pop()
                if url in seen:
                    continue
                seen.add(url)
                soup = BeautifulSoup(self.get(url).text, 'lxml')
                for a in soup.select('a[href]'):
                    raw = urljoin(url, a['href'])
                    link = normalize(raw)
                    if urlsplit(link).netloc != self.host:
                        continue
                    path = urlsplit(link).path
                    if path.startswith('/recipe/') and path.count('/') == 2 and path != '/recipe/recipes':
                        found.add(link)
                    if path == '/recipes' and '?' in raw and raw not in seen:
                        todo.append(raw)
            return sorted(found)
        todo = robot.site_maps() or [self.base + '/sitemap.xml']
        seen, found = set(), set()
        while todo:
            url = todo.pop()
            if url in seen:
                continue
            seen.add(url)
            try:
                root = etree.fromstring(self.get(url).content, etree.XMLParser(resolve_entities=False, no_network=True))
                if etree.QName(root).localname == 'sitemapindex':
                    todo.extend(root.xpath('//*[local-name()="sitemap"]/*[local-name()="loc"]/text()'))
                else:
                    found.update(root.xpath('//*[local-name()="url"]/*[local-name()="loc"]/text()'))
            except Exception as e:
                self.errors.append({'url': url, 'error': str(e)})
        urls = {normalize(u) for u in found if urlsplit(u).netloc == self.host}
        if 'archanaskitchen' in self.host:
            urls = {u for u in urls if '/recipe/' in u}
        else:
            urls = {u for u in urls if not any(p in urlsplit(u).path for p in ['/category/', '/tag/', '/product/', '/web-stories/', '/ingredient/', '/special-diet/', '/occasion/', '/method/'])}
        return sorted(urls)

    def scrape(self, url, retry_errors=False):
        path = self.cache / (hashlib.sha256(url.encode()).hexdigest() + '.json')
        if path.exists():
            old = json.loads(path.read_text())
            if old['status'] != 'error' or not retry_errors:
                return old
        result = {'url': url, 'source': self.host, 'checked_at': now()}
        try:
            response = self.get(url)
            scraper = scrape_html(response.text, response.url, supported_only=False)
            data = {key: None for key in FIELDS}
            for key in FIELDS:
                if key in ['source', 'url', 'scraped_at']:
                    continue
                try:
                    data[key] = getattr(scraper, key)()
                except Exception:
                    pass
            data.update(source=self.host, url=normalize(response.url), scraped_at=now())
            if data['title'] and data['ingredients'] and data['instructions']:
                result.update(status='ok', recipe=data)
            else:
                result.update(status='no_recipe', reason='Missing title, ingredients, or instructions')
        except Exception as e:
            status = 'no_recipe' if type(e).__name__ == 'NoSchemaFoundInWildMode' else 'error'
            result.update(status=status, error=type(e).__name__ + ': ' + str(e))
        write_json(path, result)
        return result


def collect(host, args):
    site = Site(host, args.delay)
    manifest = ROOT / 'data' / 'discovery' / (host + '.json')
    if manifest.exists() and not args.rediscover:
        discovery = json.loads(manifest.read_text())
        # Reload robots on every run, including resumed runs.
        try:
            robot = RobotFileParser()
            robot.parse(site.get(site.base + '/robots.txt').text.splitlines())
            site.robot = robot
            site.delay = max(site.delay, robot.crawl_delay(UA) or 0)
        except Exception as e:
            return {'source': host, 'discovery_error': str(e), 'results': []}
    else:
        try:
            urls = site.discover()
            discovery = {'source': host, 'discovered_at': now(), 'urls': urls, 'errors': site.errors}
        except Exception as e:
            discovery = {'source': host, 'discovered_at': now(), 'urls': [], 'errors': [{'error': str(e)}]}
        write_json(manifest, discovery)
    urls = discovery['urls'][:args.limit] if args.limit else discovery['urls']
    print(host, 'discovered', len(discovery['urls']), flush=True)
    results = []
    with cf.ThreadPoolExecutor(args.workers) as pool:
        for result in pool.map(lambda u: site.scrape(u, args.retry_errors), urls):
            results.append(result)
            if len(results) % 100 == 0:
                print(host, len(results), '/', len(urls), dict(Counter(r['status'] for r in results)), flush=True)
    return {'source': host, 'discovery_errors': discovery['errors'], 'discovered': len(discovery['urls']), 'results': results}


def export(reports):
    recipes, audit, summary = {}, [], []
    for report in reports:
        results = report.pop('results')
        counts = Counter(r['status'] for r in results)
        for r in results:
            if r['status'] == 'ok':
                recipes[r['recipe']['url']] = r['recipe']
            audit.append({k: v for k, v in r.items() if k != 'recipe'})
        summary.append({**report, 'counts': dict(counts), 'processed': len(results)})
    rows = sorted(recipes.values(), key=lambda r: (r['source'], r['url']))
    write_json(ROOT / 'data/recipes.json', rows)
    with (ROOT / 'data/recipes.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()})
    write_json(ROOT / 'data/crawl_report.json', {'generated_at': now(), 'recipe_count': len(rows), 'sites': summary})
    write_json(ROOT / 'data/url_audit.json', audit)
    print('Exported', len(rows), 'recipes', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=4, help='Concurrent requests per site')
    parser.add_argument('--delay', type=float, default=0.5, help='Minimum seconds between requests per site')
    parser.add_argument('--limit', type=int, default=0, help='Smoke test only; 0 means all discovered pages')
    parser.add_argument('--retry-errors', action='store_true')
    parser.add_argument('--rediscover', action='store_true')
    parser.add_argument('--sites', nargs='+', choices=SITES, default=SITES)
    args = parser.parse_args()
    with cf.ThreadPoolExecutor(len(args.sites)) as pool:
        reports = list(pool.map(lambda h: collect(h, args), args.sites))
    export(reports)

if __name__ == '__main__':
    main()
