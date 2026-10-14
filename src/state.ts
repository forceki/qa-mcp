import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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
  /** JS dialogs (alert/confirm/prompt/beforeunload) that appeared during this step and how they were answered. */
  dialogs?: string[];
  /** Set when this step opened a new tab; the session switched to it automatically. */
  newTab?: string;
}

export interface DialogRecord {
  type: string;
  message: string;
  defaultValue: string;
  outcome: "accepted" | "dismissed";
  tab: number;
  /** True once matched by a dialog_shown assertion. */
  consumed: boolean;
}

export interface DialogPolicy {
  action: "accept" | "dismiss";
  promptText?: string;
  /** false = applies to the next dialog only, then reverts to the default (dismiss). */
  persist: boolean;
}

const describeDialog = (d: DialogRecord) =>
  `${d.type} "${d.message.length > 120 ? d.message.slice(0, 120) + "…" : d.message}" -> ${d.outcome}`;

const MAX_EVENTS = 500;
export const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
export const REQUEST_TIMEOUT_MS = num(process.env.QA_NAV_TIMEOUT_MS, 30_000);
/** After click-like actions, wait this long for a popup/new tab to be reported (0 disables). */
export const POPUP_WAIT_MS = process.env.QA_POPUP_WAIT_MS !== undefined ? Math.max(0, Number(process.env.QA_POPUP_WAIT_MS) || 0) : 300;
export const ASSERT_TIMEOUT_MS = num(process.env.QA_ASSERT_TIMEOUT_MS, 5_000);

export const BROWSER_ARGS = [
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--js-flags=--max-old-space-size=128",
];

/**
 * Saved login states live outside any repo by default (they contain live session cookies).
 * Override with QA_STATE_DIR.
 */
export const STATE_DIR = process.env.QA_STATE_DIR ?? path.join(os.homedir(), ".qa-agent", "states");

export function statePath(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) {
    throw new Error(`Invalid state name "${name}". Use letters, numbers, "_", "-" or "." only.`);
  }
  return path.join(STATE_DIR, `${name}.json`);
}

export interface StateInfo {
  name: string;
  savedAt: string;
  ageMinutes: number;
  cookies: number;
  domains: string[];
  origins: string[];
}

