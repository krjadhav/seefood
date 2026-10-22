// Browser transport for public pages whose direct HTTP responses fail.
// Saves local HTML only; scrape.py extracts recipe cards with recipe-scrapers.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = 'https://www.indianhealthyrecipes.com';
const dir = path.join(__dirname, '.cache/www.indianhealthyrecipes.com/html');
const manifest = path.join(__dirname, 'data/discovery/www.indianhealthyrecipes.com.json');
const previous = process.argv.includes('--retry-errors') && fs.existsSync(manifest)
  ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
const known = new Set(previous ? previous.urls : [base + '/recipes/']);
const queue = previous ? previous.urls.filter(url => !fs.existsSync(path.join(dir,
  crypto.createHash('sha256').update(url).digest('hex') + '.html'))) : [...known];
const errors = [];
let active = 0, completed = 0, nextStart = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function save() {
  const tmp = manifest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ source: 'www.indianhealthyrecipes.com',
    discovered_at: new Date().toISOString(), method: 'browser recipe index and internal links',
    urls: [...known].sort(), errors }, null, 2) + '\n');
  fs.renameSync(tmp, manifest);
}
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const req = route.request();
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType()) ||
          new URL(req.url()).hostname !== 'www.indianhealthyrecipes.com') return route.abort();
      return route.continue();
    });
    const check = await context.newPage();
    const rr = await check.goto(base + '/robots.txt');
    if (!rr.ok()) throw new Error('Cannot read robots.txt');
    const robots = await rr.text();
    // Abort if policy changes beyond the known wp-admin restriction.
    const disallows = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map(m => m[1]);
    if (disallows.some(p => p !== '/wp-admin/')) throw new Error('Review changed robots.txt before crawling');
    await check.close();
    async function worker() {
      const page = await context.newPage();
      while (queue.length || active) {
        const url = queue.shift();
        if (!url) { await sleep(200); continue; }
        active++;
        try {
          const file = path.join(dir, crypto.createHash('sha256').update(url).digest('hex') + '.html');
          let html;
          if (fs.existsSync(file)) {
            html = fs.readFileSync(file, 'utf8');
            await page.setContent(html, { waitUntil: 'domcontentloaded' });
          } else {
            const start = Math.max(Date.now(), nextStart); nextStart = start + 500;
            await sleep(Math.max(0, start - Date.now()));
            const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            if (r && !r.ok()) throw new Error('HTTP ' + r.status());
            html = r ? await r.text() : await page.content();
            fs.writeFileSync(file, html);
          }
          const links = await page.locator('a[href]').evaluateAll(aa => aa.map(a => a.getAttribute('href')));
          for (const href of links) {
            let u; try { u = new URL(href, url); } catch { continue; }
            if (u.origin !== base || u.search || /(?:wp-|comment-page|feed|print|privacy|about|contact|disclaimer)/.test(u.pathname)) continue;
            if (!/^\/[^/]+\/$/.test(u.pathname) && !u.pathname.startsWith('/recipes/')) continue;
            u.hash = '';
            const link = u.href;
            if (!known.has(link)) { known.add(link); queue.push(link); }
          }
          completed++;
          if (completed % 50 === 0) { save(); console.log('Completed', completed, 'discovered', known.size, 'queued', queue.length); }
        } catch (e) { errors.push({ url, error: e.message }); }
        finally { active--; }
      }
      await page.close();
    }
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    save();
    console.log('Finished', completed, 'pages;', errors.length, 'errors');
  } finally { await browser.close(); }
})().catch(e => { save(); console.error(e); process.exitCode = 1; });
