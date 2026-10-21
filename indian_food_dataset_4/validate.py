"""Check combined exports and discovery coverage without network access."""
import csv
import json
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parent / 'data'

def main():
    recipes = json.loads((DATA / 'recipes.json').read_text())
    report = json.loads((DATA / 'crawl_report.json').read_text())
    audit = json.loads((DATA / 'url_audit.json').read_text())
    with (DATA / 'recipes.csv').open(newline='', encoding='utf-8') as f:
        csv_rows = list(csv.DictReader(f))
    assert len(recipes) == len(csv_rows) == report['recipe_count']
    assert len({r['url'] for r in recipes}) == len(recipes), 'Duplicate final URLs'
    for row, csv_row in zip(recipes, csv_rows):
        assert row['title'] and row['ingredients'], row['url']
        if not row['instructions']:
            assert any(a.get('warnings') for a in audit if a['url'].rstrip('/') == row['url'].rstrip('/')), row['url']
        assert isinstance(row['ingredients'], list), row['url']
        assert isinstance(row['instructions'], str), row['url']
        for key, value in row.items():
            if isinstance(value, (list, dict)):
                assert json.loads(csv_row[key]) == value, (row['url'], key)
            else:
                assert csv_row[key] == ('' if value is None else str(value)), (row['url'], key)
    for site in report['sites']:
        host = site['source']
        discovery = json.loads((DATA / 'discovery' / (host + '.json')).read_text())
        outcomes = [a for a in audit if a['source'] == host]
        assert {a['url'] for a in outcomes} == set(discovery['urls']), host
        assert len(outcomes) == len(discovery['urls']), host
        assert dict(Counter(a['status'] for a in outcomes)) == site['counts'], host
        assert not site['counts'].get('not_attempted'), f'Unattempted URLs: {host}'
    print(f'Validated {len(recipes):,} recipes: JSON/CSV equivalent, unique URLs, full discovery audit.')
    for site in report['sites']:
        print(site['source'], site['counts'])

if __name__ == '__main__':
    main()
