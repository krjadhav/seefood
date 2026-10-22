// Supplement HTML discovery with the site's own public Pagefind search index.
// Uses the parent repository's Playwright dependency and installed Chrome.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://www.bongeats.com/recipes', { waitUntil: 'domcontentloaded' });
    const urls = await page.evaluate(async () => {
      const search = await import('/pagefind/pagefind.js');
      const results = await search.search(null);
      const urls = [];
      for (const result of results.results) {
        urls.push((await result.data()).url);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return urls;
    });
    const output = path.join(__dirname, 'data/discovery/bongeats_search_index.json');
    fs.writeFileSync(output, JSON.stringify({
      source: 'https://www.bongeats.com/pagefind/pagefind.js',
      discovered_at: new Date().toISOString(),
      urls: urls.filter(u => /^\/recipe\/[^/]+\/$/.test(u))
        .map(u => 'https://www.bongeats.com' + u.replace(/\/$/, '')).sort()
    }, null, 2) + '\n');
    console.log('Saved', urls.length, 'search index URLs');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
