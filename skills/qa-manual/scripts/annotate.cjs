// Helpers for annotated manual screenshots: red boxes with a numbered badge drawn over the real page.
// Usage from a capture script:
//   const { launch, frameWith, labelBox, shot, scrollTo } = require('<repo>/skills/qa-manual/scripts/annotate.cjs');
//   await shot(page, 'out/form.png', [{ label: '1', locs: [locator, ...] }, ...]);
const path = require('path');
const { chromium } = require(require.resolve('playwright', { paths: [path.resolve(__dirname, '../../..'), process.cwd()] }));

// Same flags as the qa-agent browser; falls back to system Chrome if the bundled Chromium crashes.
async function launch() {
  const args = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];
  let browser;
  try { browser = await chromium.launch({ args }); const p = await browser.newPage(); await p.close(); }
  catch { await browser?.close().catch(() => {}); browser = await chromium.launch({ args, channel: 'chrome' }); }
  return browser;
}

// A sidebar menu item (the whole pill, not just its text).
const menu = (f, text) => f.getByText(text, { exact: true }).first().locator('xpath=..');

// Text of a full-page loading overlay to wait out before capturing (set per app).
let LOADING_TEXT = process.env.QA_LOADING_TEXT || 'Memuat Sistem';

// Find the frame (main page or iframe) whose document contains `text`.
async function frameWith(page, text) {
  for (let i = 0; i < 40; i++) {
    const loading = await Promise.all(page.frames().map((fr) => fr.getByText(LOADING_TEXT).first().isVisible().catch(() => false)));
    if (loading.some(Boolean)) { await page.waitForTimeout(250); continue; }
    for (const f of page.frames()) {
      if (await f.getByText(text, { exact: false }).first().isVisible().catch(() => false)) return f;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('frame not found for ' + text);
}


// The wrapper of a form field: parent of the deepest element whose text is the label (optionally followed by "*").
function labelBox(f, label) {
  const l = label.replace(/ \*$/, '');
  const x = `starts-with(normalize-space(.), "${l}") and string-length(normalize-space(.)) <= ${l.length + 2}`;
  return f.locator(`xpath=//*[${x}][not(*[${x}])]/parent::*`).first();
}

async function union(locators) {
  let b = null;
  for (const l of locators) {
    const r = await l.boundingBox();
    if (!r) continue;
    b = b ? {
      x1: Math.min(b.x1, r.x), y1: Math.min(b.y1, r.y),
      x2: Math.max(b.x2, r.x + r.width), y2: Math.max(b.y2, r.y + r.height),
    } : { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
  }
  if (!b) throw new Error('no box');
  return b;
}

// marks: [{ label, locs: [locator...] }]; boxes are drawn in the top document with fixed positions.
async function shot(page, file, marks) {
  const boxes = [];
  for (const m of marks) boxes.push({ label: m.label, ...(await union(m.locs)) });
  await page.evaluate((boxes) => {
    document.querySelectorAll('.qa-anno').forEach((e) => e.remove());
    for (const b of boxes) {
      const pad = 5;
      const d = document.createElement('div');
      d.className = 'qa-anno';
      Object.assign(d.style, {
        position: 'fixed', left: b.x1 - pad + 'px', top: b.y1 - pad + 'px',
        width: b.x2 - b.x1 + pad * 2 + 'px', height: b.y2 - b.y1 + pad * 2 + 'px',
        border: '3px solid #e11d48', borderRadius: '8px', zIndex: 2147483646,
        pointerEvents: 'none', boxSizing: 'border-box',
      });
      const s = document.createElement('div');
      s.className = 'qa-anno';
      s.textContent = b.label;
      Object.assign(s.style, {
        position: 'fixed', left: Math.max(2, b.x1 - pad - 14) + 'px', top: Math.max(2, b.y1 - pad - 14) + 'px',
        minWidth: '28px', height: '28px', padding: '0 6px', borderRadius: '14px', background: '#e11d48',
        color: '#fff', font: '700 15px/28px system-ui, sans-serif', textAlign: 'center',
        zIndex: 2147483647, pointerEvents: 'none', boxShadow: '0 1px 4px rgba(0,0,0,.35)', boxSizing: 'border-box',
      });
      document.body.appendChild(d);
      document.body.appendChild(s);
    }
  }, boxes);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.querySelectorAll('.qa-anno').forEach((e) => e.remove()));
  console.log('saved', file);
}

async function scrollTo(loc) {
  await loc.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await loc.page().waitForTimeout(300);
}


module.exports = { launch, menu, frameWith, labelBox, union, shot, scrollTo };
