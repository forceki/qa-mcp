# qa-agent

A local-first [MCP](https://modelcontextprotocol.io) server that lets an AI coding agent (Claude Code, Codex, Gemini CLI, Cursor, VS Code Copilot, and any other MCP client) act as an autonomous QA engineer. It drives a real Chromium/Chrome browser with Playwright, saves a screenshot for every step, and compiles a visual Markdown report. No cloud services involved.

```
result/
└── login-example-2026-10-14T15-29-00-018Z/
    ├── step-1.png
    ├── step-2.png
    └── README.md      <- step table, PASS/FAIL badges, embedded screenshots
```

## Requirements

- Node.js 20+ (Bun also works for dev)
- An MCP-capable agent: Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, Claude Desktop, etc.
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
  -e QA_RESULT_DIR="$PWD/result" \
  -- node "$PWD/dist/server.js"
```

Then restart Claude Code (or run `/mcp`) and check it:

```bash
claude mcp list        # qa-agent ... ✔ Connected
```

Prefer editing config by hand? Use `claude_desktop_config.json` in this repo as a template, and change the paths to your own.

## Use with other agents

The server is a plain stdio MCP server, so any MCP client can use it. Build first (`npm run build`), then register `node /absolute/path/to/qa-agent/dist/server.js` with `QA_RESULT_DIR` set. Restart the client afterwards.

**Codex CLI**

```bash
codex mcp add qa-agent \
  --env QA_RESULT_DIR="$PWD/result" \
  -- node "$PWD/dist/server.js"
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.qa-agent]
command = "node"
args = ["/absolute/path/to/qa-agent/dist/server.js"]
env = { QA_RESULT_DIR = "/absolute/path/to/qa-agent/result" }
```

**Gemini CLI**

```bash
gemini mcp add qa-agent node "$PWD/dist/server.js" -e QA_RESULT_DIR="$PWD/result"
```

Or in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "qa-agent": {
      "command": "node",
      "args": ["/absolute/path/to/qa-agent/dist/server.js"],
      "env": { "QA_RESULT_DIR": "/absolute/path/to/qa-agent/result" }
    }
  }
}
```

**Cursor / Claude Desktop / Windsurf**: use the same JSON block under `mcpServers` in `.cursor/mcp.json`, `claude_desktop_config.json` or the Windsurf MCP config.

**VS Code (Copilot)**: put it in `.vscode/mcp.json` under `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "qa-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/qa-agent/dist/server.js"],
      "env": { "QA_RESULT_DIR": "/absolute/path/to/qa-agent/result" }
    }
  }
}
```

The `qa_*` tools work the same in every client. The `skills/` folder is a Claude Code feature. In other agents, paste or reference the `SKILL.md` files from `AGENTS.md` (Codex, Cursor) or `GEMINI.md` (Gemini CLI) to get the same analyze, test-cases, run, explore and report workflow. Only Claude Code has been tested so far.

## Basic auth + login pages (dev/staging sites)

Sites behind HTTP Basic Auth (the browser popup) are handled at session start. Keep secrets in env vars, not in chat or specs:

```bash
claude mcp add qa-agent -s user \
  -e QA_RESULT_DIR="$PWD/result" \
  -e QA_BASIC_AUTH_USER=devuser -e QA_BASIC_AUTH_PASS=devpass \
  -e QA_APP_USER=tester@example.com -e QA_APP_PASS=app-password \
  -- node "$PWD/dist/server.js"
```

- `qa_start_session` uses `QA_BASIC_AUTH_USER` / `QA_BASIC_AUTH_PASS` automatically, or accepts `basic_auth_username` / `basic_auth_password` (which may be `{{env:NAME}}`).
- For the app's own login form, use `{{env:NAME}}` placeholders in `qa_action` values, e.g. `fill #password` with `{{env:QA_APP_PASS}}`. The report records only "Filled #password", never the value.
- Screenshots still show non-masked fields, so use a dedicated test account and keep `result/` out of git.

## Snapshot refs (no selector guessing)

`qa_snapshot` returns the current tab as an accessibility tree and puts a ref on every element:

```
- textbox "Your name" [ref=e3]
- combobox [ref=e4]
- checkbox "I agree" [ref=e6]
- button "Go" [ref=e7]
- iframe [ref=e9]:
  - button "In frame" [ref=f1e2]
```

Use the ref anywhere a selector is accepted (`qa_action`, `qa_extract`, `qa_assert element_visible`), written as `ref=e7`:

```
qa_snapshot                                  -> sees: button "Go" [ref=e7]
qa_action click selector "ref=e7"
```

Rules:
- Refs belong to the **latest snapshot of the current tab**. After the page changes or you switch tabs, take a new snapshot. A failed ref action says so in its error.
- Elements inside iframes get refs like `f1e2` and work the same way.
- Failed steps write `step-N-aria.yml` with refs too, so Claude can recover from a failure without a separate call.
- Use `depth` to shrink the output on big pages and `max_chars` to cap it. Secrets are masked.
- Prefer CSS/role selectors in saved specs, since refs change between runs. Refs are for exploring and one-off flows.

## Tabs and dialogs

