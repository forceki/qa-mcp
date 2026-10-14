# qa-agent

A local-first [MCP](https://modelcontextprotocol.io) server that lets Claude Code act as an autonomous QA engineer. It drives a real Chromium/Chrome browser with Playwright, saves a screenshot for every step, and compiles a visual Markdown report. No cloud services involved.

```
evidence/
└── login-example-2026-10-14T15-29-00-018Z/
    ├── step-1.png
    ├── step-2.png
    └── README.md      <- step table, PASS/FAIL badges, embedded screenshots
```

## Requirements

- Node.js 20+ (Bun also works for dev)
- Claude Code (`claude` CLI)
- Linux/macOS/Windows with Chromium or Google Chrome

## Install

```bash
git clone <your-repo-url> qa-agent   # or just cd into the folder
cd qa-agent
npm install
npm run build
npx playwright install chromium
```

> **Unsupported distro (e.g. Arch/CachyOS)?** Playwright's bundled Chromium may crash with `Target crashed`.
> The server automatically falls back to your system Google Chrome. You can also force it with `QA_BROWSER_CHANNEL=chrome`.

## Register with Claude Code

Run from the project folder (registers it for every project):

```bash
claude mcp add qa-agent -s user \
  -e QA_EVIDENCE_DIR="$PWD/evidence" \
  -- node "$PWD/dist/server.js"
```

Then restart Claude Code (or run `/mcp`) and check it:

```bash
claude mcp list        # qa-agent ... ✔ Connected
```

Prefer editing config by hand? Use `claude_desktop_config.json` in this repo as a template, and change the paths to your own.

## Basic auth + login pages (dev/staging sites)

Sites behind HTTP Basic Auth (the browser popup) are handled at session start. Keep secrets in env vars, not in chat or specs:

```bash
claude mcp add qa-agent -s user \
  -e QA_EVIDENCE_DIR="$PWD/evidence" \
  -e QA_BASIC_AUTH_USER=devuser -e QA_BASIC_AUTH_PASS=devpass \
  -e QA_APP_USER=tester@example.com -e QA_APP_PASS=app-password \
  -- node "$PWD/dist/server.js"
```

- `qa_start_session` uses `QA_BASIC_AUTH_USER` / `QA_BASIC_AUTH_PASS` automatically, or accepts `basic_auth_username` / `basic_auth_password` (which may be `{{env:NAME}}`).
- For the app's own login form, use `{{env:NAME}}` placeholders in `qa_action` values, e.g. `fill #password` with `{{env:QA_APP_PASS}}`. The report records only "Filled #password", never the value.
- Screenshots still show non-masked fields, so use a dedicated test account and keep `evidence/` out of git.

## Usage

Ask Claude in plain language:

> Run the spec in `specs/login-example.md` using the qa-agent tools.

Or drive it ad hoc:

> Start a QA session called "homepage smoke", open https://example.com, assert the text "This domain" is visible, then finish and show me the report.

## Tools

| Tool | Purpose |
|------|---------|
| `qa_start_session(test_name)` | Creates `evidence/<name>-<timestamp>/`, launches the browser, resets the step counter |
| `qa_navigate(url, step_description)` | Goes to a URL (waits for `domcontentloaded`), screenshots it |
| `qa_action(action, selector, value?, step_description)` | `click`, `fill`, or `press` on a selector, then screenshots |
| `qa_inspect_dom()` | Returns the accessibility tree plus interactive elements, for fixing broken selectors |
| `qa_assert(type, expected, step_description)` | `text_present`, `url_matches` (substring or `/regex/`), or `element_visible` |
| `qa_finish_session(summary_notes?)` | Closes the browser, writes `README.md`, returns the report path |

A failed action or assertion is recorded as a FAIL step with a screenshot, and the tool returns an error with a hint to call `qa_inspect_dom` and retry with a better selector.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `QA_EVIDENCE_DIR` | `./evidence` (server's cwd) | Where run folders are written |
| `QA_BROWSER_CHANNEL` | auto (bundled, then `chrome`) | Force a browser channel, e.g. `chrome` |

The browser is launched headless with `--disable-gpu --no-sandbox --disable-dev-shm-usage --js-flags=--max-old-space-size=128`.

## Development

```bash
npm run dev          # run src/server.ts with Bun
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
```

## Troubleshooting

- **`CONNECTION_CLOSED`**: check `claude mcp list` for a duplicate `qa-agent` entry (project/local scope) pointing at a path that doesn't exist, and remove it with `claude mcp remove qa-agent -s local`.
- **Tools don't appear**: servers added mid-session only show up after restarting Claude Code or running `/mcp`.
- **`browserContext.newPage: Target crashed`**: set `QA_BROWSER_CHANNEL=chrome` and make sure Google Chrome is installed.
- **Page load timeouts**: some sites hang in headless browsers; test against another URL to rule out the site.
- **Server logs**: stdout is reserved for the MCP protocol; logs go to stderr.
