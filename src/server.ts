#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { writeReport } from "./reporter.js";
import {
  QASession,
  getSession,
  requireSession,
  setSession,
  type StepResult,
} from "./state.js";

// NOTE: stdout is reserved for the MCP protocol. Log only to stderr.
const EVIDENCE_ROOT = process.env.QA_EVIDENCE_DIR ?? path.resolve(process.cwd(), "evidence");

const server = new McpServer({ name: "qa-agent", version: "1.0.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Replaces {{env:NAME}} with process.env.NAME so secrets never need to appear in chat or specs. */
function resolveEnv(value: string): string {
  return value.replace(/\{\{env:([A-Za-z0-9_]+)\}\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return v;
  });
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
    hint: r.status === "fail" ? "Call qa_inspect_dom to find a working selector, then retry." : undefined,
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
    },
  },
  async ({ test_name, basic_auth_username, basic_auth_password }) => {
    try {
      const previous = getSession();
      if (previous) {
        await previous.close();
        setSession(null);
      }
      const user = basic_auth_username ? resolveEnv(basic_auth_username) : process.env.QA_BASIC_AUTH_USER;
      const pass = basic_auth_password ? resolveEnv(basic_auth_password) : process.env.QA_BASIC_AUTH_PASS;
      const creds = user && pass ? { username: user, password: pass } : undefined;
      const session = await QASession.start(test_name, EVIDENCE_ROOT, creds);
      setSession(session);
      return text(
        JSON.stringify({ status: "started", test_name, evidence_dir: session.dir, basic_auth: Boolean(creds) }, null, 2),
      );
    } catch (err) {
      return fromError(err);
    }
  },
);

server.registerTool(
  "qa_navigate",
  {
    description: "Navigate to a URL (waits for domcontentloaded) and capture a step screenshot.",
    inputSchema: {
      url: z.string().url(),
      step_description: z.string().min(1),
    },
  },
  async ({ url, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep("navigate", step_description, async () => {
        const resp = await s.page.goto(url, { waitUntil: "domcontentloaded" });
        return `Navigated to ${url} (HTTP ${resp?.status() ?? "n/a"}), title: "${await s.page.title()}"`;
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
      "Perform a DOM action (click | fill | press) on a selector and capture a post-action screenshot. `value` is required for fill (text) and press (key, e.g. 'Enter').",
    inputSchema: {
      action: z.enum(["click", "fill", "press"]),
      selector: z.string().min(1).describe("Playwright selector (CSS, text=, role=, etc.)"),
      value: z.string().optional(),
      step_description: z.string().min(1),
    },
  },
  async ({ action, selector, value, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep(action, step_description, async () => {
        const loc = s.page.locator(selector).first();
        if (action === "click") {
          await loc.click();
          return `Clicked ${selector}`;
        }
        if (value === undefined) throw new Error(`"value" is required for action "${action}".`);
        const resolved = resolveEnv(value);
        if (action === "fill") {
          await loc.fill(resolved);
          return `Filled ${selector}`;
        }
        await loc.press(resolved);
        return `Pressed "${value}" on ${selector}`;
      });
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
      "Validate an assertion (text_present | url_matches | element_visible) and capture a screenshot. url_matches accepts a substring, or a regex written as /pattern/. A failed assertion is recorded as a failed step.",
    inputSchema: {
      type: z.enum(["text_present", "url_matches", "element_visible"]),
      expected: z.string().min(1),
      step_description: z.string().min(1),
    },
  },
  async ({ type, expected, step_description }) => {
    try {
      const s = requireSession();
      const r = await s.runStep(`assert:${type}`, step_description, async () => {
        if (type === "text_present") {
          await s.page.getByText(expected).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {
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
        await s.page.locator(expected).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {
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
