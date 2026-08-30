import type { Finding, PageReport } from "../types.js";
import { MEANINGFUL_WORDS, fetched, finding, pct, starved as isStarved, truncate, unique } from "./util.js";

/** The question the whole tool exists to answer: does what a machine stores
 *  match what a person sees, and do all machines get the same answer. */
export function checkDivergence(report: PageReport): Finding[] {
  const out: Finding[] = [];
  const results = fetched(report);
  const attempted = report.agents.filter((a) => a.agent.ua !== null);
  if (!attempted.length) return out;

  // --- Requests that never produced a page -----------------------------------
  const failed = report.agents.filter((a) => a.capture?.error);
  for (const result of failed) {
    out.push(finding("fetch-failed", "error", `${result.agent.label} could not fetch the page.`,
      { agents: [result.agent.id], evidence: [result.capture!.error!] }));
  }

  // --- Status divergence ------------------------------------------------------
  const byStatus = new Map<number, string[]>();
  for (const r of report.agents) {
    if (!r.capture || r.capture.error) continue;
    const list = byStatus.get(r.capture.status) ?? [];
    list.push(r.agent.label);
    byStatus.set(r.capture.status, list);
  }
  if (byStatus.size > 1) {
    out.push(finding("status-divergence", "error", "The server returns different status codes to different crawlers.",
      { detail: "Serving bots something other than what a browser gets is what search engines call cloaking, whether or not it was intentional. The usual cause is bot protection, not a deliberate rule.",
        evidence: [...byStatus.entries()].map(([status, agents]) => `${status}: ${agents.join(", ")}`) }));
  }

  const blocked = report.agents.filter((r) => r.capture && !r.capture.error && (r.capture.status === 403 || r.capture.status === 429));
  if (blocked.length) {
    out.push(finding("crawler-blocked", "error", `${blocked.length} crawler${blocked.length > 1 ? "s are" : " is"} being turned away with ${unique(blocked.map((b) => String(b.capture!.status))).join("/")}.`,
      { detail: "Almost always a bot-protection rule or a WAF. The content may be perfect; these crawlers will never see it.",
        agents: blocked.map((b) => b.agent.id),
        evidence: blocked.map((b) => `${b.agent.label} → ${b.capture!.status}`) }));
  }

  // --- Redirect divergence ----------------------------------------------------
  const chains = new Map<string, string[]>();
  for (const r of report.agents) {
    if (!r.capture || r.capture.error) continue;
    const key = r.capture.redirects.map((h) => `${h.status}→${h.location}`).join(" | ") || "(none)";
    const list = chains.get(key) ?? [];
    list.push(r.agent.label);
    chains.set(key, list);
  }
  if (chains.size > 1) {
    out.push(finding("redirect-divergence", "error", "Crawlers are redirected differently from one another.",
      { evidence: [...chains.entries()].map(([chain, agents]) => `${agents.join(", ")}: ${chain}`) }));
  }
  const longest = Math.max(0, ...report.agents.map((r) => r.capture?.redirects.length ?? 0));
  if (longest >= 3) {
    out.push(finding("redirect-chain", "warn", `The page is reached through ${longest} redirects.`,
      { detail: "Each hop loses a little of whatever the original link was worth, and some crawlers stop following after five." }));
  }

  // --- Content divergence: the headline check ---------------------------------
  const browser = report.browser;
  if (browser) {
    const browserWords = browser.facts.wordCount;
    const starved = results.filter((r) => isStarved(r.facts!.wordCount, browserWords));

    if (starved.length === results.length && results.length > 0 && browserWords >= MEANINGFUL_WORDS) {
      const most = Math.max(...starved.map((s) => s.facts!.wordCount));
      const stored = most === 0 ? "every crawler stores none of it" : `no crawler stores more than ${most}`;
      out.push(finding("content-invisible", "error",
        `${browserWords.toLocaleString()} words render in the browser; ${stored}.`,
        { detail: "The page is built in the browser, so what gets stored is the empty container the app mounts into. Prerender the routes or move rendering to the server; nothing else on this report matters until this is fixed.",
          agents: starved.map((s) => s.agent.id) }));
    } else if (starved.length) {
      out.push(finding("content-partial", "error",
        `${starved.length} of ${results.length} crawlers see almost none of the page.`,
        { detail: "The crawlers that run JavaScript get the content; the ones that do not are left with the shell. That split is the difference between ranking in search and being absent from AI answers.",
          agents: starved.map((s) => s.agent.id),
          evidence: starved.map((s) => `${s.agent.label}: ${s.facts!.wordCount} words vs ${browserWords} in the browser`) }));
    } else if (browserWords >= MEANINGFUL_WORDS) {
      const worst = results.reduce((acc, r) => Math.min(acc, pct(r.facts!.wordCount, browserWords)), 100);
      if (worst < 80) {
        out.push(finding("content-reduced", "warn",
          `The thinnest crawler view holds ${worst}% of the browser's text.`,
          { detail: "Part of the page needs JavaScript. Check whether the missing part is the part that matters." }));
      } else {
        out.push(finding("content-match", "ok", "Every crawler receives the same content a browser does."));
      }
    }

    // Structured data and headings that only exist after rendering.
    const botTypes = new Set(results.flatMap((r) => r.facts!.jsonLd.flatMap((b) => b.types)));
    const browserTypes = new Set(browser.facts.jsonLd.flatMap((b) => b.types));
    const onlyRendered = [...browserTypes].filter((t) => !botTypes.has(t));
    if (onlyRendered.length) {
      out.push(finding("jsonld-client-only", "error", "Structured data is injected by JavaScript.",
        { detail: "Types present after rendering but absent from the HTML crawlers store. Rich results are decided from the stored HTML.",
          evidence: onlyRendered }));
    }

    // Link graph: if navigation is client-side, a crawler cannot find the site.
    const botLinks = new Set(results.flatMap((r) => r.facts!.links.filter((l) => l.internal).map((l) => l.absolute ?? l.href)));
    const browserLinks = new Set(browser.facts.links.filter((l) => l.internal).map((l) => l.absolute ?? l.href));
    const hiddenLinks = [...browserLinks].filter((l) => !botLinks.has(l));
    if (browserLinks.size > 0 && botLinks.size === 0) {
      out.push(finding("links-invisible", "error", "Crawlers see no internal links at all.",
        { detail: `The browser exposes ${browserLinks.size}. Navigation is rendered client-side, so a crawler that lands here cannot reach any other page — the rest of the site is undiscoverable from this one.` }));
    } else if (hiddenLinks.length > 3) {
      out.push(finding("links-partial", "warn", `${hiddenLinks.length} internal links exist only after JavaScript runs.`,
        { evidence: hiddenLinks.slice(0, 5).map((l) => truncate(l, 90)) }));
    }
  } else {
    // No browser view: still worth reporting a page that is empty for everyone.
    const empty = results.filter((r) => r.facts!.wordCount < 25);
    if (empty.length === results.length && results.length > 0) {
      out.push(finding("content-empty", "error", "Every crawler receives a page with almost no text.",
        { detail: "Either the page is genuinely empty or it is built in the browser. Run again with --render to tell the two apart.",
          agents: empty.map((e) => e.agent.id) }));
    }
  }

  // --- Title and description divergence between agents ------------------------
  const titles = unique(results.map((r) => r.facts!.title ?? "(none)"));
  if (titles.length > 1) {
    out.push(finding("title-divergence", "warn", "Crawlers are given different titles.",
      { evidence: results.map((r) => `${r.agent.label}: ${truncate(r.facts!.title ?? "(none)", 70)}`) }));
  }

  // --- Payload shape ----------------------------------------------------------
  const heaviest = results.reduce<{ label: string; ratio: number; bytes: number } | null>((acc, r) => {
    const facts = r.facts!;
    const textLength = Math.max(1, facts.text.length);
    const ratio = facts.scriptBytes / textLength;
    if (!acc || ratio > acc.ratio) return { label: r.agent.label, ratio, bytes: facts.scriptBytes };
    return acc;
  }, null);
  if (heaviest && heaviest.ratio > 10 && heaviest.bytes > 50_000) {
    out.push(finding("script-heavy", "info",
      `Inline script outweighs readable text by ${Math.round(heaviest.ratio)}×.`,
      { detail: "Not a ranking factor on its own, but it is what a page looks like when the content arrives last." }));
  }

  return out;
}
