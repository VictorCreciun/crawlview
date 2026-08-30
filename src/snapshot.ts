import { readFile, writeFile } from "node:fs/promises";
import type { Finding, PageReport } from "./types.js";
import { finding } from "./checks/util.js";

export interface Snapshot {
  version: 1;
  url: string;
  takenAt: string;
  /** Only the shape that matters for regressions: which findings existed and
   *  what each agent could see. Full HTML is deliberately not stored — a
   *  snapshot people commit has to stay small and readable in a diff. */
  findings: { code: string; severity: string; title: string }[];
  agents: { id: string; status: number | null; words: number | null; jsonLd: number | null }[];
  browserWords: number | null;
}

export function toSnapshot(report: PageReport): Snapshot {
  return {
    version: 1,
    url: report.url,
    takenAt: report.startedAt,
    findings: report.findings
      .filter((f) => f.severity !== "ok")
      .map((f) => ({ code: f.code, severity: f.severity, title: f.title })),
    agents: report.agents.map((a) => ({
      id: a.agent.id,
      status: a.capture?.status ?? null,
      words: a.facts?.wordCount ?? null,
      jsonLd: a.facts?.jsonLd.length ?? null,
    })),
    browserWords: report.browser?.facts.wordCount ?? null,
  };
}

export async function writeSnapshot(path: string, report: PageReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(toSnapshot(report), null, 2)}\n`, "utf8");
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Snapshot;
  if (parsed.version !== 1) throw new Error(`unsupported snapshot version: ${parsed.version}`);
  return parsed;
}

/** Compares a run against a stored baseline. Regressions are what fails a
 *  build; things that got better are reported but never fail anything. */
export function diffSnapshot(baseline: Snapshot, report: PageReport): { findings: Finding[]; regressions: number } {
  const out: Finding[] = [];
  const now = toSnapshot(report);

  const before = new Map(baseline.findings.map((f) => [f.code, f]));
  const after = new Map(now.findings.map((f) => [f.code, f]));

  const appeared = [...after.values()].filter((f) => !before.has(f.code));
  const resolved = [...before.values()].filter((f) => !after.has(f.code));

  for (const item of appeared) {
    out.push(finding(`new:${item.code}`, item.severity === "error" ? "error" : "warn",
      `New since the snapshot: ${item.title}`));
  }
  for (const item of resolved) {
    out.push(finding(`fixed:${item.code}`, "ok", `Fixed since the snapshot: ${item.title}`));
  }

  const beforeAgents = new Map(baseline.agents.map((a) => [a.id, a]));
  for (const agent of now.agents) {
    const old = beforeAgents.get(agent.id);
    if (!old) continue;
    if (old.words !== null && agent.words !== null && old.words >= 50 && agent.words < old.words * 0.7) {
      out.push(finding(`regress:words:${agent.id}`, "error",
        `${agent.id} now sees ${agent.words} words, down from ${old.words}.`));
    }
    if ((old.jsonLd ?? 0) > 0 && (agent.jsonLd ?? 0) === 0) {
      out.push(finding(`regress:jsonld:${agent.id}`, "error",
        `${agent.id} no longer receives any structured data (${old.jsonLd} blocks before).`));
    }
    if (old.status !== null && agent.status !== null && old.status !== agent.status) {
      out.push(finding(`regress:status:${agent.id}`,
        agent.status >= 400 ? "error" : "warn",
        `${agent.id} status changed ${old.status} → ${agent.status}.`));
    }
  }

  return { findings: out, regressions: out.filter((f) => f.severity === "error").length };
}
