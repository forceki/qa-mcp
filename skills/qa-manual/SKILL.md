---
name: qa-manual
description: "Write a user manual (buku manual / panduan pengguna) for a web app or feature: what each feature does and short step-by-step instructions with screenshots, captured with the qa-agent tools and annotated with numbered red boxes, delivered as a PDF in the client's user-manual template format (cover, DAFTAR ISI, I./1./a. sections). Also serves as test documentation (which flows were walked and when). Use when the user asks for a user manual, user guide, manual book, how-to guide, panduan, dokumentasi fitur, or to document how a feature works. Writes qa/<feature>/manual.md and manual-<feature>.pdf."
---

# User manual

A manual for end users: what a feature is for and how to use it. Short and scannable, not a test script. Every step in it must have actually been done in the app, so the manual doubles as evidence that the flow works.

## Scope
1. Agree the app/URL, the features to cover, the audience (end user, admin, internal tester) and the language. Default to the user's language (Indonesian if they write in Indonesian).
2. Reuse what exists: `qa/<feature>/analysis.md` for the feature list and roles, `test-cases.md` for the happy paths, and `result/<run>/step-N.png` screenshots from passing runs.
3. Test environment only, with clean demo data. Never use real customer data in screenshots.

## Walk the flows
For each feature not already covered by a passing run:
1. `qa_start_session` named `manual-<feature>` (use `load_state` for logins; credentials via `{{env:NAME}}`, never in chat).
2. Do the **main happy path only** with `qa_navigate` / `qa_action`, giving each step a plain `step_description` ("Klik tombol Simpan"). Each step produces the screenshot you will use.
3. Note on the way: required fields, the success message, and one or two common errors the user may hit.
4. If a step fails, do not document it as working. Mark the section "Belum dapat didokumentasikan" / "Could not be documented", note the error, and suggest `qa-report` or `qa-explore`.
5. `qa_finish_session`; keep the result folder path.

## Annotate the screenshots
Users follow pictures faster than text, so mark each picture: a red box around the element and a badge with the step number from the text (letters A, B, C for "what you see here" callouts).
1. Write `qa/<feature>/capture.cjs` that uses `skills/qa-manual/scripts/annotate.cjs` (`launch`, `frameWith`, `labelBox`, `menu`, `shot`). See `skills/qa-manual/scripts/example-capture.cjs` for an example. Log in with the saved state (`~/.qa-agent/states/<name>.json`) and write the images to `qa/<feature>/img/`.
2. Recreate the screens you already walked. Fill forms but **do not submit** unless the user agrees, so capturing creates no extra data. Mark only steps whose result you saw in the qa-agent run.
3. Number the badges to match the step numbers in the text exactly. Keep boxes from overlapping: use separate boxes with the same number instead of one huge box.
4. Look at every image before using it. Re-shoot it if a loader, an open dropdown, a cut-off box or the wrong value shows.

## Keep it short
- One feature = one section. 3-8 steps per task. If it needs more, split into two tasks.
- One action per step, imperative: "Klik **Tambah Produk**." Bold the exact UI label as it appears on screen.
- Only screenshot steps that change the screen meaningfully; not every click.
- Skip field-by-field explanations, internal logic, selectors, API details and edge cases. Put at most 2-3 tips or notes per feature.
- No test jargon (P0, assert, selector) in the user-facing text.

## Write `qa/<feature>/manual.md` in the house format
The output is a **PDF** in the format of the client's user-manual template ("USER MANUAL IJP PERIODIK & SPLIT ND & WP.docx"): a cover, a DAFTAR ISI page, then numbered sections. Write the Markdown in this shape (the headings are numbered automatically, so do not type numbers):
```
---
title: PANDUAN PENGGUNAAN
subtitle: <APLIKASI> – <MODUL>
company: PT JAMKRIDA JABAR
year: <YYYY>
---

# Ruang Lingkup                      -> I.
<Aplikasi ini untuk apa dan untuk siapa.> Panduan ini mencakup hal-hal sebagai berikut :
## Modul <Nama>                      -> 1.
### <Fitur 1>                        -> a.  (list each feature covered in section II)
### <Fitur 2>
Angka merah pada setiap gambar menunjukkan nomor langkah pada teks.

# Panduan Penggunaan Modul <Nama>    -> II.
## <Fitur 1>                         -> 1.
<1-2 kalimat: fitur ini untuk apa.>
1. Klik menu **<Menu>**.
2. Isi **<Field>**, lalu klik **<Tombol>**.
   - <sub-poin, indent 3 spaces>
![<alt>](img/<fitur>.png)            (an image may sit between steps; numbering continues after it)
3. ...
Jika berhasil, sistem menampilkan pesan "...".
Hal yang perlu diperhatikan:
- <tip atau error umum>
> **Catatan:** <hal yang belum diuji / batasan>
## Masalah Umum                      (optional table: | Masalah | Solusi |)

# Dokumentasi Pengujian              -> III.
<Kapan, di environment apa, dengan akun/data uji apa.>
| Fitur | Alur | Status (Terverifikasi / Gagal / Belum diuji) | Tanggal | Folder hasil |
```
Use relative image paths (`img/...`). Use English headings if the manual is in English.

## PDF
```
node skills/qa-manual/scripts/md2pdf.cjs qa/<feature>/manual.md qa/<feature>/manual-<feature>.pdf --template "<path to the template .docx>"
```
The script reproduces the template: A4 with 1" margins, Tahoma 11pt justified text, a cover (title, subtitle, logo, company, year), a DAFTAR ISI with page numbers, Heading 1 "I./II." (each starts on a new page), Heading 2 "1.", Heading 3 "a.", and the template's list indents. The cover logo and the Tahoma fonts are read from the template `.docx` (`--template` or env `QA_MANUAL_TEMPLATE`). Ask the user for the template path if you do not have it, and never copy the fonts or logo into the repo. Look at every page (`pdftoppm -r 40` contact sheet) before handing the PDF over.

## Rules
- Document only what you saw on screen. Do not invent menus, labels or messages; if unsure, check with `qa_snapshot`.
- Check screenshots and text for secrets, tokens or personal data before sharing.
- If the user wants to share it, offer to publish it as a doc or page, or send the PDF; do not publish without being asked.
- Finish with the PDF path, the features covered, and any feature that could not be documented and why.