export async function listStates(): Promise<StateInfo[]> {
  let files: string[];
  try {
    files = (await readdir(STATE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: StateInfo[] = [];
  for (const f of files.sort()) {
    const file = path.join(STATE_DIR, f);
    try {
      const st = await stat(file);
      const json = JSON.parse(await readFile(file, "utf8")) as {
        cookies?: { domain: string }[];
        origins?: { origin: string }[];
      };
      out.push({
        name: f.replace(/\.json$/, ""),
        savedAt: st.mtime.toISOString(),
        ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60_000),
        cookies: json.cookies?.length ?? 0,
        domains: [...new Set((json.cookies ?? []).map((c) => c.domain))],
        origins: (json.origins ?? []).map((o) => o.origin),
      });
    } catch {
      // unreadable/corrupt file: skip it
    }
  }
  return out;
}

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
  /** Name of the saved login state this session started from, if any. */
  loadedState?: string;
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
  private pages: Page[] = [];
  private current: Page;
  /** Tabs opened since the current step started (popups, target=_blank, window.open). */
  private pendingNew: Page[] = [];
  readonly dialogs: DialogRecord[] = [];
  private dialogPolicy: DialogPolicy | null = null;

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
    this.current = page;
    this.registerPage(page);
    context.on("page", (p) => {
      this.registerPage(p);
      this.pendingNew.push(p);
    });
  }

  /** The tab all tools act on. Switches automatically to tabs opened by a step; see qa_tab. */
  get page(): Page {
    if (this.current.isClosed()) {
      // The tab closed itself (window.close()) before its close event ran: fall back to the previous tab.
      this.removePage(this.current);
      if (this.current.isClosed()) throw new Error("No open tab. Open one with qa_tab action=new.");
    }
    return this.current;
  }

  get tabs(): Page[] {
    return [...this.pages];
  }

  /** 1-based position of the current tab in `tabs`. */
  get currentTabIndex(): number {
    return this.pages.indexOf(this.page) + 1;
  }

  private registerPage(page: Page): void {
    this.pages.push(page);
    this.attachListeners(page);
    page.on("close", () => this.removePage(page));
    page.on("dialog", (d) => {
      const policy = this.dialogPolicy;
      const accept = policy?.action === "accept";
      this.dialogs.push({
        type: d.type(),
        message: d.message(),
        defaultValue: d.defaultValue(),
        outcome: accept ? "accepted" : "dismissed",
        tab: this.pages.indexOf(page) + 1,
        consumed: false,
      });
      this.record(`dialog.${d.type()}: ${d.message()} -> ${accept ? "accepted" : "dismissed"}`, false);
      if (policy && !policy.persist) this.dialogPolicy = null;
      (accept ? d.accept(policy?.promptText) : d.dismiss()).catch(() => {});
    });
  }

  private removePage(page: Page): void {
    const i = this.pages.indexOf(page);
    if (i === -1) return;
    this.pages.splice(i, 1);
    if (this.current === page && this.pages.length) this.current = this.pages[Math.max(0, i - 1)];
  }

  async openTab(url?: string): Promise<Page> {
    const page = await this.context.newPage();
    this.current = page;
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }

  switchTab(index: number): Page {
    const page = this.pages[index - 1];
    if (!page) throw new Error(`No tab #${index}. Open tabs: ${this.pages.length} (use qa_tab action=list).`);
    this.current = page;
    return page;
  }

  /** Closes a tab (default: current). The last remaining tab cannot be closed. */
  async closeTab(index?: number): Promise<void> {
    if (this.pages.length <= 1) throw new Error("Cannot close the last tab.");
    const target = index === undefined ? this.page : this.pages[index - 1];
    if (!target) throw new Error(`No tab #${index}. Open tabs: ${this.pages.length}.`);
    await target.close();
    this.removePage(target);
  }

  /** Arms how the next dialog(s) are answered. With no policy, dialogs are dismissed (Playwright's default). */
  setDialogPolicy(policy: DialogPolicy): void {
    this.dialogPolicy = policy;
  }

  /** Marks the first not-yet-asserted dialog whose message contains `text`. */
  consumeDialog(text: string): DialogRecord | undefined {
    const d = this.dialogs.find((x) => !x.consumed && x.message.includes(text));
    if (d) d.consumed = true;
    return d;
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
    opts: {
      httpCredentials?: { username: string; password: string };
      storageStatePath?: string;
      loadedState?: string;
    } = {},
  ): Promise<QASession> {
    const { httpCredentials, storageStatePath, loadedState } = opts;
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
          ...(storageStatePath ? { storageState: storageStatePath } : {}),
        });
        context.setDefaultTimeout(num(process.env.QA_TIMEOUT_MS, 10_000));
        context.setDefaultNavigationTimeout(num(process.env.QA_NAV_TIMEOUT_MS, 30_000));
        const page = await context.newPage();
        const session = new QASession(testName, dir, browser, context, page);
        session.loadedState = loadedState;
        return session;
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

  /** Saves cookies, localStorage and IndexedDB so a later session can start already logged in. */
  async saveState(file: string): Promise<{ cookies: number; origins: number }> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const st = await this.context.storageState({ path: file, indexedDB: true });
    await chmod(file, 0o600);
    return { cookies: st.cookies.length, origins: st.origins.length };
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
    opts: { evidence?: boolean; watchPopups?: boolean } = {},
  ): Promise<StepResult> {
    const evidence = opts.evidence !== false; // false for API-only steps: no page screenshot/diagnostics
    const step = ++this.stepCounter;
    const startedAt = new Date();
    const t0 = performance.now();
    const eventStart = this.events.length;
    const dialogStart = this.dialogs.length;
    this.pendingNew = [];
    let status: StepStatus = "pass";
    let detail: string | undefined;
    let error: string | undefined;

    try {
      detail = (await fn()) || undefined;
    } catch (err) {
      status = "fail";
      error = err instanceof Error ? err.message : String(err);
    }

    // The browser reports a popup slightly after the click that caused it returns.
    if (opts.watchPopups && POPUP_WAIT_MS > 0 && !this.pendingNew.length) {
      await this.context.waitForEvent("page", { timeout: POPUP_WAIT_MS }).catch(() => {});
    }

    // A step that opened a tab (link target=_blank, window.open) continues in that tab.
    let newTab: string | undefined;
    const opened = this.pendingNew.filter((p) => !p.isClosed());
    if (opened.length) {
      const tab = opened[opened.length - 1];
      await tab.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
      if (!tab.isClosed()) {
        this.current = tab;
        newTab = `#${this.pages.indexOf(tab) + 1} ${tab.url()}`;
      }
    }

    let page: Page | null = null;
    try {
      page = this.page;
    } catch {
      // every tab was closed
    }

    const durationMs = Math.round(performance.now() - t0);
    const file = `step-${step}.png`;
    let screenshot: string | null = evidence ? file : null;
    try {
      if (!evidence) throw new Error("no page evidence for this step");
      // Full-page capture on failure so the whole page is available for diagnosis.
      if (!page) throw new Error("no open tab");
      await page.screenshot({ path: path.join(this.dir, file), fullPage: status === "fail", timeout: 10_000 });
    } catch {
      screenshot = null;
    }

    let diagnostics: StepResult["diagnostics"];
    if (status === "fail" && evidence) {
      const consoleFile = `step-${step}-console.txt`;
      const ariaFile = `step-${step}-aria.yml`;
      const log = this.events.map((e) => e.text).join("\n") || "(no console output captured)";
      const aria = await (page ? page.ariaSnapshot({ mode: "ai", timeout: 3_000 }) : Promise.reject(new Error("no open tab")))
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
      url: page?.url() ?? "(no open tab)",
      startedAt: startedAt.toISOString(),
      detail,
      error,
      issues: this.events.slice(eventStart).filter((e) => e.issue).map((e) => e.text),
      diagnostics,
      dialogs: this.dialogs.slice(dialogStart).map(describeDialog),
      newTab,
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
