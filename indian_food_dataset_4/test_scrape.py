import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import scrape
import requests

HTML = '''<html><script type="application/ld+json">{
"@context":"https://schema.org", "@type":"Recipe", "name":"Test Dal",
"recipeIngredient":["1 cup lentils", "Salt, to taste"],
"recipeInstructions":[{"@type":"HowToStep","text":"Rinse lentils."},
{"@type":"HowToStep","text":"Cook until tender."}],"totalTime":"PT30M"
}</script></html>'''

class CollectorTests(unittest.TestCase):
    def test_rate_limit_sets_shared_cooldown(self):
        limited = requests.Response()
        limited.status_code = 429
        limited.headers['Retry-After'] = '90'
        limited._content = b''
        success = requests.Response()
        success.status_code = 200
        success._content = b'ok'
        with tempfile.TemporaryDirectory() as tmp, patch.object(scrape, 'ROOT', Path(tmp)):
            site = scrape.Site('example.com', 0)
            with patch('scrape.requests.get', side_effect=[limited, success]), patch('scrape.time.sleep') as sleep:
                self.assertIs(site.get('https://example.com/dal'), success)
                self.assertGreaterEqual(site.delay, 1)
                self.assertTrue(any(call.args[0] > 89 for call in sleep.call_args_list))

    def test_html_charset_overrides_requests_latin1_default(self):
        response = requests.Response()
        response.status_code = 200
        response._content = '<meta charset="utf-8"><p>¼ tsp — café</p>'.encode()
        response.encoding = 'ISO-8859-1'
        with tempfile.TemporaryDirectory() as tmp, patch.object(scrape, 'ROOT', Path(tmp)):
            site = scrape.Site('example.com', 0)
            with patch('scrape.requests.get', return_value=response):
                self.assertIn('¼ tsp — café', site.get('https://example.com/dal').text)

    def test_bong_eats_unordered_steps(self):
        html = HTML + '''<div class="recipe-ingredients"><ul><li>¼ tsp salt</li></ul></div>
        <div class="recipe-process"><ul><li>Mix.</li><li>Serve.</li></ul></div>'''
        with tempfile.TemporaryDirectory() as tmp, patch.object(scrape, 'ROOT', Path(tmp)):
            site = scrape.Site('www.bongeats.com', 0)
            response = type('Response', (), {'text': html, 'url': 'https://www.bongeats.com/recipe/test'})()
            with patch.object(site, 'get', return_value=response):
                result = site.scrape(response.url)
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(result['recipe']['instructions'], 'Mix.\nServe.')

    def test_recipe_extraction_resume_and_csv_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(scrape, 'ROOT', Path(tmp)):
            site = scrape.Site('example.com', 0)
            response = type('Response', (), {'text': HTML, 'url': 'https://example.com/dal'})()
            with patch.object(site, 'get', return_value=response) as get:
                result = site.scrape(response.url)
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(result['recipe']['total_time'], 30)
                self.assertEqual(site.scrape(response.url), result)
                self.assertEqual(get.call_count, 1)
            scrape.export([{'source': site.host, 'results': [result, result]}])
            rows = json.loads((Path(tmp) / 'data/recipes.json').read_text())
            self.assertEqual(len(rows), 1)
            with (Path(tmp) / 'data/recipes.csv').open(newline='') as f:
                csv_rows = list(csv.DictReader(f))
            self.assertEqual(json.loads(csv_rows[0]['ingredients']), rows[0]['ingredients'])
            self.assertEqual(csv_rows[0]['instructions'], rows[0]['instructions'])

    def test_nonrecipe_and_http_failure_are_distinct(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(scrape, 'ROOT', Path(tmp)):
            site = scrape.Site('example.com', 0)
            response = type('Response', (), {'text': '<html>About us</html>', 'url': 'https://example.com/about'})()
            with patch.object(site, 'get', return_value=response):
                self.assertEqual(site.scrape(response.url)['status'], 'no_recipe')
            with patch.object(site, 'get', side_effect=RuntimeError('HTTP failure')):
                self.assertEqual(site.scrape('https://example.com/fail')['status'], 'error')

if __name__ == '__main__':
    unittest.main()
