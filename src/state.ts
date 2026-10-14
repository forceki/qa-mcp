import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type StepStatus = "pass" | "fail";

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
}

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
  private stepCounter = 0;
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
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(30_000);
        return new QASession(testName, dir, browser, context, page);
      } catch (err) {
        lastErr = err;
        await browser?.close().catch(() => {});
        console.error(`[qa-agent] browser launch failed (${ch ?? "bundled chromium"}): ${err instanceof Error ? err.message : err}`);
      }
    }
    throw lastErr;
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
  ): Promise<StepResult> {
    const step = ++this.stepCounter;
    const startedAt = new Date();
    const t0 = performance.now();
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
    let screenshot: string | null = file;
    try {
      await this.page.screenshot({ path: path.join(this.dir, file) });
    } catch {
      screenshot = null;
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
