#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { existsSync } from "node:fs";
import { writeReport } from "./reporter.js";
import {
  QASession,
  getSession,
  requireSession,
  setSession,
  ASSERT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  STATE_DIR,
  listStates,
  statePath,
  type ApiRecord,
  type StepResult,
} from "./state.js";

// NOTE: stdout is reserved for the MCP protocol. Log only to stderr.
const EVIDENCE_ROOT = process.env.QA_EVIDENCE_DIR ?? path.resolve(process.cwd(), "evidence");

const server = new McpServer({ name: "qa-agent", version: "1.0.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Resolves placeholders so secrets and generated data never need to appear in chat or specs:
 *   {{env:NAME}}   environment variable (value is masked in reports)
 *   {{var:NAME}}   value saved by an earlier qa_request `save`
 *   {{rand}}       random token, stable for the whole session (unique emails, names, ...)
 *   {{timestamp}}  session start time in ms, stable for the whole session
 */
function resolve(value: string, s?: QASession): string {
  return value.replace(/\{\{\s*(env:[A-Za-z0-9_]+|var:[A-Za-z0-9_.-]+|rand|timestamp)\s*\}\}/g, (_, key: string) => {
    if (key === "rand" || key === "timestamp") {
      if (!s) throw new Error(`{{${key}}} needs an active session.`);
      return key === "rand" ? s.runId : String(s.startedAt.getTime());
    }
    const name = key.slice(key.indexOf(":") + 1);
    if (key.startsWith("env:")) {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Environment variable ${name} is not set.`);
      s?.secrets.add(v);
      return v;
    }
    const v = s?.vars.get(name);
    if (v === undefined) throw new Error(`Variable "${name}" is not set. Save it first with qa_request \`save\`.`);
    return v;
  });
}

/** Resolves placeholders inside every string of a JSON-like value. */
function deepResolve(x: unknown, s: QASession): unknown {
  if (typeof x === "string") return resolve(x, s);
  if (Array.isArray(x)) return x.map((i) => deepResolve(i, s));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, deepResolve(val, s)]));
  return x;
}

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|cookie|session/i;

function redactHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "***" : v]));
}

function redactJson(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(redactJson);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x).map(([k, val]) => [k, SENSITIVE_KEY.test(k) ? "***" : redactJson(val)]),
    );
  return x;
}

/** Registers the values of sensitive keys/headers as secrets so servers that echo them back can't leak them. */
function collectSecrets(x: unknown, s: QASession): void {
  if (Array.isArray(x)) return x.forEach((i) => collectSecrets(i, s));
  if (x && typeof x === "object") {
    for (const [k, val] of Object.entries(x)) {
      if (SENSITIVE_KEY.test(k) && typeof val === "string") s.secrets.add(val);
      else collectSecrets(val, s);
    }
  }
}

/** Pretty-prints JSON bodies (redacting sensitive keys), passes other text through. */
function prepareBody(raw: string, s: QASession, max: number): { text: string; truncated: boolean } {
  let out = raw;
  try {
    out = JSON.stringify(redactJson(JSON.parse(raw)), null, 2);
  } catch {}
  out = s.mask(out);
  return out.length > max ? { text: out.slice(0, max) + "\n… (truncated)", truncated: true } : { text: out, truncated: false };
}

function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((cur, key) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined), obj);
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

const fromError = (err: unknown): ToolResult =>
  text(err instanceof Error ? err.message : String(err), true);

function stepResponse(r: StepResult, dir: string): ToolResult {
  const payload = {
    step: r.step,
    status: r.status,
    durationMs: r.durationMs,
    url: r.url,
    screenshot: r.screenshot ? path.join(dir, r.screenshot) : null,
    detail: r.detail,
    error: r.error,
    new_tab: r.newTab ? `${r.newTab} (now the current tab; use qa_tab to switch back)` : undefined,
    dialogs: r.dialogs?.length ? r.dialogs : undefined,
    browser_issues: r.issues.length ? r.issues.slice(0, 10) : undefined,
    diagnostics: r.diagnostics
      ? { console: path.join(dir, r.diagnostics.console), aria: path.join(dir, r.diagnostics.aria) }
      : undefined,
    api: r.api
      ? {
          method: r.api.method,
          url: r.api.url,
          status: r.api.status,
          response_body: r.api.responseBody,
          saved_variables: r.api.saved.length ? r.api.saved : undefined,
        }
      : undefined,
    hint: r.dialogs?.some((d) => d.endsWith("-> dismissed"))
      ? "A dialog was dismissed (the default). Call qa_dialog action=accept BEFORE the triggering action to accept it."
      : r.status === "fail" && !r.api
        ? "Call qa_inspect_dom to find a working selector, then retry."
        : undefined,
  };
  return text(JSON.stringify(payload, null, 2), r.status === "fail");
}

