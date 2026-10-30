// Render a manual.md to PDF in the Jamkrida user-manual format (based on "USER MANUAL IJP PERIODIK & SPLIT ND & WP.docx"):
// cover (title, subtitle, logo, company, year), DAFTAR ISI with page numbers, then
// "# " = Heading 1 (I., II.), "## " = Heading 2 (1., 2.), "### " = Heading 3 (a., b.), Tahoma 11pt, A4, 1" margins.
//
// Usage: node skills/qa-manual/scripts/md2pdf.cjs <manual.md> <out.pdf> [--template <manual.docx>]
//   --template (or env QA_MANUAL_TEMPLATE): a .docx in this format; its cover logo and embedded Tahoma fonts are used.
//
// manual.md starts with front matter for the cover:
//   ---
//   title: PANDUAN PENGGUNAAN
//   subtitle: PORTAL MITRA – PERMOHONAN PENJAMINAN
//   company: PT JAMKRIDA JABAR
//   year: 2026
//   ---
// Body: headings, paragraphs, "1." numbered steps (indent 3 spaces for sub-bullets "-"), "-" bullets,
// images ![alt](path), "> " notes, and | tables |.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./annotate.cjs');

const argv = process.argv.slice(2);
const tIdx = argv.indexOf('--template');
const template = tIdx >= 0 ? argv.splice(tIdx, 2)[1] : process.env.QA_MANUAL_TEMPLATE;
const [mdPath, outPdf] = argv;
if (!mdPath || !outPdf) { console.error('usage: md2pdf.cjs <manual.md> <out.pdf> [--template <manual.docx>]'); process.exit(2); }
const dir = path.dirname(mdPath);

// ---------- template assets (logo + fonts) ----------
function fromDocx(entry) {
  try { return execFileSync('unzip', ['-p', template, entry], { maxBuffer: 64 << 20 }); } catch { return null; }
}
let logo = null;
const fonts = {};
if (template) {
  const docXml = (fromDocx('word/document.xml') || '').toString();
  const rels = (fromDocx('word/_rels/document.xml.rels') || '').toString();
  const anchor = docXml.match(/<wp:anchor[\s\S]*?r:embed="([^"]+)"/); // the cover logo is the first floating image
  const target = anchor && (rels.match(new RegExp(`Id="${anchor[1]}"[^>]*Target="([^"]+)"`)) ||
                            rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${anchor[1]}"`)));
  if (target) logo = fromDocx('word/' + target[1]);
  fonts.regular = fromDocx('word/fonts/Tahoma-regular.ttf');
  fonts.bold = fromDocx('word/fonts/Tahoma-bold.ttf');
  if (!logo) console.warn('warning: no cover logo found in template');
}

// ---------- parse ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
let src = fs.readFileSync(mdPath, 'utf8');
const meta = {};
const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
if (fm) {
  for (const l of fm[1].split('\n')) { const m = l.match(/^(\w+):\s*(.*)$/); if (m) meta[m[1]] = m[2].trim(); }
  src = src.slice(fm[0].length);
}

const roman = (n) => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] || String(n);
const letter = (n) => String.fromCharCode(96 + n);
const headings = []; // { level, label, text, id }
let h = [0, 0, 0];
let html = '';
let list = null; // stack of open list tags
let olCount = 0; // items in the current top-level numbered list
let resume = 0; // continue numbering after an image that interrupted a list
let table = false;
let level = 0; // current heading level, for paragraph indentation
const closeLists = () => { while (list && list.length) html += `</${list.pop()}>`; list = null; resume = 0; };
const closeTable = () => { if (table) { html += '</tbody></table>'; table = false; } };

