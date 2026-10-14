import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { QASession, StepResult } from "./state.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const badge = (s: StepResult["status"]) => (s === "pass" ? "✅ PASS" : "❌ FAIL");

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
  lines.push(`**Started:** ${session.startedAt.toISOString()}  `);
  lines.push(`**Finished:** ${finishedAt.toISOString()}  `);
  lines.push(`**Steps:** ${steps.length} (${passed} passed, ${failed.length} failed)  `);
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
    if (s.screenshot) lines.push(`![Step ${s.step}](${s.screenshot})`, "");
    else lines.push("_Screenshot unavailable._", "");
  }

  const file = path.join(session.dir, "README.md");
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}
