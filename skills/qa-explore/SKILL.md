---
name: qa-explore
description: "Run a time-boxed exploratory testing session on a web app with the qa-agent tools: follow a charter, probe with heuristics, record findings with screenshot evidence. Use when the user asks to explore, smoke-check, sanity test, find bugs in, or poke at a page/feature without predefined test cases."
---

# Exploratory testing

Unscripted but disciplined: a charter, a time box, notes, and evidence. Needs the `qa-agent` MCP tools.

## Setup
1. Agree a **charter**: `Explore <area> with <data/role/technique> to discover <risk>`. Example: "Explore checkout with invalid and boundary input to discover validation gaps." If the user gave only a URL, propose a charter and proceed.
2. Time box: about 20-30 tool steps unless told otherwise. Say when you reach it.
3. Test environment only. Do not run destructive actions on production. Use `load_state` / env placeholders for logins; never ask for secrets in chat.
4. `qa_start_session` named `explore-<area>`.

## Explore
Loop: observe (`qa_snapshot`), decide the next probe, act (`qa_action` / `qa_request`), look at the result (`status`, `error`, `browser_issues`, `dialogs`, screenshot).

Heuristics to pick probes:
- **Input**: empty, very long, unicode/emoji, leading/trailing spaces, special characters, HTML/script-looking text (as test data only), negative/zero/max values, wrong format.
- **Flow**: back/forward/reload mid-flow, double-click submit, open the same page in a second tab (`qa_tab`), skip steps by URL.
- **State**: logged out, expired session, different roles, existing vs new data.
- **CRUD**: create, read, update, delete, then check lists and counts reflect it (use `qa_request` to cross-check the API).
- **Interruptions**: dialogs (`qa_dialog`), popups, slow or failing requests.
- **Visual/UX**: layout breaks, truncated text, unclear errors, dead links (`qa_snapshot`, screenshots).
- **Console/network**: any `browser_issues` entry is a lead, even when the step passed.

## Record findings as you go
For each: short title, steps to reproduce (exact tool calls/URLs), expected vs actual, severity (Critical/Major/Minor/Cosmetic), the step number and the screenshot `step-N.png` in the result folder. Re-run the repro once to confirm before reporting it as a defect.

## Finish
`qa_finish_session` with the charter and finding count as `summary_notes`. Reply with: charter, what was covered, what was **not** covered, findings table, and open questions. Offer `qa-report` for a formal report and bug drafts, and `qa-test-cases` to turn good findings into regression cases.
