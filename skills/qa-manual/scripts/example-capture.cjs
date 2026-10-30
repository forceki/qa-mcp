// Annotated screenshots for qa/permohonan/manual.md (Portal Mitra, fitur Permohonan).
// Fills the form but never submits it, so no data is created.
// Example capture script (Portal Mitra, fitur Permohonan). Copy it to qa/<feature>/capture.cjs and adapt.
// Usage: node capture.cjs <statePath> <samplePdf> [outDir]
//   statePath: saved login from qa_save_state, e.g. ~/.qa-agent/states/local-mitra-5174.json
const path = require('path');
const { launch, menu, frameWith, labelBox, shot: shotFile, scrollTo } = require('./annotate.cjs');

const [statePath, samplePdf, outDir] = process.argv.slice(2);
const out = outDir || path.join(process.cwd(), 'img');
const BASE = process.env.BASE_URL || 'http://localhost:5174';
const shot = (page, name, marks) => shotFile(page, path.join(out, name + '.png'), marks);

(async () => {
  const browser = await launch();

  // 1. Login (no saved state)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/login');
    const f = await frameWith(page, 'Masuk ke Portal Mitra');
    await shot(page, 'login', [
      { label: '1', locs: [f.getByText('Email / Username'), f.getByPlaceholder('nama@bank.co.id atau username'), f.locator('input[type=password]')] },
      { label: '2', locs: [f.getByRole('button', { name: /MASUK KE SYSTEM/ })] },
    ]);
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: statePath });
  const page = await ctx.newPage();

  // 2. Form Ajukan Permohonan (filled, NOT submitted)
  await page.goto(BASE + '/submission/create');
  let f = await frameWith(page, 'Form Permohonan');
  const field = (label) => labelBox(f, label);
  await f.getByRole('button', { name: /Perorangan/ }).click();
  await field('Nomor Surat').locator('input').fill('SP/DEMO/001');
  await f.getByPlaceholder('16 digit NIK KTP').fill('3273010101900001');
  await field('Nama Nasabah').locator('input').first().fill('Budi Contoh');
  await field('Nilai Kredit').locator('input').fill('150000000');
  await field('Jangka Waktu (bulan)').locator('input').fill('12');
  await field('Penerima Jaminan').locator('.select2-selection, [role=combobox]').last().click();
  await f.locator('li.select2-results__option:visible').filter({ hasText: 'Bank BJB' }).first().click();
  await field('Jenis Kredit').locator('.select2-selection, [role=combobox]').last().click();
  await f.locator('li.select2-results__option:visible').getByText('KMK Perorangan', { exact: true }).click();
  await page.mouse.click(5, 5);
  await shot(page, 'form-data', [
    { label: '1', locs: [menu(f, 'Ajukan Permohonan')] },
    { label: '2', locs: [field('Nomor Surat')] },
    { label: '3', locs: [field('Jenis Nasabah')] },
    { label: '4', locs: [field('Nama Nasabah'), field('Nilai Kredit')] },
    { label: '5', locs: [field('Penerima Jaminan'), field('Jangka Waktu (bulan)'), field('Jenis Kredit')] },
  ]);

  // Upload the required documents (form is never submitted)
  const reqRows = f.locator('table').first().locator('tbody tr');
  const n = await reqRows.count();
  for (let i = 0; i < n; i++) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      reqRows.nth(i).getByRole('button', { name: 'Unggah' }).click(),
    ]);
    await chooser.setFiles(samplePdf);
    await page.waitForTimeout(200);
  }
  const submit = f.getByRole('button', { name: /Submit/ });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await submit.evaluate((e) => e.scrollIntoView({ block: 'end' }));
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(400);
  await shot(page, 'form-dokumen', [
    { label: '6', locs: [f.getByText('Dokumen Wajib'), f.locator('table').first()] },
    { label: '7', locs: [submit] },
  ]);
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. Daftar Permohonan + search
  await page.goto(BASE + '/submission/list');
  f = await frameWith(page, 'Cari Nasabah');
  const search = f.locator('input[type=search]');
  await search.fill('Budi Contoh');
  await search.press('Enter');
  await page.waitForTimeout(800);
  const listField = (label) => labelBox(f, label);
  await shot(page, 'daftar-cari', [
    { label: '1', locs: [menu(f, 'Daftar Permohonan')] },
    { label: '2', locs: [listField('Cari Nasabah')] },
    { label: '3', locs: [listField('Dari Tanggal'), listField('Filter Tanggal')] },
    { label: '3', locs: [listField('Status')] },
  ]);

  // 4. Edit: pencil icon on a Pending row, then the edit page
  const pendingRow = f.locator('tbody tr', { hasText: 'Pending' }).first();
  const pencil = pendingRow.locator('a').last();
  await shot(page, 'daftar-ubah', [{ label: '2', locs: [pencil] }]);
  await pencil.click();
  f = await frameWith(page, 'Edit Permohonan');
  await f.getByText('Nomor Surat').first().waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'edit', [{ label: '3', locs: [f.locator('form, .card').filter({ hasText: 'Nomor Surat' }).first()] }]);

  // 5. Detail: eye icon on a processed row, then the detail page
  await page.goto(BASE + '/submission/list');
  f = await frameWith(page, 'Cari Nasabah');
  await f.locator('tbody tr').first().waitFor();
  await page.waitForTimeout(800);
  const doneRow = f.locator('tbody tr', { hasText: 'Di Proses' }).first();
  const eye = doneRow.locator('a').last();
  await shot(page, 'daftar-detail', [{ label: '2', locs: [eye] }]);
  await eye.click();
  f = await frameWith(page, 'Detail Permohonan');
  await f.getByText('Total Exposure', { exact: false }).first().waitFor();
  await page.waitForTimeout(500);
  await shot(page, 'detail', [
    { label: 'A', locs: [f.getByText('Penerimaan SP3').first(), f.getByText('Submit', { exact: true }).first()] },
    { label: 'B', locs: [f.getByText('Nama Nasabah').first(), f.getByText('Nomor Surat').first(), f.getByText('Jangka Waktu').first()] },
    { label: 'C', locs: [f.getByText('Total Exposure', { exact: false }).first(), f.getByText('Dalam Proses', { exact: false }).first()] },
  ]);
  await scrollTo(f.getByText('File Kelengkapan').first());
  await shot(page, 'detail-file', [{ label: 'D', locs: [f.getByText('File Kelengkapan').first().locator('xpath=ancestor::*[2]')] }]);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
