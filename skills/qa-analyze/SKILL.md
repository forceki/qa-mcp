---
name: qa-analyze
description: "Analyze a feature, requirement, ticket, API or running web app before testing it: flows, rules, roles, data constraints, risks ranked by impact, ambiguities and test-data needs. Use when the user asks to analyze, review requirements, assess risk, plan testing, or says what should we test for X. Writes qa/<feature>/analysis.md. Hand off to qa-test-cases."
---

# QA analysis

Turn a vague feature into something testable. Output is a short, honest document, not a template filled with guesses.

## 1. Collect inputs
Read what exists: the requirement/ticket text, API docs or OpenAPI, the code (routes, validators, permissions), prior bugs, existing specs in `qa/`. If the user gave a URL, explore it (step 2). If key inputs are missing, ask the smallest set of questions that unblocks you; do not invent business rules.

## 2. Explore the app read-only (only if a URL is available)
Use the `qa-agent` MCP tools:
- `qa_start_session` (name it `analyze-<feature>`; pass `load_state` if a saved login exists, see `qa_list_states`; Basic Auth via env, never typed in chat).
- `qa_navigate`, then `qa_snapshot` on each screen to learn fields, buttons, roles and states.
- Look, do not change anything. No submitting forms, deleting, or sending emails. Confirm the environment is not production before any write.
- Note `browser_issues` in tool results (console errors, 4xx/5xx) as observations.
- `qa_finish_session` when done.

## 3. Write `qa/<feature>/analysis.md`
Follow an existing `qa/` or `docs/` convention if the project has one. Sections:

1. **Scope and goal**: one paragraph; what is in and explicitly out.
2. **Actors and permissions**: roles and what each may do.
3. **Main flows**: numbered happy paths, then alternate/error flows.
4. **Business rules**: each rule with its source (ticket, code, observed). Mark `observed` vs `stated`.
5. **Data and field constraints**: type, length, format, required, uniqueness, boundaries.
6. **States and transitions**: statuses and what moves between them.
7. **Integrations and APIs**: endpoints, side effects, async jobs, emails.
8. **Risks**: table with Risk, Impact (H/M/L), Likelihood (H/M/L), Why, Suggested coverage. Sort by impact x likelihood.
9. **Ambiguities and questions**: things the requirement does not answer. Do not resolve them silently.
10. **Assumptions**: anything you assumed to proceed.
11. **Test data and environment needs**: accounts per role, seed data, feature flags, cleanup strategy.
12. **Suggested coverage**: which techniques apply where (equivalence classes, boundary values, decision tables, state transitions, permissions matrix, error guessing).

## Rules
- Separate fact from inference. Every rule says where it came from.
- Prefer a few high-risk items over an exhaustive list.
- Never put credentials or tokens in the document.
- End by telling the user the open questions and offering `qa-test-cases` as the next step.
