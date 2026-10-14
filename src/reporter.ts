import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiRecord, QASession, StepResult } from "./state.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const badge = (s: StepResult["status"]) => (s === "pass" ? "✅ PASS" : "❌ FAIL");

const fence = (lang: string, body: string) => ["```" + lang, body, "```", ""];
const headerBlock = (h: Record<string, string>) =>
  Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)";

function renderApi(a: ApiRecord): string[] {
  const out: string[] = [];
  out.push(`- **Request:** \`${a.method} ${a.url}\``);
  out.push(`- **Response:** \`${a.status} ${a.statusText}\` in ${a.durationMs}ms`);
  if (a.saved.length) out.push(`- **Saved variables:** ${a.saved.map((n) => `\`${n}\``).join(", ")}`);
  out.push("");
  if (a.note) out.push(`> ${a.note.replace(/\r?\n/g, " ")}`, "");
  if (a.reportDetail === "full") {
    out.push("<details><summary>Request details</summary>", "");
    out.push("**Headers**", "", ...fence("http", headerBlock(a.requestHeaders)));
    if (a.requestBody) out.push("**Body**", "", ...fence("json", a.requestBody));
    out.push("</details>", "", "<details open><summary>Response details</summary>", "");
    out.push("**Headers**", "", ...fence("http", headerBlock(a.responseHeaders)));
    if (a.responseBody) out.push(`**Body**${a.truncated ? " _(truncated)_" : ""}`, "", ...fence("json", a.responseBody));
    out.push("</details>", "");
  }
  return out;
}

export async function writeReport(session: QASession, summaryNotes?: string): Promise<string> {
  const finishedAt = new Date();
  const steps = session.steps;
  const failed = steps.filter((s) => s.status === "fail");
  const passed = steps.length - failed.length;
  const overall = failed.length === 0 && steps.length > 0 ? "PASS" : "FAIL";
  const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);

  const lines: string[] = [];
  lines.push(`# QA Report: ${session.testName}`, "");
  lines.push(`**Result:** ${overall === "PASS" ? "✅ PASS" : "❌ FAIL"}  `);
  if (session.loadedState) lines.push(`**Login state:** loaded \`${session.loadedState}\` (saved login, no manual login steps)  `);
  lines.push(`**Started:** ${session.startedAt.toISOString()}  `);
  lines.push(`**Finished:** ${finishedAt.toISOString()}  `);
  lines.push(`**Steps:** ${steps.length} (${passed} passed, ${failed.length} failed)  `);
  const issueCount = steps.reduce((n, s) => n + s.issues.length, 0);
  if (issueCount) lines.push(`**Browser issues:** ${issueCount} console error/failed-request events (see steps below)  `);
  lines.push(`**Total step time:** ${(totalMs / 1000).toFixed(2)}s`, "");

  if (summaryNotes) lines.push("## Summary", "", summaryNotes, "");

  lines.push("## Steps", "");
  lines.push("| # | Status | Type | Description | Duration | URL |");
  lines.push("|---|--------|------|-------------|----------|-----|");
  for (const s of steps) {
    lines.push(
      `| ${s.step} | ${badge(s.status)} | ${s.kind} | ${esc(s.description)} | ${s.durationMs}ms | ${esc(s.url)} |`,
    );
  }
  lines.push("");

  lines.push("## Evidence", "");
  for (const s of steps) {
    lines.push(`### Step ${s.step}: ${s.description} — ${badge(s.status)}`, "");
    lines.push(`- **Type:** ${s.kind}`);
    lines.push(`- **Duration:** ${s.durationMs}ms`);
    lines.push(`- **URL:** ${s.url}`);
    if (s.detail) lines.push(`- **Detail:** ${s.detail}`);
    lines.push("");
    if (s.error) lines.push("```text", s.error, "```", "");
    if (s.diagnostics) {
      lines.push(
        `- **Diagnostics:** [console log](${s.diagnostics.console}) · [accessibility tree](${s.diagnostics.aria})`,
        "",
      );
    }
    if (s.issues.length) {
      lines.push("<details><summary>Browser issues (" + s.issues.length + ")</summary>", "", "```text", ...s.issues, "```", "", "</details>", "");
    }
    if (s.api) lines.push(...renderApi(s.api));
    if (s.screenshot) lines.push(`![Step ${s.step}](${s.screenshot})`, "");
    else if (!s.api) lines.push("_Screenshot unavailable._", "");
  }

  const file = path.join(session.dir, "README.md");
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}