const lines = src.split('\n');
for (const line of lines) {
  let m;
  if (!line.startsWith('|')) closeTable();
  const isItem = /^\s*(\d+\.|-) /.test(line);
  if (!isItem && line.trim() !== '') {
    const img = /^!\[/.test(line);
    const keep = img && (list ? list[0] === 'ol' : resume) ? (list ? olCount : resume) : 0;
    closeLists();
    resume = keep; // a numbered list interrupted by an image picks up where it stopped
  }
  if ((m = line.match(/^(#{1,3}) (.*)/))) {
    closeLists();
    const lv = m[1].length;
    h[lv - 1]++; for (let k = lv; k < 3; k++) h[k] = 0;
    const label = lv === 1 ? roman(h[0]) + '.' : lv === 2 ? h[1] + '.' : letter(h[2]) + '.';
    const id = 'h' + headings.length;
    headings.push({ level: lv, label, text: m[2], id });
    level = lv;
    html += `<h${lv} id="${id}"><span class="num">${label}</span><span>${inline(m[2])}</span><i class="mark">@@${id}@@</i></h${lv}>`;
  } else if ((m = line.match(/^!\[(.*)\]\((.*)\)/))) {
    const data = fs.readFileSync(path.resolve(dir, m[2])).toString('base64');
    html += `<figure><img src="data:image/png;base64,${data}" alt="${esc(m[1])}"></figure>`;
  } else if ((m = line.match(/^(\s*)(\d+\.|-) (.*)/))) {
    const depth = Math.floor(m[1].length / 3);
    const tag = m[2] === '-' ? 'ul' : 'ol';
    if (!list) list = [];
    while (list.length > depth + 1) html += `</${list.pop()}>`;
    if (list.length === depth + 1 && list[depth] !== tag) html += `</${list.pop()}>`;
    if (list.length < depth + 1) {
      if (depth === 0) { olCount = tag === 'ol' ? resume : 0; }
      html += `<${tag} class="d${depth}"${depth === 0 && tag === 'ol' && resume ? ` start="${resume + 1}"` : ''}>`;
      list.push(tag);
      resume = 0;
    }
    if (depth === 0 && tag === 'ol') olCount++;
    html += `<li>${inline(m[3])}</li>`;
  } else if ((m = line.match(/^> (.*)/))) {
    html += `<p class="note l${level}">${inline(m[1])}</p>`;
  } else if (line.startsWith('|')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!table) { html += `<table class="l${level}"><thead><tr>` + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'; table = true; }
    else html += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
  } else if (line.trim()) {
    html += `<p class="l${level}">${inline(line)}</p>`;
  }
}
closeLists(); closeTable();

// ---------- layout ----------
const font = (name, buf, weight) => buf ? `@font-face{font-family:"${name}";src:url(data:font/ttf;base64,${buf.toString('base64')}) format("truetype");font-weight:${weight};}` : '';
const css = `
${font('TahomaT', fonts.regular, 400)}${font('TahomaT', fonts.bold, 700)}
@page { size: A4; margin: 1in; }
* { box-sizing: border-box; }
body { margin: 0; font: 11pt/1.15 TahomaT, Tahoma, "DejaVu Sans", sans-serif; color: #000; }
b { font-weight: 700; }
.cover { height: 9.6in; position: relative; text-align: center; font-weight: 700; font-size: 24pt; break-after: page; }
.cover .title { padding-top: 14pt; line-height: 1.5; }
.cover .logo { position: absolute; top: 2.9in; left: 0; right: 0; }
.cover .logo img { width: 1.16in; height: 1.44in; }
.cover .org { position: absolute; top: 6.9in; left: 0; right: 0; line-height: 1.5; }
.toc { break-after: page; }
.toc h1.t { text-align: center; font-size: 14pt; font-weight: 700; margin: 14pt 0 30pt; display: block; }
.toc .e { display: flex; font-family: Arial, "Liberation Sans", sans-serif; font-size: 11pt; margin-top: 3pt; }
.toc .e .x { flex: 1; }
.toc .e.l1 { font-weight: 700; }
.toc .e.l2 { padding-left: 0.25in; }
.toc .e.l3 { padding-left: 0.5in; }
h1, h2, h3 { display: flex; margin: 0; break-after: avoid; position: relative; }
h1 { font-size: 13pt; font-weight: 700; margin: 14pt 0 10pt; padding-left: 0.25in; }
h1 .num { width: 0.5in; flex: none; }
h1 + h1 { margin-top: 0; }
h2 { font-size: 11pt; font-weight: 400; margin: 12pt 0 10pt; padding-left: 0.25in; }
h2 .num { width: 0.25in; flex: none; }
h3 { font-size: 11pt; font-weight: 400; margin: 12pt 0 0; padding-left: 0.75in; }
h3 .num { width: 0.25in; flex: none; }
.mark { position: absolute; left: 0; top: 0; font-size: 1px; color: transparent; font-style: normal; }
h1.pb { break-before: page; }
p { margin: 14pt 0 4pt; text-align: justify; }
p.l1 { text-indent: 0.5in; }
p.l2, p.l3 { margin-left: 0.5in; text-indent: 0.5in; }
p.note { text-indent: 0; margin-left: 0.5in; }
p:has(+ ul), p:has(+ ol), p:has(+ table) { break-after: avoid; }
ol, ul { margin: 0 0 4pt; padding-left: 1in; }
ol.d1, ul.d1 { padding-left: 0.5in; }
li { margin-top: 14pt; padding-left: 0.08in; text-align: justify; }
li li { margin-top: 2pt; }
ul { list-style: disc; } ul.d1 { list-style: circle; }
figure { margin: 14pt 0 4pt 0.5in; text-align: center; break-inside: avoid; }
figure img { max-width: 5.5in; max-height: 4.6in; border: 1px solid #bbb; }
table { border-collapse: collapse; width: calc(100% - 0.5in); margin: 14pt 0 4pt 0.5in; font-size: 10pt; }
table.l1 { width: 100%; margin-left: 0; }
th, td { border: 1px solid #000; padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background: #d9d9d9; font-weight: 700; }
tr { break-inside: avoid; }
code { font-family: monospace; font-size: 10pt; }
`;

const page = (pages) => {
  const toc = headings.map((x) => `<div class="e l${x.level}"><span class="x">${x.label} ${inline(x.text)}</span><span>${pages ? pages[x.id] || '' : '0'}</span></div>`).join('');
  const cover = `<div class="cover">
    <div class="title">${esc(meta.title || 'PANDUAN PENGGUNAAN')}<br>${esc(meta.subtitle || '')}</div>
    ${logo ? `<div class="logo"><img src="data:image/png;base64,${logo.toString('base64')}"></div>` : ''}
    <div class="org">${esc(meta.company || '')}<br>${esc(meta.year || String(new Date().getFullYear()))}</div>
  </div>`;
  // every Heading 1 after the first starts a new page, as in the template
  let body = html; let first = true;
  body = body.replace(/<h1 /g, () => (first ? (first = false, '<h1 ') : '<h1 class="pb" '));
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc((meta.title || '') + ' ' + (meta.subtitle || ''))}</title><style>${css}</style></head>
<body>${cover}<div class="toc"><h1 class="t">DAFTAR ISI</h1>${toc}</div>${body}</body></html>`;
};

(async () => {
  const browser = await launch();
  const tab = await browser.newPage();
  const render = async (pages) => {
    await tab.setContent(page(pages), { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    await tab.pdf({ path: outPdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
  };
  // pass 1: find which page each heading lands on via its hidden marker; pass 2: write the TOC page numbers
  await render(null);
  const text = execFileSync('pdftotext', ['-layout', outPdf, '-']).toString().split('\f');
  const pages = {};
  text.forEach((t, i) => { for (const m of t.matchAll(/@@(h\d+)@@/g)) pages[m[1]] ??= String(i + 1); });
  await render(pages);
  await browser.close();
  const missing = headings.filter((x) => !pages[x.id]).map((x) => x.text);
  if (missing.length) console.warn('warning: no page number for', missing);
  console.log('saved', outPdf, `(${text.length - 1} pages)`);
})().catch((e) => { console.error(e); process.exit(1); });