**Tabs.** All tools act on the *current* tab. When a step opens a new tab (a `target="_blank"` link or `window.open`), the session switches to it automatically and says so in the step result and report (`New tab: #2 https://...`). Use `qa_tab` to move around:

| Action | Effect |
|--------|--------|
| `list` | Shows each tab's index, URL, title and which one is current (not a report step) |
| `new` | Opens a tab, optionally at a `url`, and makes it current |
| `switch` | Makes tab `index` current |
| `close` | Closes tab `index` (default: current); the last tab can't be closed |

Indexes are 1-based positions in the list and shift when a tab closes. If a tab closes itself (`window.close()`), the session falls back to the previous tab.

**Dialogs.** Browsers block the page while an `alert`, `confirm` or `prompt` is open, so the answer must be decided *before* the action that triggers it:

```
1. qa_dialog action=accept                       # next dialog only
2. qa_action click "#delete"                     # confirm("Delete item?") -> accepted
3. qa_assert dialog_shown "Delete item?"         # the message isn't in the DOM, so this is the way to check it
```

- With no `qa_dialog`, dialogs are **dismissed** (`confirm` returns false), the same as Playwright's default. The step result and report always list every dialog and how it was answered, and the step result adds a hint when one was dismissed.
- `persist: true` keeps the choice for all later dialogs; otherwise it reverts to dismiss after one.
- `prompt_text` fills a `prompt()`; it supports `{{var:...}}` / `{{rand}}` placeholders.

## Saved login (log in once, reuse everywhere)

Logging in through the UI on every run is slow and flaky. Do it once, save it, and start later sessions already logged in:

1. Run a session that logs in (UI steps, or `qa_request` to a login API), then call `qa_save_state` with a name such as `dev-admin`.
2. Start any later session with `qa_start_session` `load_state: "dev-admin"`. Cookies, localStorage and IndexedDB are restored, and API calls from `qa_request` use the same login.
3. `qa_list_states` shows what's saved, how old it is and which domains it covers. If the site has logged you out (expired session), log in again and re-save with the same name.

Example prompt: "Log in to https://dev.example.com as the test user and save the login as dev-admin", then later "using the dev-admin login, open /orders and check the table has 5 rows".

Notes:
- **Basic Auth is not part of the state.** Pass it each time (or set `QA_BASIC_AUTH_USER` / `QA_BASIC_AUTH_PASS`).
- **A state file is a live session.** Anyone holding the file can act as that user. Files are written with mode 600 to `~/.qa-agent/states/`, outside any repo and outside the result folder, so they don't end up in reports or git. Use a dedicated test account and delete a state by removing its file.
- The report header shows `Login state: loaded <name>` so you can see a run didn't log in itself.

## API testing and multi-step flows

`qa_request` calls your API from the same session as the browser (same cookies, same Basic Auth), so a flow can mix API and UI steps: create data over the API, verify it in the UI, then clean up.

```
1. qa_request POST /api/customers  body {"email":"qa-{{rand}}@test.com"}  save {customer_id: "data.id"}
2. qa_navigate /customers/{{var:customer_id}}  ->  qa_assert text_present "qa-{{rand}}@test.com"
3. qa_request DELETE /api/customers/{{var:customer_id}}  expect_status 204
```

`qa_extract` does the same for values shown on the page, for example an order number after submitting a form: `source: text`, `selector: .toast`, `regex: Order #(\d+)`, `save_as: order_id`.

Placeholders work in `qa_request` url/headers/body, `qa_navigate` url, `qa_action` selector/value and `qa_assert` expected:

| Placeholder | Value |
|-------------|-------|
| `{{env:NAME}}` | Environment variable (masked in reports) |
| `{{var:NAME}}` | Field saved by an earlier `qa_request` `save` |
| `{{rand}}` | Random token, the same for the whole session (unique emails/names) |
| `{{timestamp}}` | Session start time in ms |

A call passes on a 2xx status unless `expect_status` is set (a number or list). You can also check `expect_body_contains` and `expect_json` (dot-path to expected value). `save` maps variable names to dot-paths, for example `{ "id": "data.items.0.id" }`.

### Customising what the report shows

The report follows what you ask for in the prompt. Claude maps your wording to these per-call options:

| Option | Effect |
|--------|--------|
| `report_detail: "summary"` | Only method, URL, status and duration |
| `report_detail: "full"` (default) | Also request/response headers and bodies |
| `max_body_chars` | How much of each body to keep (default 2000) |
| `report_note` | A sentence shown under the call, for example the purpose or the ticket |
| `step_description` | The step title in the report |

Example prompts: "test the create-user API, show full request and response in the report", "just show status codes for the cleanup calls", "add a note that this covers ticket ABC-123".

### Secrets in API reports

`Authorization`, `Cookie`, `Set-Cookie`, API-key headers and JSON keys such as `password`, `token` and `secret` are shown as `***`. Their values are also masked if a server echoes them back in another field. Still, use a dedicated test account.

## QA skills (analysis, test cases, running, reporting)

