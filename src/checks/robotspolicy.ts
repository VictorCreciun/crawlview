import type { Finding, PageReport } from "../types.js";
import { finding, truncate, unique } from "./util.js";

/** What robots.txt permits, per agent. Separate from whether the page renders:
 *  a perfectly built page behind `Disallow: /` is invisible for a reason no
 *  amount of HTML inspection would ever reveal. */
export function checkRobotsPolicy(report: PageReport): Finding[] {
  const out: Finding[] = [];
  const robots = report.robotsTxt;

  if (!robots || robots.status === 0) {
    out.push(finding("robots-unreachable", "warn", "robots.txt could not be fetched.",
      { detail: "Crawlers that cannot read robots.txt may treat the whole site as disallowed." }));
    return out;
  }

  if (robots.status === 404) {
    out.push(finding("robots-absent", "info", "No robots.txt.",
      { detail: "Everything is crawlable, which is usually fine. It also means there is nowhere to declare your sitemap." }));
  } else if (robots.status >= 500) {
    out.push(finding("robots-server-error", "error", `robots.txt returns ${robots.status}.`,
      { detail: "A 5xx on robots.txt makes Google stop crawling the site until it recovers. This is more damaging than having no robots.txt at all." }));
    return out;
  }

  const blocked = report.agents.filter((a) => a.robots && !a.robots.allowed);
  if (blocked.length) {
    const search = blocked.filter((b) => b.agent.group === "search");
    const ai = blocked.filter((b) => b.agent.group === "ai");
    const social = blocked.filter((b) => b.agent.group === "social");

    if (search.length) {
      out.push(finding("robots-blocks-search", "error",
        `robots.txt blocks ${search.map((s) => s.agent.label).join(", ")} from this URL.`,
        { agents: search.map((s) => s.agent.id),
          evidence: search.map((s) => `${s.agent.label} — matched "${s.robots!.matchedToken ?? "*"}", ${s.robots!.decidingRule}`) }));
    }
    if (ai.length) {
      out.push(finding("robots-blocks-ai", "warn",
        `robots.txt blocks ${ai.length} AI crawler${ai.length > 1 ? "s" : ""}: ${ai.map((s) => s.agent.label).join(", ")}.`,
        { detail: "Deliberate for many sites. If it was not deliberate, this is why the page never appears in an assistant's answer — and blocking OAI-SearchBot or Google-Extended removes you from answers without removing you from search.",
          agents: ai.map((s) => s.agent.id),
          evidence: ai.map((s) => `${s.agent.label} — matched "${s.robots!.matchedToken ?? "*"}", ${s.robots!.decidingRule}`) }));
    }
    if (social.length) {
      out.push(finding("robots-blocks-social", "warn",
        `robots.txt blocks ${social.map((s) => s.agent.label).join(", ")}.`,
        { detail: "Link previews on those platforms will be blank." }));
    }
  } else if (robots.status === 200) {
    out.push(finding("robots-allows-all", "ok", "robots.txt allows every crawler checked."));
  }

  return out;
}

/** Findings about the robots.txt file itself rather than this URL. */
export function checkRobotsFile(report: PageReport, malformed: string[], sitemaps: string[]): Finding[] {
  const out: Finding[] = [];
  if (!report.robotsTxt || report.robotsTxt.status !== 200) return out;

  if (malformed.length) {
    out.push(finding("robots-malformed", "warn",
      `${malformed.length} ${malformed.length === 1 ? "line" : "lines"} in robots.txt could not be understood.`,
      { detail: "Unrecognised lines are skipped silently, so a typo in a Disallow rule means the rule simply does not exist.",
        evidence: unique(malformed).slice(0, 5).map((l) => truncate(l, 80)) }));
  }

  if (!sitemaps.length) {
    out.push(finding("robots-no-sitemap", "info", "robots.txt declares no sitemap.",
      { detail: "A Sitemap: line is how a crawler that has never seen your site finds the rest of it." }));
  }

  return out;
}
