import { BROWSER_UA, agentById } from "../agents.js";
import { capture, fetchText, pool } from "../fetch.js";
import { parseHtml } from "../extract/html.js";
import { evaluate, parseRobots, robotsUrl } from "../robots.js";
import { finding } from "../checks/util.js";
import { candidateSitemaps, loadSitemap, type SitemapEntry } from "./sitemap.js";
import type { Finding, RunOptions, SiteReport } from "../types.js";

export interface SiteOptions extends RunOptions {
  limit: number;
  sitemapUrl: string | null;
  /** The agent whose eyes the site is walked through. */
  agentId: string;
}

interface PageRow {
  url: string;
  status: number | null;
  wordCount: number | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  noindex: boolean;
  links: string[];
  bodyHash: string;
}

/** A cheap shape signature: normalised word count plus title. Two URLs with
 *  the same signature are, for a crawler's purposes, the same page. */
function shapeOf(title: string | null, words: number): string {
  return `${(title ?? "").trim().toLowerCase()}|${Math.round(words / 10) * 10}`;
}

export async function crawlSite(opts: SiteOptions): Promise<{ site: SiteReport; findings: Finding[] }> {
  const origin = new URL(opts.url).origin;
  const findings: Finding[] = [];

  // Find the sitemap: declared in robots.txt, or the usual filenames.
  let declared: string[] = [];
  const robotsRes = await fetchText(robotsUrl(opts.url), opts, BROWSER_UA);
  const robots = robotsRes.status === 200 && robotsRes.body ? parseRobots(robotsRes.body) : null;
  if (robots) declared = robots.sitemaps;

  let sitemapUrl: string | null = null;
  let entries: SitemapEntry[] = [];

  const candidates = opts.sitemapUrl ? [opts.sitemapUrl] : candidateSitemaps(origin, declared);
  for (const candidate of candidates) {
    const loaded = await loadSitemap(candidate, opts);
    if (loaded.entries.length) {
      sitemapUrl = candidate;
      entries = loaded.entries;
      break;
    }
  }

  if (!entries.length) {
    findings.push(finding("sitemap-missing", "error", "No sitemap could be loaded.",
      { detail: "Without one, a crawler has to discover every page by following links — and any page not linked from another is invisible.",
        evidence: candidates.slice(0, 4) }));
    return { site: { sitemapUrl: null, urls: [], checked: 0, pages: [], findings }, findings };
  }

  // Sitemap hygiene, before fetching anything.
  const locs = entries.map((e) => e.loc);
  const duplicates = locs.filter((l, i) => locs.indexOf(l) !== i);
  if (duplicates.length) {
    findings.push(finding("sitemap-duplicates", "warn",
      `The sitemap lists ${new Set(duplicates).size} URL${new Set(duplicates).size === 1 ? "" : "s"} more than once.`,
      { evidence: [...new Set(duplicates)].slice(0, 5) }));
  }
  const offsite = locs.filter((l) => { try { return new URL(l).origin !== origin; } catch { return true; } });
  if (offsite.length) {
    findings.push(finding("sitemap-offsite", "error",
      `${offsite.length} sitemap ${offsite.length === 1 ? "entry is" : "entries are"} on another host.`,
      { detail: "A sitemap may only list URLs from the site that serves it; the rest are ignored.",
        evidence: offsite.slice(0, 4) }));
  }
  const identicalLastmod = new Set(entries.map((e) => e.lastmod).filter(Boolean));
  if (identicalLastmod.size === 1 && entries.length > 5) {
    findings.push(finding("sitemap-lastmod-uniform", "info",
      "Every entry carries the same lastmod.",
      { detail: "Correct if the whole site really did change that day — a first deploy, or a redesign. If it did not, the value is a build timestamp rather than a modification date, and a crawler that notices stops using it to decide what to recheck.",
        evidence: [`all ${entries.length} entries: ${[...identicalLastmod][0]}`] }));
  }

  const targets = [...new Set(locs)].slice(0, opts.limit);
  const agent = agentById(opts.agentId) ?? agentById("googlebot-mobile")!;

  const rows = await pool(targets, opts.concurrency, opts.delayMs, async (url): Promise<PageRow> => {
    const cap = await capture({ url, ua: agent.ua, agentId: agent.id }, opts);
    if (cap.error || !cap.html) {
      return { url, status: cap.error ? null : cap.status, wordCount: null, title: null,
               description: null, canonical: null, noindex: false, links: [], bodyHash: "" };
    }
    const facts = parseHtml(cap.html, cap.finalUrl);
    const headerRobots = Object.entries(cap.headers)
      .filter(([k]) => k.toLowerCase() === "x-robots-tag").map(([, v]) => v).join(" ");
    return {
      url,
      status: cap.status,
      wordCount: facts.wordCount,
      title: facts.title,
      description: facts.metaDescription,
      canonical: facts.canonical,
      noindex: /\bnoindex\b|\bnone\b/i.test(headerRobots) ||
               facts.metaRobots.some((m) => /\bnoindex\b|\bnone\b/i.test(m.content)),
      links: facts.links.filter((l) => l.internal && l.absolute).map((l) => l.absolute!),
      bodyHash: shapeOf(facts.title, facts.wordCount),
    };
  });

  // --- What the sitemap promises against what the server delivers -------------
  const broken = rows.filter((r) => r.status !== null && (r.status >= 400 || r.status === 0));
  if (broken.length) {
    findings.push(finding("sitemap-broken", "error",
      `${broken.length} sitemap URL${broken.length === 1 ? "" : "s"} do not return a page.`,
      { evidence: broken.slice(0, 6).map((r) => `${r.status} ${r.url}`) }));
  }

  const redirected = rows.filter((r) => r.status !== null && r.status >= 300 && r.status < 400);
  if (redirected.length) {
    findings.push(finding("sitemap-redirects", "warn",
      `${redirected.length} sitemap URL${redirected.length === 1 ? "" : "s"} redirect.`,
      { detail: "A sitemap should list final addresses. Every redirect here is a page the crawler was told to visit and then sent away from.",
        evidence: redirected.slice(0, 5).map((r) => `${r.status} ${r.url}`) }));
  }

  const noindexed = rows.filter((r) => r.noindex);
  if (noindexed.length) {
    findings.push(finding("sitemap-noindex", "error",
      `${noindexed.length} sitemap URL${noindexed.length === 1 ? " is" : "s are"} marked noindex.`,
      { detail: "The sitemap asks a crawler to index the page and the page tells it not to. One of the two is wrong.",
        evidence: noindexed.slice(0, 5).map((r) => r.url) }));
  }

  const blockedByRobots = robots
    ? targets.filter((url) => !evaluate(robots, agent, url).allowed)
    : [];
  if (blockedByRobots.length) {
    findings.push(finding("sitemap-robots-blocked", "error",
      `${blockedByRobots.length} sitemap URL${blockedByRobots.length === 1 ? " is" : "s are"} disallowed in robots.txt.`,
      { evidence: blockedByRobots.slice(0, 5) }));
  }

  // --- Canonical consistency ---------------------------------------------------
  const notSelfCanonical = rows.filter((r) => {
    if (!r.canonical || r.status !== 200) return false;
    const norm = (u: string) => { try { const p = new URL(u); return p.origin + p.pathname.replace(/\/+$/, ""); } catch { return u; } };
    return norm(r.canonical) !== norm(r.url);
  });
  if (notSelfCanonical.length) {
    findings.push(finding("sitemap-canonical-mismatch", "warn",
      `${notSelfCanonical.length} page${notSelfCanonical.length === 1 ? "" : "s"} canonicalise somewhere other than themselves.`,
      { detail: "Listing a page in the sitemap and then pointing its canonical elsewhere asks a crawler to index it and to ignore it.",
        evidence: notSelfCanonical.slice(0, 5).map((r) => `${r.url} → ${r.canonical}`) }));
  }

  // --- Duplicate metadata ------------------------------------------------------
  const titleGroups = new Map<string, string[]>();
  const descGroups = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== 200) continue;
    if (row.title) {
      const key = row.title.trim().toLowerCase();
      titleGroups.set(key, [...(titleGroups.get(key) ?? []), row.url]);
    }
    if (row.description) {
      const key = row.description.trim().toLowerCase();
      descGroups.set(key, [...(descGroups.get(key) ?? []), row.url]);
    }
  }
  const dupTitles = [...titleGroups.entries()].filter(([, urls]) => urls.length > 1);
  if (dupTitles.length) {
    findings.push(finding("duplicate-titles", "warn",
      `${dupTitles.length} title${dupTitles.length === 1 ? " is" : "s are"} used by more than one page.`,
      { evidence: dupTitles.slice(0, 4).map(([title, urls]) => `"${title.slice(0, 50)}" — ${urls.length} pages`) }));
  }
  const dupDesc = [...descGroups.entries()].filter(([, urls]) => urls.length > 1);
  if (dupDesc.length) {
    findings.push(finding("duplicate-descriptions", "info",
      `${dupDesc.length} meta description${dupDesc.length === 1 ? " is" : "s are"} reused across pages.`));
  }

  // --- Pages that look identical ----------------------------------------------
  const shapes = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== 200 || !row.bodyHash) continue;
    shapes.set(row.bodyHash, [...(shapes.get(row.bodyHash) ?? []), row.url]);
  }
  const identical = [...shapes.values()].filter((urls) => urls.length > 2);
  if (identical.length) {
    findings.push(finding("pages-identical", "warn",
      `${identical.reduce((n, g) => n + g.length, 0)} pages share the same title and roughly the same length.`,
      { detail: "Either the routes genuinely duplicate each other, or the server is returning one page for many addresses.",
        evidence: identical.slice(0, 2).flatMap((g) => g.slice(0, 3)) }));
  }

  // --- Orphans and coverage ----------------------------------------------------
  const linked = new Set<string>();
  for (const row of rows) for (const link of row.links) {
    try { linked.add(new URL(link).origin + new URL(link).pathname.replace(/\/+$/, "")); } catch { /* ignored */ }
  }
  const orphans = rows.filter((r) => {
    if (r.status !== 200) return false;
    try {
      const key = new URL(r.url).origin + new URL(r.url).pathname.replace(/\/+$/, "");
      return !linked.has(key);
    } catch { return false; }
  });
  if (orphans.length) {
    findings.push(finding("orphan-pages", "warn",
      `${orphans.length} page${orphans.length === 1 ? " is" : "s are"} in the sitemap but linked from nowhere on the site.`,
      { detail: "A sitemap entry gets a page crawled. Internal links are what tell a search engine the page matters.",
        evidence: orphans.slice(0, 5).map((r) => r.url) }));
  }

  const sitemapSet = new Set(targets.map((u) => { try { const p = new URL(u); return p.origin + p.pathname.replace(/\/+$/, ""); } catch { return u; } }));
  const missing = [...linked].filter((l) => !sitemapSet.has(l));
  if (missing.length) {
    findings.push(finding("missing-from-sitemap", "info",
      `${missing.length} internally linked page${missing.length === 1 ? " is" : "s are"} absent from the sitemap.`,
      { evidence: missing.slice(0, 5) }));
  }

  const site: SiteReport = {
    sitemapUrl,
    urls: targets,
    checked: rows.length,
    pages: rows.map((r) => ({ url: r.url, findings: [], wordCount: r.wordCount, status: r.status })),
    findings,
  };

  return { site, findings };
}