server.registerTool(
  "qa_start_session",
  {
    description:
      "Start a QA run: creates ./evidence/<test-name>-<timestamp>/, launches Chromium, resets the step counter. Any previous unfinished session is closed.",
    inputSchema: {
      test_name: z.string().min(1).describe("Human-readable test name"),
      basic_auth_username: z
        .string()
        .optional()
        .describe("HTTP Basic Auth username (supports {{env:NAME}}). Falls back to QA_BASIC_AUTH_USER."),
      basic_auth_password: z
        .string()
        .optional()
        .describe("HTTP Basic Auth password (supports {{env:NAME}}). Falls back to QA_BASIC_AUTH_PASS."),
      load_state: z
        .string()
        .optional()
        .describe("Start already logged in by loading a state saved earlier with qa_save_state (see qa_list_states)."),
    },
  },
  async ({ test_name, basic_auth_username, basic_auth_password, load_state }) => {
    try {
      const user = basic_auth_username ? resolve(basic_auth_username) : process.env.QA_BASIC_AUTH_USER;
      const pass = basic_auth_password ? resolve(basic_auth_password) : process.env.QA_BASIC_AUTH_PASS;
      const creds = user && pass ? { username: user, password: pass } : undefined;
      let storageStatePath: string | undefined;
      if (load_state) {
        storageStatePath = statePath(load_state);
        if (!existsSync(storageStatePath)) {
          const known = (await listStates()).map((x) => x.name);
          throw new Error(
            `Saved state "${load_state}" not found. ${known.length ? `Available: ${known.join(", ")}.` : "No states saved yet."} ` +
              `Log in once, then call qa_save_state.`,
          );
        }
      }
      // Validate everything first so a bad argument doesn't kill the running session.
      const previous = getSession();
      if (previous) {
        await previous.close();
        setSession(null);
      }
      const session = await QASession.start(test_name, EVIDENCE_ROOT, {
        httpCredentials: creds,
        storageStatePath,
        loadedState: load_state,
      });
      if (creds) {
        session.secrets.add(creds.username);
        session.secrets.add(creds.password);
      }
      setSession(session);
      return text(
        JSON.stringify({ status: "started", test_name, evidence_dir: session.dir, basic_auth: Boolean(creds), loaded_state: load_state ?? null }, null, 2),
      );
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_save_state",
  {
    description:
      "Save the browser's login state (cookies, localStorage, IndexedDB) under a name so later sessions can skip logging in via qa_start_session `load_state`. " +
      `Stored outside the evidence folder in ${STATE_DIR} (file mode 600) because it holds live session cookies. Call it after a successful login.`,
    inputSchema: {
      name: z.string().min(1).describe("e.g. 'dev-admin'. Letters, numbers, _ - . only. Overwrites an existing state with the same name."),
      step_description: z.string().optional(),
    },
  },
  async ({ name, step_description }) => {
    try {
      const file = statePath(name);
      const s = requireSession();
      const r = await s.runStep(
        "save_state",
        step_description ?? `Save login state "${name}"`,
        async () => {
          const { cookies, origins } = await s.saveState(file);
          return `Saved state "${name}" (${cookies} cookies, ${origins} origins with storage). Load it with qa_start_session load_state "${name}".`;
        },
        { evidence: false },
      );
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_list_states",
  {
    description:
      "List saved login states with age, cookie count and the domains/origins they cover, so you can check one is still fresh before loading it. Does not need a session.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(JSON.stringify({ state_dir: STATE_DIR, states: await listStates() }, null, 2));
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_dialog",
  {
    description:
      "Decide how JavaScript dialogs (alert, confirm, prompt, beforeunload) are answered. Call it BEFORE the action that opens the dialog. " +
      "Without it, dialogs are dismissed (confirm returns false). By default the choice applies to the next dialog only; set persist=true to keep it. " +
      "Every dialog is recorded in the step result and report; verify one with qa_assert type=dialog_shown.",
    inputSchema: {
      action: z.enum(["accept", "dismiss"]),
      prompt_text: z.string().optional().describe("Text to type into a prompt() dialog when accepting. Supports placeholders."),
      persist: z.boolean().default(false).describe("false = next dialog only; true = until changed"),
      step_description: z.string().optional(),
    },
  },
  async ({ action, prompt_text, persist, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep(
        "dialog_policy",
        step_description ?? `${action === "accept" ? "Accept" : "Dismiss"} ${persist ? "all" : "the next"} dialog${persist ? "s" : ""}`,
        async () => {
          s.setDialogPolicy({ action, promptText: prompt_text === undefined ? undefined : resolve(prompt_text, s), persist });
          return `Dialogs will be ${action === "accept" ? "accepted" : "dismissed"} (${persist ? "until changed" : "next dialog only"})`;
        },
        { evidence: false },
      );
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_tab",
  {
    description:
      "Manage browser tabs. All tools act on the current tab. A step that opens a new tab (target=_blank link, window.open) switches to it automatically and says so in its result. " +
      "Actions: list (no step; shows index, url, title, current), new (optional url), switch (index), close (index, default current; the last tab can't be closed). " +
      "Indexes are 1-based positions in the list and shift when tabs close.",
    inputSchema: {
      action: z.enum(["list", "new", "switch", "close"]),
      index: z.number().int().min(1).optional(),
      url: z.string().optional().describe("For action=new. Supports placeholders."),
      step_description: z.string().optional(),
    },
  },
  async ({ action, index, url, step_description }) => {
    try {
      const s = requireSession();
      if (action === "list") {
        const current = s.currentTabIndex;
        const tabs = await Promise.all(
          s.tabs.map(async (t, i) => ({
            index: i + 1,
            current: i + 1 === current,
            url: t.url(),
            title: await t.title().catch(() => ""),
          })),
        );
        return text(JSON.stringify({ tabs }, null, 2));
      }
      const label = { new: "Open new tab", switch: `Switch to tab #${index}`, close: `Close tab #${index ?? "current"}` }[action];
      const r = await s.runStep(
        `tab_${action}`,
        step_description ?? label,
        async () => {
          if (action === "new") {
            const target = url ? new URL(resolve(url, s)).toString() : undefined;
            const t = await s.openTab(target);
            return `Opened tab #${s.tabs.indexOf(t) + 1}${target ? ` at ${target}` : ""}`;
          }
          if (action === "switch") {
            if (index === undefined) throw new Error('"index" is required for action "switch".');
            const t = s.switchTab(index);
            await t.bringToFront().catch(() => {});
            return `Switched to tab #${index}: ${t.url()}`;
          }
          await s.closeTab(index);
          return `Closed tab. Current tab is now #${s.currentTabIndex}: ${s.page.url()}`;
        },
      );
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_navigate",
  {
    description:
      "Navigate to a URL (waits for domcontentloaded) and capture a step screenshot. Supports {{var:NAME}} / {{rand}} placeholders.",
    inputSchema: {
      url: z.string().min(1),
      step_description: z.string().min(1),
    },
  },
  async ({ url, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep("navigate", step_description, async () => {
        const target = new URL(resolve(url, s)).toString();
        const resp = await s.page.goto(target, { waitUntil: "domcontentloaded" });
        return `Navigated to ${target} (HTTP ${resp?.status() ?? "n/a"}), title: "${await s.page.title()}"`;
      });
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_action",
  {
    description:
      "Perform a DOM action on a selector and capture a post-action screenshot. " +
      "Actions: click, dblclick, hover, scroll (into view), check, uncheck (no value); " +
      "fill (value = text), press (value = key e.g. 'Enter'), select (value = option value or label), upload (value = local file path). " +
      "`value` supports {{env:NAME}} placeholders.",
    inputSchema: {
      action: z.enum(["click", "dblclick", "hover", "scroll", "check", "uncheck", "fill", "press", "select", "upload"]),
      selector: z.string().min(1).describe("Playwright selector (CSS, text=, role=, etc.)"),
      value: z.string().optional(),
      step_description: z.string().min(1),
    },
  },
  async ({ action, selector, value, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep(action, step_description, async () => {
        const loc = s.page.locator(resolve(selector, s)).first();
        switch (action) {
          case "click":
            await loc.click();
            return `Clicked ${selector}`;
          case "dblclick":
            await loc.dblclick();
            return `Double-clicked ${selector}`;
          case "hover":
            await loc.hover();
            return `Hovered ${selector}`;
          case "scroll":
            await loc.scrollIntoViewIfNeeded();
            return `Scrolled ${selector} into view`;
          case "check":
            await loc.check();
            return `Checked ${selector}`;
          case "uncheck":
            await loc.uncheck();
            return `Unchecked ${selector}`;
        }
        if (value === undefined) throw new Error(`"value" is required for action "${action}".`);
        const resolved = resolve(value, s);
        switch (action) {
          case "fill":
            await loc.fill(resolved);
            return `Filled ${selector}`;
          case "press":
            await loc.press(resolved);
            return `Pressed "${value}" on ${selector}`;
          case "select": {
            // Match by option value first, then fall back to the visible label.
            const picked = await loc
              .selectOption({ value: resolved }, { timeout: 2_000 })
              .catch(() => loc.selectOption({ label: resolved }));
            return `Selected ${JSON.stringify(picked)} in ${selector}`;
          }
          case "upload":
            await loc.setInputFiles(resolved);
            return `Uploaded ${resolved} to ${selector}`;
        }
      }, { watchPopups: action === "click" || action === "dblclick" || action === "press" });
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_extract",
  {
    description:
      "Read a value from the page and save it as a variable for later {{var:NAME}} use (e.g. an ID shown after creating a record). " +
      "source: text (visible text), value (input value), attribute (needs `attribute`), count (number of matching elements), url, title. " +
      "Optional `regex` keeps capture group 1 (or the whole match) of the extracted text. Captures a step screenshot.",
    inputSchema: {
      source: z.enum(["text", "value", "attribute", "count", "url", "title"]),
      selector: z.string().optional().describe("Required for text, value, attribute and count"),
      attribute: z.string().optional().describe("Attribute name when source = attribute, e.g. href, data-id"),
      regex: z.string().optional().describe("e.g. 'Order #(\\d+)' to pull a number out of a sentence"),
      save_as: z.string().regex(/^[A-Za-z0-9_.-]+$/).describe("Variable name, used later as {{var:NAME}}"),
      step_description: z.string().min(1),
    },
  },
  async ({ source, selector, attribute, regex, save_as, step_description }) => {
    try {
      const s = requireSession();
      let shown = "";
      const r = await s.runStep("extract", step_description, async () => {
        let value: string;
        if (source === "url") value = s.page.url();
        else if (source === "title") value = await s.page.title();
        else {
          if (!selector) throw new Error(`"selector" is required for source "${source}".`);
          const loc = s.page.locator(resolve(selector, s));
          if (source === "count") value = String(await loc.count());
          else {
            const first = loc.first();
            if (source === "text") value = (await first.innerText()).trim();
            else if (source === "value") value = await first.inputValue();
            else {
              if (!attribute) throw new Error('"attribute" is required for source "attribute".');
              const a = await first.getAttribute(attribute);
              if (a === null) throw new Error(`Attribute "${attribute}" not found on ${selector}`);
              value = a;
            }
          }
        }
        if (regex) {
          const m = value.match(new RegExp(regex));
          if (!m) throw new Error(`Regex /${regex}/ did not match extracted value "${s.mask(value.slice(0, 200))}"`);
          value = m[1] ?? m[0];
        }
        s.vars.set(save_as, value);
        if (SENSITIVE_KEY.test(save_as)) s.secrets.add(value);
        shown = s.mask(value.length > 300 ? value.slice(0, 300) + "…" : value);
        return `Extracted ${source}${selector ? ` of ${selector}` : ""} -> {{var:${save_as}}} = ${JSON.stringify(shown)}`;
      });
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_request",
  {
    description:
      "Make an HTTP API call that shares the browser session's cookies and Basic Auth. Use it to create/clean up test data or to test an API directly. " +
      "Placeholders {{env:NAME}}, {{var:NAME}}, {{rand}}, {{timestamp}} work in url, headers and body. " +
      "`save` stores response fields (dot paths, e.g. data.id) as variables for later {{var:NAME}}. " +
      "Passes when the status is 2xx unless expect_status is given. Sensitive headers/JSON keys are redacted in output and the report. " +
      "`report_detail` and `report_note` control how this call appears in README.md.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
      url: z.string().min(1).describe("Absolute URL, or a path resolved against the current page's origin"),
      headers: z.record(z.string()).optional(),
      body: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional().describe("JSON object/array (sent as JSON) or raw string"),
      expect_status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
      expect_body_contains: z.string().optional(),
      expect_json: z.record(z.any()).optional().describe("Map of dot-path -> expected value in the JSON response"),
      save: z.record(z.string()).optional().describe("Map of variable name -> dot-path in the JSON response"),
      step_description: z.string().min(1),
      report_detail: z.enum(["summary", "full"]).default("full").describe("summary = method/URL/status only; full = also headers and bodies"),
      max_body_chars: z.number().int().min(0).max(100000).default(2000).describe("Max body characters kept in output/report"),
      report_note: z.string().optional().describe("Free-text note shown under this call in the report"),
    },
  },
  async (a) => {
    try {
      const s = requireSession();
      let api: ApiRecord | undefined;
      const r = await s.runStep(
        "api",
        a.step_description,
        async () => {
          const rawUrl = resolve(a.url, s);
          const base = /^https?:/.test(s.page.url()) ? s.page.url() : undefined;
          const url = new URL(rawUrl, base).toString();
          const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, val]) => [k, resolve(val, s)]));
          const body = a.body === undefined ? undefined : deepResolve(a.body, s);

          collectSecrets(body, s);
          for (const [k, val] of Object.entries(headers)) {
            if (SENSITIVE_KEY.test(k)) {
              s.secrets.add(val);
              s.secrets.add(val.replace(/^(Bearer|Basic|Token)\s+/i, ""));
            }
          }

          const t0 = performance.now();
          const resp = await s.request.fetch(url, {
            method: a.method,
            headers,
            data: body as string | object | undefined,
            timeout: REQUEST_TIMEOUT_MS,
            failOnStatusCode: false,
          });
          const durationMs = Math.round(performance.now() - t0);
          const rawBody = a.method === "HEAD" ? "" : await resp.text();
          let json: unknown;
          try {
            json = JSON.parse(rawBody);
          } catch {}

          collectSecrets(json, s);
          const saved: string[] = [];
          const problems: string[] = [];
          for (const [name, p] of Object.entries(a.save ?? {})) {
            const val = getPath(json, p);
            if (val === undefined) {
              problems.push(`save: "${p}" not found in response`);
              continue;
            }
            const str = typeof val === "string" ? val : JSON.stringify(val);
            s.vars.set(name, str);
            if (SENSITIVE_KEY.test(name) || SENSITIVE_KEY.test(p)) s.secrets.add(str);
            saved.push(name);
          }

          const reqBodyText = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
          const reqPrepared = reqBodyText === undefined ? undefined : prepareBody(reqBodyText, s, a.max_body_chars);
          const resPrepared = prepareBody(rawBody, s, a.max_body_chars);
          api = {
            method: a.method,
            url,
            status: resp.status(),
            statusText: resp.statusText(),
            durationMs,
            requestHeaders: redactHeaders(headers),
            requestBody: reqPrepared?.text,
            responseHeaders: redactHeaders(resp.headers()),
            responseBody: resPrepared.text || undefined,
            truncated: Boolean(reqPrepared?.truncated || resPrepared.truncated),
            reportDetail: a.report_detail,
            note: a.report_note,
            saved,
          };

          const allowed = a.expect_status === undefined ? undefined : [a.expect_status].flat();
          if (allowed ? !allowed.includes(resp.status()) : resp.status() < 200 || resp.status() >= 300) {
            problems.push(`Expected status ${allowed ? allowed.join("/") : "2xx"}, got ${resp.status()}`);
          }
          if (a.expect_body_contains !== undefined) {
            const needle = resolve(a.expect_body_contains, s);
            if (!rawBody.includes(needle)) problems.push(`Response body does not contain "${s.mask(needle)}"`);
          }
          for (const [p, want] of Object.entries(a.expect_json ?? {})) {
            const wantResolved = deepResolve(want, s);
            const got = getPath(json, p);
            if (JSON.stringify(got) !== JSON.stringify(wantResolved)) {
              problems.push(`JSON ${p}: expected ${s.mask(JSON.stringify(wantResolved))}, got ${s.mask(JSON.stringify(got))}`);
            }
          }
          if (problems.length) throw new Error(problems.join("\n"));
          return `${a.method} ${url} -> ${resp.status()}`;
        },
        { evidence: false },
      );
      if (api) {
        r.api = api;
        r.url = api.url;
      }
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_inspect_dom",
  {
    description:
      "Return the page's accessibility tree (ARIA snapshot) and a list of interactive elements with suggested selectors. Use it to self-heal failed selectors. Does not create a step.",
    inputSchema: {},
  },
  async () => {
    try {
      const s = requireSession();
      const aria = await s.page.locator("body").ariaSnapshot().catch((e) => `unavailable: ${e}`);
      const elements = await s.page.evaluate(() => {
        const sel =
          "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],[onclick]";
        const cssPath = (el: Element): string => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const testId = el.getAttribute("data-testid");
          if (testId) return `[data-testid="${testId}"]`;
          const name = el.getAttribute("name");
          if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
          return el.tagName.toLowerCase();
        };
        return Array.from(document.querySelectorAll(sel))
          .slice(0, 150)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible =
              r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            const h = el as HTMLElement;
            return {
              tag: el.tagName.toLowerCase(),
              selector: cssPath(el),
              type: el.getAttribute("type") ?? undefined,
              role: el.getAttribute("role") ?? undefined,
              text: (h.innerText || (el as HTMLInputElement).value || "").trim().slice(0, 80) || undefined,
              ariaLabel: el.getAttribute("aria-label") ?? undefined,
              placeholder: el.getAttribute("placeholder") ?? undefined,
              href: el.getAttribute("href") ?? undefined,
              disabled: (el as HTMLButtonElement).disabled || undefined,
              visible,
            };
          });
      });
      return text(
        JSON.stringify({ url: s.page.url(), title: await s.page.title(), aria_snapshot: aria, interactive_elements: elements }, null, 2),
      );
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_assert",
  {
    description:
      "Validate an assertion (text_present | url_matches | element_visible | dialog_shown; dialog_shown checks a JS alert/confirm/prompt whose message contains `expected` appeared since the last check) and capture a screenshot. url_matches accepts a substring, or a regex written as /pattern/. A failed assertion is recorded as a failed step.",
    inputSchema: {
      type: z.enum(["text_present", "url_matches", "element_visible", "dialog_shown"]),
      expected: z.string().min(1),
      step_description: z.string().min(1),
    },
  },
  async ({ type, expected: expectedRaw, step_description }) => {
    let expected = expectedRaw;
    try {
      const s = requireSession();
      const r = await s.runStep(`assert:${type}`, step_description, async () => {
        expected = resolve(expected, s);
        if (type === "text_present") {
          await s.page.getByText(expected).filter({ visible: true }).first().waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS }).catch(() => {
            throw new Error(`Text not found on page: "${expected}"`);
          });
          return `Text present: "${expected}"`;
        }
        if (type === "url_matches") {
          const url = s.page.url();
          const m = expected.match(/^\/(.+)\/([gimsuy]*)$/);
          const ok = m ? new RegExp(m[1], m[2]).test(url) : url.includes(expected);
          if (!ok) throw new Error(`URL "${url}" does not match "${expected}"`);
          return `URL matches "${expected}"`;
        }
        if (type === "dialog_shown") {
          const deadline = Date.now() + ASSERT_TIMEOUT_MS;
          for (;;) {
            const d = s.consumeDialog(expected);
            if (d) return `Dialog shown: ${d.type} "${d.message}" (${d.outcome})`;
            if (Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const seen = s.dialogs.filter((x) => !x.consumed).map((x) => `${x.type} "${x.message}"`);
          throw new Error(`No dialog containing "${s.mask(expected)}" appeared. Unchecked dialogs: ${seen.length ? seen.join("; ") : "none"}`);
        }
        await s.page.locator(expected).first().waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS }).catch(() => {
          throw new Error(`Element not visible: ${expected}`);
        });
        return `Element visible: ${expected}`;
      });
      return stepResponse(r, s.dir);
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_finish_session",
  {
    description: "Close the browser, compile README.md (step table + screenshot gallery) in the evidence folder, and return its path.",
    inputSchema: { summary_notes: z.string().optional() },
  },
  async ({ summary_notes }) => {
    try {
      const s = requireSession();
      await s.close();
      setSession(null);
      const report = await writeReport(s, summary_notes);
      const failed = s.steps.filter((x) => x.status === "fail").length;
      return text(
        JSON.stringify(
          { result: failed === 0 && s.steps.length > 0 ? "PASS" : "FAIL", steps: s.steps.length, failed, report }, null, 2),
      );
    } catch (err) {
      return fromError(err);
    }
  },
);

async function shutdown(): Promise<void> {
  await getSession()?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(`[qa-agent] MCP server ready. Evidence root: ${EVIDENCE_ROOT}`);
