import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type StepStatus = "pass" | "fail";

/** Details of an API call made with qa_request. Bodies/headers are already redacted and truncated. */
export interface ApiRecord {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  truncated: boolean;
  /** "summary" = method/url/status only in the report; "full" = headers and bodies too. */
  reportDetail: "summary" | "full";
  note?: string;
  saved: string[];
}

export interface StepResult {
  step: number;
  kind: string;
  description: string;
  status: StepStatus;
  durationMs: number;
  screenshot: string | null;
  url: string;
  startedAt: string;
  detail?: string;
  error?: string;
  /** Console errors/warnings, uncaught page errors, failed requests and HTTP >= 400 seen during this step. */
  issues: string[];
  /** Extra evidence files (relative to the run dir), only written for failed steps. */
  diagnostics?: { console: string; aria: string };
  api?: ApiRecord;
}

const MAX_EVENTS = 500;
export const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
export const REQUEST_TIMEOUT_MS = num(process.env.QA_NAV_TIMEOUT_MS, 30_000);
export const ASSERT_TIMEOUT_MS = num(process.env.QA_ASSERT_TIMEOUT_MS, 5_000);

export const BROWSER_ARGS = [
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--js-flags=--max-old-space-size=128",
];

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "test";
}

export class QASession {
  testName: string;
  dir: string;
  startedAt: Date;
  steps: StepResult[] = [];
  /** Values saved from API responses ({{var:NAME}}). */
  readonly vars = new Map<string, string>();
  /** Secret values resolved during the run; masked everywhere they could reach a report. */
  readonly secrets = new Set<string>();
  /** Stable per-session random token for {{rand}}. */
  readonly runId = randomBytes(4).toString("hex");
  private stepCounter = 0;
  private events: { issue: boolean; text: string }[] = [];
  private browser: Browser;
  private context: BrowserContext;
  readonly page: Page;

  private constructor(
    testName: string,
    dir: string,
    browser: Browser,
    context: BrowserContext,
    page: Page,
  ) {
    this.testName = testName;
    this.dir = dir;
    this.startedAt = new Date();
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.attachListeners(page);
  }

  private record(text: string, issue: boolean): void {
    this.events.push({ issue, text: `[${new Date().toISOString()}] ${text}` });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private attachListeners(page: Page): void {
    page.on("console", (m) => {
      const t = m.type();
      this.record(`console.${t}: ${m.text()}`, t === "error" || t === "warning");
    });
    page.on("pageerror", (e) => this.record(`pageerror: ${e.message}`, true));
    page.on("requestfailed", (r) =>
      this.record(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText ?? "unknown"})`, true),
    );
    page.on("response", (r) => {
      if (r.status() >= 400) this.record(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`, true);
    });
  }

  static async start(
    testName: string,
    evidenceRoot: string,
    httpCredentials?: { username: string; password: string },
  ): Promise<QASession> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.resolve(evidenceRoot, `${slugify(testName)}-${timestamp}`);
    await mkdir(dir, { recursive: true });

    const channel = process.env.QA_BROWSER_CHANNEL; // e.g. "chrome" to use system Chrome
    const attempts: (string | undefined)[] = channel ? [channel] : [undefined, "chrome"];
    let lastErr: unknown;
    for (const ch of attempts) {
      let browser: Browser | null = null;
      try {
        browser = await chromium.launch({ headless: true, args: BROWSER_ARGS, ...(ch ? { channel: ch } : {}) });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          ...(httpCredentials ? { httpCredentials } : {}),
        });
        const page = await context.newPage();
        page.setDefaultTimeout(num(process.env.QA_TIMEOUT_MS, 10_000));
        page.setDefaultNavigationTimeout(num(process.env.QA_NAV_TIMEOUT_MS, 30_000));
        return new QASession(testName, dir, browser, context, page);
      } catch (err) {
        lastErr = err;
        await browser?.close().catch(() => {});
        console.error(`[qa-agent] browser launch failed (${ch ?? "bundled chromium"}): ${err instanceof Error ? err.message : err}`);
      }
    }
    throw lastErr;
  }

  /** API client sharing cookies and Basic Auth credentials with the browser context. */
  get request() {
    return this.context.request;
  }

  mask(text: string): string {
    let out = text;
    for (const secret of this.secrets) if (secret.length >= 4) out = out.split(secret).join("***");
    return out;
  }

  get stepCount(): number {
    return this.stepCounter;
  }

  /**
   * Runs one test step: times it, always captures a screenshot (even on failure),
   * and records the result. Never throws; failures are returned as status "fail".
   */
  async runStep(
    kind: string,
    description: string,
    fn: () => Promise<string | void>,
    opts: { evidence?: boolean } = {},
  ): Promise<StepResult> {
    const evidence = opts.evidence !== false; // false for API-only steps: no page screenshot/diagnostics
    const step = ++this.stepCounter;
    const startedAt = new Date();
    const t0 = performance.now();
    const eventStart = this.events.length;
    let status: StepStatus = "pass";
    let detail: string | undefined;
    let error: string | undefined;

    try {
      detail = (await fn()) || undefined;
    } catch (err) {
      status = "fail";
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Math.round(performance.now() - t0);
    const file = `step-${step}.png`;
    let screenshot: string | null = evidence ? file : null;
    try {
      if (!evidence) throw new Error("no page evidence for this step");
      // Full-page capture on failure so the whole page is available for diagnosis.
      await this.page.screenshot({ path: path.join(this.dir, file), fullPage: status === "fail", timeout: 10_000 });
    } catch {
      screenshot = null;
    }

    let diagnostics: StepResult["diagnostics"];
    if (status === "fail" && evidence) {
      const consoleFile = `step-${step}-console.txt`;
      const ariaFile = `step-${step}-aria.yml`;
      const log = this.events.map((e) => e.text).join("\n") || "(no console output captured)";
      const aria = await this.page
        .locator("body")
        .ariaSnapshot({ timeout: 3_000 })
        .catch((e) => `# accessibility snapshot unavailable: ${e instanceof Error ? e.message : e}`);
      await writeFile(path.join(this.dir, consoleFile), log + "\n", "utf8").catch(() => {});
      await writeFile(path.join(this.dir, ariaFile), aria + "\n", "utf8").catch(() => {});
      diagnostics = { console: consoleFile, aria: ariaFile };
    }

    const result: StepResult = {
      step,
      kind,
      description,
      status,
      durationMs,
      screenshot,
      url: this.page.url(),
      startedAt: startedAt.toISOString(),
      detail,
      error,
      issues: this.events.slice(eventStart).filter((e) => e.issue).map((e) => e.text),
      diagnostics,
    };
    this.steps.push(result);
    return result;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

/** Holds the single active session for this server process. */
let active: QASession | null = null;

export function getSession(): QASession | null {
  return active;
}

export function requireSession(): QASession {
  if (!active) throw new Error("No active session. Call qa_start_session first.");
  return active;
}

export function setSession(session: QASession | null): void {
  active = session;
}
