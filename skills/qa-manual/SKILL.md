---
name: qa-manual
description: "Write a user manual (buku manual / panduan pengguna) for a web app or feature: what each feature does and short step-by-step instructions with screenshots, captured with the qa-agent tools or taken from existing result/ folders. Also serves as test documentation (which flows were walked and when). Use when the user asks for a user manual, user guide, manual book, how-to guide, panduan, dokumentasi fitur, or to document how a feature works. Writes qa/<feature>/manual.md."
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

## Keep it short
- One feature = one section. 3-8 steps per task. If it needs more, split into two tasks.
- One action per step, imperative: "Klik **Tambah Produk**." Bold the exact UI label as it appears on screen.
- Only screenshot steps that change the screen meaningfully; not every click.
- Skip field-by-field explanations, internal logic, selectors, API details and edge cases. Put at most 2-3 tips or notes per feature.
- No test jargon (P0, assert, selector) in the user-facing text.

## Write `qa/<feature>/manual.md` (or `qa/manual.md` for the whole app)
```
# <App> – Panduan Pengguna
Versi/build, tanggal, environment

## Daftar Isi

## 1. Pendahuluan
Apa aplikasi ini, untuk siapa, cara login, peran (role) jika ada.

## 2. <Fitur>
<1-2 kalimat: fitur ini untuk apa.>

### <Tugas, mis. Menambah produk>
1. Buka menu **Produk**.
2. Klik **Tambah Produk**.
   ![Form tambah produk](../../result/<run>/step-3.png)
3. Isi **Nama** dan **Harga**, lalu klik **Simpan**.

Hasil: muncul pesan "Produk berhasil disimpan".
> Catatan: <tip atau error umum dan cara mengatasinya>

## N. Pertanyaan Umum / Masalah Umum (optional)

## Lampiran: Dokumentasi Pengujian
| Fitur | Alur | Status (Terverifikasi / Gagal / Belum diuji) | Tanggal | Folder hasil |
```
Use relative image paths so the manual moves with the repo. Use English headings if the manual is in English.

## Rules
- Document only what you saw on screen. Do not invent menus, labels or messages; if unsure, check with `qa_snapshot`.
- Check screenshots and text for secrets, tokens or personal data before sharing.
- If the user wants to share it, offer to publish it as a doc or page, or export to PDF/Word; do not publish without being asked.
- Finish with the manual path, the features covered, and any feature that could not be documented and why.
