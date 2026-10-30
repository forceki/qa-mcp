# QA skills

Six Claude Code skills that sit on top of the `qa-agent` MCP server and cover the QA loop:

| Skill | Use it to | Output |
|-------|-----------|--------|
| `qa-analyze` | Understand a feature: flows, rules, risks, open questions | `qa/<feature>/analysis.md` |
| `qa-test-cases` | Design prioritized, traceable, executable test cases | `qa/<feature>/test-cases.md` |
| `qa-run` | Execute cases with the `qa_*` tools and collect screenshot results | `result/<run>/README.md` per case |
| `qa-explore` | Time-boxed exploratory session with findings | findings + a result folder |
| `qa-report` | Summarize runs, classify failures, draft bugs, give a verdict | `qa/<feature>/report-<date>.md` |
| `qa-manual` | Write a short user manual: feature explanations and step-by-step guides with screenshots | `qa/<feature>/manual.md` |

Typical flow: `qa-analyze` -> `qa-test-cases` -> `qa-run` -> `qa-report`. `qa-explore` stands alone, and its findings can feed `qa-test-cases`. `qa-manual` can reuse screenshots from passing `qa-run` results.

## Install

```bash
npm run install:skills          # links skills/* into ~/.claude/skills (updates with git pull)
npm run install:skills -- --copy   # copy instead of link
```

Restart Claude Code, then ask in plain language, for example "analyze the checkout feature and write test cases" or "run the P0 cases and make a report".
