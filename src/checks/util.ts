import type { AgentResult, Finding, PageReport, Severity } from "../types.js";

export function finding(
  code: string,
  severity: Severity,
  title: string,
  extra: { detail?: string; agents?: string[]; evidence?: string[] } = {},
): Finding {
  return { code, severity, title, ...extra };
}

/** The agents that actually returned HTML. Everything that compares content
 *  has to start here, because a blocked or failed fetch has no content to
 *  compare and would otherwise read as "sees nothing". */
export function fetched(report: PageReport): AgentResult[] {
  return report.agents.filter((a) => a.capture && !a.capture.error && a.facts);
}

/** The reference view a human gets: the rendered browser when --render ran,
 *  otherwise the richest bot response we have. */
export function reference(report: PageReport): { wordCount: number; source: string } | null {
  if (report.browser) {
    return { wordCount: report.browser.facts.wordCount, source: "browser" };
  }
  const results = fetched(report);
  if (!results.length) return null;
  let best = results[0]!;
  for (const r of results) {
    if ((r.facts?.wordCount ?? 0) > (best.facts?.wordCount ?? 0)) best = r;
  }
  return { wordCount: best.facts!.wordCount, source: best.agent.label };
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return part > 0 ? 100 : 0;
  return Math.round((part / whole) * 100);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function truncate(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
