import type { AgentResult, Finding, PageReport, Severity } from "../types.js";

export function finding(
  code: string,
  severity: Severity,
  title: string,
  extra: { group?: string; detail?: string; agents?: string[]; evidence?: string[] } = {},
): Finding {
  return { code, severity, title, ...extra };
}

/** The agents that actually returned HTML. Everything that compares content
 *  has to start here, because a blocked or failed fetch has no content to
 *  compare and would otherwise read as "sees nothing". */
export function fetched(report: PageReport): AgentResult[] {
  return report.agents.filter((a) => a.capture && !a.capture.error && a.facts);
}

/** Below this, a page is too thin for a comparison to mean anything: half a
 *  dozen words missing out of twenty proves nothing about rendering. */
export const MEANINGFUL_WORDS = 50;

/** A crawler holding less than this share of the reference text is not simply
 *  seeing a trimmed page — it is seeing a different one. */
export const STARVED_SHARE = 0.3;

/** Is this crawler's view starved next to the reference?
 *
 *  It lived inline in three places — the divergence check, the terminal table
 *  and the HTML table — each with its own copy of both numbers. The report
 *  painting a cell red and the check calling it a problem are the same claim,
 *  and they had no shared definition to drift from. */
export function starved(wordCount: number, reference: number): boolean {
  return reference >= MEANINGFUL_WORDS && wordCount < reference * STARVED_SHARE;
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