Besides the MCP tools, `skills/` has five Claude Code skills that guide the whole QA loop: `qa-analyze`, `qa-test-cases`, `qa-run`, `qa-explore` and `qa-report`. See [skills/README.md](skills/README.md).

```bash
npm run install:skills      # links them into ~/.claude/skills, then restart Claude Code
```

Then ask in plain language: "analyze the checkout feature and write test cases", "run the P0 cases", "make a test report with bug drafts".

## Usage

Ask Claude in plain language:

> Run the spec in `specs/login-example.md` using the qa-agent tools.

Or drive it ad hoc:

> Start a QA session called "homepage smoke", open https://example.com, assert the text "This domain" is visible, then finish and show me the report.

## Tools

| Tool | Purpose |
|------|---------|
| `qa_start_session(test_name, load_state?, basic_auth_*?)` | Creates `result/<name>-<timestamp>/`, launches the browser, resets the step counter. `load_state` starts already logged in |
| `qa_navigate(url, step_description)` | Goes to a URL (waits for `domcontentloaded`), screenshots it |
| `qa_action(action, selector, value?, step_description)` | `click`, `dblclick`, `hover`, `scroll`, `check`, `uncheck`, `fill`, `press`, `select`, `upload` on a selector, then screenshots |
| `qa_tab(action, index?, url?)` | `list`, `new`, `switch`, `close` browser tabs. A step that opens a tab (target=_blank, window.open) switches to it automatically |
| `qa_dialog(action, prompt_text?, persist?)` | Choose how the next JS dialog (alert/confirm/prompt) is answered: `accept` or `dismiss` |
| `qa_save_state(name)` | Saves the current login (cookies, localStorage, IndexedDB) under a name for later sessions |
| `qa_list_states()` | Lists saved logins with age, cookie count and domains |
| `qa_extract(source, selector?, save_as, ...)` | Reads text, input value, attribute, element count, URL or title from the page (optionally through a regex) and saves it as `{{var:NAME}}` |
| `qa_request(method, url, headers?, body?, expect_*?, save?, ...)` | HTTP API call sharing the browser's cookies and Basic Auth; asserts status/body/JSON, saves response fields as variables, and is recorded in the report |
| `qa_snapshot(depth?, max_chars?)` | Accessibility tree with a ref like `[ref=e7]` on every element (iframes included). Use `ref=e7` as a selector, no CSS guessing |
| `qa_inspect_dom()` | Returns the accessibility tree plus interactive elements, for fixing broken selectors |
| `qa_assert(type, expected, step_description)` | `text_present`, `url_matches` (substring or `/regex/`), `element_visible`, or `dialog_shown` (a JS dialog containing the text appeared) |
| `qa_finish_session(summary_notes?)` | Closes the browser, writes `README.md`, returns the report path |

A failed action or assertion is recorded as a FAIL step. The tool returns an error with a hint to call `qa_inspect_dom` and retry with a better selector.

## Results captured

- `step-N.png` for every step (full-page when the step fails).
- Console errors/warnings, uncaught page errors, failed requests and HTTP 4xx/5xx seen during each step. They are returned by the tool and listed under "Browser issues" in the report, even when the step passed.
- For failed steps only: `step-N-console.txt` (recent browser console/network log) and `step-N-aria.yml` (accessibility tree), linked from the report.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `QA_RESULT_DIR` | `./result` (server's cwd) | Where run folders are written |
| `QA_BROWSER_CHANNEL` | auto (bundled, then `chrome`) | Force a browser channel, e.g. `chrome` |
| `QA_TIMEOUT_MS` | `10000` | Per-action timeout |
| `QA_NAV_TIMEOUT_MS` | `30000` | Navigation timeout |
| `QA_ASSERT_TIMEOUT_MS` | `5000` | How long assertions wait for text/elements |
| `QA_BASIC_AUTH_USER` / `QA_BASIC_AUTH_PASS` | unset | HTTP Basic Auth for every session |
| `QA_POPUP_WAIT_MS` | `300` | How long click-type actions wait for a new tab to be reported (0 disables) |
| `QA_STATE_DIR` | `~/.qa-agent/states` | Where saved login states are stored |

The browser is launched headless with `--disable-gpu --no-sandbox --disable-dev-shm-usage --js-flags=--max-old-space-size=128`.

## Development

```bash
npm run dev          # run src/server.ts with Bun
npm run typecheck    # type-check src/ and test/
npm test             # build, compile the TypeScript tests to dist-test/, run them against a local fixture site (no internet needed)
npm run build        # compile to dist/
```

## Troubleshooting

- **`CONNECTION_CLOSED`**: check `claude mcp list` for a duplicate `qa-agent` entry (project/local scope) pointing at a path that doesn't exist, and remove it with `claude mcp remove qa-agent -s local`.
- **Tools don't appear**: servers added mid-session only show up after restarting Claude Code or running `/mcp`.
- **`browserContext.newPage: Target crashed`**: set `QA_BROWSER_CHANNEL=chrome` and make sure Google Chrome is installed.
- **Page load timeouts**: some sites hang in headless browsers; test against another URL to rule out the site.
- **Server logs**: stdout is reserved for the MCP protocol; logs go to stderr.
