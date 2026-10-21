# Indian recipe collection

Collects recipe cards from Swasthi's Recipes, Dassana's Veg Recipes, Archana's
Kitchen, Ministry of Curry, and Bong Eats with
[recipe-scrapers](https://github.com/hhursev/recipe-scrapers/).

## Run

```sh
cd indian_food_dataset_4
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scrape.py
```

Requests are limited to two starts per second per host, with four concurrent
requests per host, robots.txt checks, timeouts and bounded retries for 429/5xx.
Sitemaps are traversed recursively; Bong Eats uses its public recipe index.
Recipe cards require a title, ingredients and instructions. Editorial article
text, comments, and image binaries are not included.

`.cache/` stores per-URL results for resumability and is not committed. Use
`--retry-errors` to retry failed requests and `--rediscover` to refresh URL lists.
Use `--limit 3` for a smoke run. These options overwrite the combined exports
with results from that run, so run without a limit for the full dataset.
`--sites HOST ...` similarly exports only the selected sites.

## Outputs

- `data/recipes.json`: combined recipe objects, deduplicated by final URL.
- `data/recipes.csv`: same records and fields; arrays and objects are JSON inside
  CSV cells. Unavailable scalar values are empty cells (null in JSON).
- `data/discovery/`: discovered URL lists, timestamps and discovery failures.
- `data/url_audit.json`: per-URL outcome, including non-recipes and failures.
- `data/crawl_report.json`: per-site coverage and counts.

Time fields are in minutes as returned by recipe-scrapers; nutrition and yield
retain source units. Source URLs and retrieval timestamps are included. The
source publishers retain their content rights; this repository does not grant
a new license to their recipe content.

“All” means recipe cards successfully extracted from discovered public URLs in
this snapshot. Site blocks, missing schema, missing sitemap entries and deleted
pages can prevent complete coverage; consult the report rather than assuming
that every recipe on a site is represented.

For a faster run with up to four request starts per second per host:

```sh
.venv/bin/python scrape.py --workers 12 --delay 0.25
```

To refresh Bong Eats' public search-index supplement (requires the parent
repository's installed Playwright dependency and Google Chrome):

```sh
node discover_bongeats.cjs
.venv/bin/python scrape.py --sites www.bongeats.com --rediscover
.venv/bin/python scrape.py --export-only
```

The supplement stores URLs only; recipe cards are still parsed by
recipe-scrapers. `--export-only` makes no network requests and combines cached
results against all saved discovery manifests, marking any unattempted URLs.
