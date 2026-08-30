import type { PageReport } from "../types.js";

/** The machine-readable form. Captures are dropped: nobody wants a megabyte of
 *  HTML per agent in a pipeline artefact, and every check has already run. */
export function toJson(report: PageReport): string {
  return JSON.stringify(
    {
      tool: "crawlview",
      url: report.url,
      startedAt: report.startedAt,
      elapsedMs: report.elapsedMs,
      summary: {
        errors: report.findings.filter((f) => f.severity === "error").length,
        warnings: report.findings.filter((f) => f.severity === "warn").length,
        notes: report.findings.filter((f) => f.severity === "info").length,
        passed: report.findings.filter((f) => f.severity === "ok").length,
      },
      findings: report.findings,
      agents: report.agents.map((a) => ({
        id: a.agent.id,
        label: a.agent.label,
        group: a.agent.group,
        js: a.agent.js,
        robots: a.robots,
        status: a.capture?.status ?? null,
        error: a.capture?.error ?? null,
        bytes: a.capture?.bytes ?? null,
        elapsedMs: a.capture?.elapsedMs ?? null,
        redirects: a.capture?.redirects ?? [],
        page: a.facts
          ? {
              title: a.facts.title,
              description: a.facts.metaDescription,
              canonical: a.facts.canonical,
              htmlLang: a.facts.htmlLang,
              detectedLang: a.facts.detectedLang,
              wordCount: a.facts.wordCount,
              headings: a.facts.headings.length,
              internalLinks: a.facts.links.filter((l) => l.internal).length,
              jsonLdTypes: a.facts.jsonLd.flatMap((b) => b.types),
              hreflang: a.facts.hreflang,
            }
          : null,
      })),
      browser: report.browser
        ? {
            status: report.browser.capture.status,
            bytes: report.browser.capture.bytes,
            wordCount: report.browser.facts.wordCount,
            jsonLdTypes: report.browser.facts.jsonLd.flatMap((b) => b.types),
            internalLinks: report.browser.facts.links.filter((l) => l.internal).length,
          }
        : null,
      robotsTxt: report.robotsTxt ? { url: report.robotsTxt.url, status: report.robotsTxt.status } : null,
      llmsTxt: report.llmsTxt,
      site: report.site ?? null,
    },
    null,
    2,
  );
}
