---
name: qa-report
description: "Compile a QA test report from qa-agent run results: verdict, pass/fail/blocked counts, failures classified (product defect, test issue, environment, flaky), evidence links, coverage versus requirements, and ready-to-file bug drafts. Use when the user asks for a test report, summary, results, bug reports, release sign-off, or to summarize the test run. Reads the result/ folders and qa/<feature>/test-cases.md."
---

# QA reporting

Turn raw run folders into a report a developer, PM or release manager can act on. Report only what was actually executed.

## Gather
1. Find the run folders (`result/<name>-<timestamp>/` or the paths from `qa_finish_session`). Read each `README.md`: overall result, step table, durations, error blocks, "Browser issues", diagnostics links.
2. For failed steps also read `step-N-console.txt` (console/network log) and `step-N-aria.yml` (page state), and look at `step-N.png`.
3. Read `qa/<feature>/test-cases.md` and `analysis.md` if present, to map results to cases, priorities and requirements.
4. If several runs cover the same case, use the latest and mention reruns.

## Classify every failure
| Class | Meaning |
|-------|---------|
| Product defect | The app behaves differently from the expected result (reproducible) |
| Test issue | Case, selector or data is wrong |
| Environment/data | Env down, missing seed data, expired login, third-party outage |
| Flaky/unknown | Passed on rerun or cannot be reproduced; keep visible |

Give the evidence for each classification (error text, console line, screenshot).

## Write `qa/<feature>/report-<YYYY-MM-DD>.md`
1. **Summary**: scope, environment/build, date, tester, and one-line verdict.
2. **Verdict**: GO / NO-GO / GO WITH RISKS, with the reasons. P0 failures mean NO-GO. Say it is a recommendation.
3. **Results table**: planned, executed, passed, failed, blocked, not run, grouped by priority.
4. **Failures**: ID, title, priority, class, failing step, short cause, link to the result folder and screenshot (relative paths so the report moves with the folder).
5. **Observations on passing steps**: console errors, failed requests, slow steps (duration far above the norm).
6. **Coverage**: requirement/risk -> cases -> results; list uncovered items and cases not run, and why.
7. **Defects**: one draft per product defect (below).
8. **Risks and recommendations**: residual risk, suggested retests, flaky areas, test-suite fixes.
9. **Appendix**: run folder list.

### Defect draft
```
Title: <component>: <what is wrong> when <condition>
Severity: Critical | Major | Minor | Cosmetic    Priority: P0-P3
Environment: <URL, build/version, browser, date>
Steps to reproduce: 1... 2... (exact data and selectors/URLs)
Expected: ...
Actual: ...
Evidence: result/<run>/step-N.png, step-N-console.txt
Notes: frequency, workaround, related cases
```

## Rules
- Never mark something passed that was not run. Say "not run" and why.
- Do not inflate or hide: flaky stays flaky; a pass with console errors is noted.
- Check the report for secrets (passwords, tokens, cookies) before it leaves the machine. The tools mask them, but scan anyway, and tell the user the screenshots can still show on-screen data.
- If the user wants to share it, offer to publish it as a shareable page or doc; do not publish without being asked.
- Finish with the verdict, the failure count by class, and the path to the report.
