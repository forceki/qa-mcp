---
name: qa-run
description: "Execute test cases or a spec against a web app/API using the qa-agent MCP tools (qa_start_session, qa_navigate, qa_action, qa_assert, qa_request, qa_snapshot ...) and collect per-step screenshot results. Use when the user says run the tests, execute test cases, run the smoke/regression suite, test this flow, or verify a fix. Reads qa/<feature>/test-cases.md or a pasted spec. Hand results to qa-report."
---

# QA execution

Run test cases with the `qa-agent` MCP tools. If the `qa_*` tools are not available, tell the user to register the server (see this repo's README) and stop.

## Preflight
1. Confirm the target environment and base URL. **Never run write/destructive cases against production** unless the user explicitly says so.
2. Credentials come from env placeholders (`{{env:NAME}}`) or saved state. Do not ask the user to paste secrets into chat. If an env var is missing the step fails with a clear error: tell the user which variable to set.
3. `qa_list_states`: if a saved login for this app exists and is fresh, use `load_state`. Otherwise log in once in the first case and call `qa_save_state`.
4. Choose scope: all cases, a priority (P0 first), or a tag (`smoke`). Say what you will run.

## Per test case
1. `qa_start_session` with `test_name` = `<TC id> <title>` so the result folder is traceable. Pass `load_state` and Basic Auth if needed.
2. Run setup (often `qa_request`), then the steps in order, mapping each to the right tool with a clear `step_description`. Save created IDs with `save` / `qa_extract` and reuse them as `{{var:NAME}}`.
3. Check every tool result: `status`, `error`, `hint`, `new_tab`, `dialogs`, `browser_issues`.
   - Before an action that opens a confirm/alert/prompt, call `qa_dialog` (default is dismiss). Verify messages with `qa_assert dialog_shown`.
   - After a step opens a tab, you are already on it; use `qa_tab` to go back.
4. Run cleanup even if the case failed (`qa_request DELETE`, etc.).
5. `qa_finish_session` with `summary_notes` = the case ID and verdict. Keep the returned `report` path.

## When a step fails
Do not retry blindly and never weaken an assertion or edit expected results to get a pass.
1. Read `error`, `hint`, and the diagnostics files (`diagnostics.console`, `diagnostics.aria`).
2. If it is a **selector problem** (element exists but the locator is wrong, or `TBD`): `qa_snapshot`, pick the element, retry **once** with the better selector, and note the fix for the case file.
3. Otherwise classify and stop that case:
   - **FAIL, product defect**: behaviour differs from the expected result.
   - **FAIL, test issue**: case or selector is wrong (after the one retry).
   - **BLOCKED**: environment/data/login prevented the check (unreachable, missing seed data, expired state).
   - **FLAKY?**: passed on a clean re-run; report as flaky, do not hide it.
4. Continue with the next case. One failure never ends the run.

## Hygiene
- One session per case (isolation); reuse login via saved state.
- Passing steps can still show `browser_issues` (console errors, failed requests): record them.
- Use `{{rand}}` in created data so reruns do not collide.
- Keep a running table: case ID, verdict, run folder, failing step, notes.

## Finish
Give the user a short table (ID, verdict, result folder, failing step) with pass/fail/blocked counts, state what was **not** run, and offer `qa-report` to produce the full report and bug drafts.
