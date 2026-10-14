---
name: qa-test-cases
description: "Write structured, prioritized test cases (positive, negative, boundary, permission, API) from an analysis, requirement or ticket, in a format the qa-run skill can execute with the qa_* tools. Use when the user asks for test cases, a test plan, a test suite, regression/smoke cases, or coverage for a feature. Writes qa/<feature>/test-cases.md."
---

# QA test case design

Input: `qa/<feature>/analysis.md` if it exists (otherwise the requirement; offer `qa-analyze` first when risks are unclear). Output: `qa/<feature>/test-cases.md`.

## Design rules
- Derive cases from the analysis: equivalence classes, boundary values, decision tables, state transitions, permissions matrix, error guessing on the top risks.
- One focus per case. Cases are independent: each creates its own data and cleans it up, so they can run in any order.
- Cover for each flow: happy path, validation/negative, boundary, permission/role, and where relevant API-level checks and concurrency/duplicate submits.
- Priority: **P0** blocks release if broken (login, payment, data loss), **P1** core behaviour, **P2** edge cases, **P3** cosmetic.
- Every case traces to a requirement or risk ID. List gaps explicitly in the coverage matrix rather than padding the suite.

## Case format (executable by qa-run)

```
### TC-<AREA>-<NNN> | <title>
- Priority: P0 | Type: functional-positive | Tags: smoke, regression | Automation: ready
- Traces to: REQ-12, RISK-3
- Preconditions: <state needed, login: saved state "dev-admin">
- Data: email = qa-{{rand}}@example.com; password from {{env:QA_APP_PASS}}
- Steps:
  1. navigate {{base_url}}/login
  2. fill `#email` <- {{env:QA_APP_USER}}
  3. click `button[type=submit]`
  4. assert url_matches `/dashboard`
- Expected: user lands on dashboard; greeting shows the user's name
- Cleanup: DELETE /api/users/{{var:user_id}}
```

Steps use this vocabulary, which maps 1:1 to the tools:

| Step | Tool |
|------|------|
| navigate URL | `qa_navigate` |
| click / dblclick / hover / scroll / check / uncheck / fill / press / select / upload | `qa_action` |
| assert text_present / url_matches / element_visible / dialog_shown | `qa_assert` |
| extract text/value/attribute/count into a variable | `qa_extract` |
| request METHOD path (expect status, expect json, save) | `qa_request` |
| accept / dismiss next dialog (before the triggering action) | `qa_dialog` |
| switch / close / new tab | `qa_tab` |

## Rules for steps
- Selectors: prefer `data-testid`, ids, roles, visible text. Use `TBD` when unknown and let qa-run resolve it with `qa_snapshot` on first execution. Never write snapshot refs (`ref=e7`) into a saved case; they change per run.
- Placeholders: `{{env:NAME}}` for secrets, `{{rand}}` / `{{timestamp}}` for unique data, `{{var:NAME}}` for values saved earlier. Never write a real password, token or key into the file.
- Expected results must be observable and specific ("error 'Email already used' is shown"), not "works correctly".
- Use API steps (`qa_request`) for setup and cleanup, UI steps for the behaviour under test.

## File layout
1. Header: feature, environment/base URL, accounts/roles needed (env variable names only), how to run.
2. Summary table: ID, title, priority, type, automation, traces.
3. Cases, grouped by area.
4. Coverage matrix: requirement/risk -> case IDs, with uncovered items called out.

Finish by reporting counts per priority and the gaps, and offer `qa-run` (suggest running P0/smoke first).
