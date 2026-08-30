import type { PageReport, Severity } from "../types.js";

const HEADING: Record<Severity, string> = {
  error: "Problems", warn: "Worth fixing", info: "Notes", ok: "Passing",
};

/** For pasting into an issue or a pull request comment. */
export function toMarkdown(report: PageReport): string {
  const out: string[] = [];
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warns = report.findings.filter((f) => f.severity === "warn").length;

  out.push(`## crawlview — ${report.url}`);
  out.push("");
  out.push(`${errors} problem${errors === 1 ? "" : "s"}, ${warns} worth fixing, ${report.agents.length} crawlers checked${report.browser ? ", compared against a rendered browser" : ""}.`);
  out.push("");

  out.push("| Crawler | Status | Words | Title | H1 | Canonical | JSON-LD | robots.txt |");
  out.push("| --- | ---: | ---: | :---: | ---: | :---: | ---: | :---: |");
  for (const a of report.agents) {
    if (a.agent.ua === null) {
      out.push(`| ${a.agent.label} | — | — | — | — | — | — | ${a.robots?.allowed === false ? "block" : "allow"} |`);
      continue;
    }
    const cap = a.capture;
    const f = a.facts;
    const h1 = f ? f.headings.filter((h) => h.level === 1).length : null;
    out.push(`| ${a.agent.label} | ${cap?.error ? "error" : cap?.status ?? "—"} | ${f?.wordCount ?? "—"} | ${f?.title ? "yes" : "no"} | ${h1 ?? "—"} | ${f?.canonical ? "yes" : "no"} | ${f?.jsonLd.length ?? "—"} | ${a.robots?.allowed === false ? "block" : "allow"} |`);
  }
  if (report.browser) {
    const f = report.browser.facts;
    out.push(`| **Browser (rendered)** | ${report.browser.capture.status} | **${f.wordCount}** | ${f.title ? "yes" : "no"} | ${f.headings.filter((h) => h.level === 1).length} | ${f.canonical ? "yes" : "no"} | ${f.jsonLd.length} | — |`);
  }
  out.push("");

  for (const severity of ["error", "warn", "info", "ok"] as Severity[]) {
    const items = report.findings.filter((f) => f.severity === severity);
    if (!items.length) continue;
    out.push(`### ${HEADING[severity]}`);
    out.push("");
    for (const item of items) {
      out.push(`**${item.title}**`);
      if (item.detail) out.push(`${item.detail}`);
      if (item.evidence?.length) {
        out.push("");
        for (const e of item.evidence) out.push(`- \`${e.replace(/`/g, "'")}\``);
      }
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push("Generated with [crawlview](https://github.com/VictorCreciun/crawlview).");
  return out.join("\n");
}
