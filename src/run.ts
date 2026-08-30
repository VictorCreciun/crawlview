import { AGENTS, BROWSER_UA, resolveAgents } from "./agents.js";
import { capture, fetchText, pool } from "./fetch.js";
import { parseHtml } from "./extract/html.js";
import { countWords } from "./extract/text.js";
import { evaluate, parseRobots, robotsUrl, type Robots } from "./robots.js";
import { render } from "./render.js";
import { checkBasics } from "./checks/basics.js";
import { checkDivergence } from "./checks/divergence.js";
import { checkStructured } from "./checks/structured.js";
import { checkLanguage } from "./checks/language.js";
import { checkAi } from "./checks/ai.js";
import { checkRobotsFile, checkRobotsPolicy } from "./checks/robotspolicy.js";
import { finding } from "./checks/util.js";
import type { AgentResult, Finding, PageReport, RunOptions } from "./types.js";

export const DEFAULT_OPTIONS: Omit<RunOptions, "url" | "agents"> = {
  render: false,
  timeoutMs: 20_000,
  concurrency: 4,
  headers: {},
  basicAuth: null,
  cookies: null,
  followRedirects: true,
  maxRedirects: 10,
  insecure: false,
  respectRobots: false,
  delayMs: 0,
  userAgentSuffix: null,
};

/** A URL on the same host that cannot exist. If it answers 200 with the same
 *  shape as a real page, the site has no 404 at all — every wrong address is
 *  a live page as far as a crawler is concerned. */
function probeUrl(url: string): string {
  const u = new URL(url);
  u.pathname = `/crawlview-404-probe-${Date.now().toString(36)}`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function detectSoft404(url: string, opts: RunOptions): Promise<Finding[]> {
  const probe = await capture({ url: probeUrl(url), ua: BROWSER_UA, agentId: "probe" }, opts);
  if (probe.error) return [];

  if (probe.status === 404 || probe.status === 410) {
    return [finding("notfound-correct", "ok", "Missing pages return 404.")];
  }
  if (probe.status >= 300 && probe.status < 400) {
    return [finding("notfound-redirect", "warn",
      `A URL that cannot exist redirects (${probe.status}) instead of returning 404.`,
      { detail: "Redirecting every unknown address to the homepage teaches a crawler that the site has no invalid URLs, and wastes its crawl budget on them." })];
  }
  if (probe.status === 200) {
    const facts = parseHtml(probe.html, probe.finalUrl);
    return [finding("soft-404", "error",
      "A URL that cannot exist returns 200.",
      { detail: "Classic SPA fallback: the server hands index.html to everything. Search engines call this a soft 404 — misspelled and stale links become indexable pages, and the real 404 never happens.",
        evidence: [`${probe.requestedUrl} → 200, ${countWords(facts.text)} words, title "${facts.title ?? "(none)"}"`] })];
  }
  return [];
}

export interface RunResult {
  report: PageReport;
  /** Non-fatal problems with the run itself, not with the page. */
  warnings: string[];
}

export async function analyse(options: Partial<RunOptions> & { url: string }): Promise<RunResult> {
  const warnings: string[] = [];
  const resolved = resolveAgents(options.agents ?? ["default"]);
  if (resolved.unknown.length) {
    warnings.push(`unknown agent${resolved.unknown.length > 1 ? "s" : ""}: ${resolved.unknown.join(", ")}`);
  }
  const agents = resolved.agents.length ? resolved.agents : AGENTS.filter((a) => a.id === "googlebot-mobile");

  const opts: RunOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    agents: agents.map((a) => a.id),
    headers: options.headers ?? {},
  };

  const startedAt = new Date().toISOString();
  const started = Date.now();

  // robots.txt and llms.txt first: they are site-level and both checks need them.
  const origin = new URL(opts.url).origin;
  const [robotsRes, llmsRes] = await Promise.all([
    fetchText(robotsUrl(opts.url), opts, BROWSER_UA),
    fetchText(`${origin}/llms.txt`, opts, BROWSER_UA),
  ]);

  let robots: Robots | null = null;
  if (robotsRes.status === 200 && robotsRes.body) {
    robots = parseRobots(robotsRes.body);
  }

  // One request per agent, capped and optionally spaced out.
  const fetchable = agents.filter((a) => a.ua !== null);
  const captures = await pool(fetchable, opts.concurrency, opts.delayMs, (agent) =>
    capture({ url: opts.url, ua: agent.ua, agentId: agent.id }, opts),
  );

  const results: AgentResult[] = agents.map((agent) => {
    const index = fetchable.indexOf(agent);
    const cap = index >= 0 ? captures[index]! : null;
    const facts = cap && !cap.error && cap.html ? parseHtml(cap.html, cap.finalUrl) : null;
    return {
      agent,
      capture: cap,
      facts,
      robots: evaluate(robots, agent, opts.url),
    };
  });

  let browser: PageReport["browser"] = null;
  if (opts.render) {
    try {
      const cap = await render(opts.url, opts);
      if (cap.error) warnings.push(`render failed: ${cap.error}`);
      else browser = { capture: cap, facts: parseHtml(cap.html, cap.finalUrl) };
    } catch (err) {
      warnings.push(`render unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const report: PageReport = {
    url: opts.url,
    startedAt,
    elapsedMs: 0,
    agents: results,
    browser,
    findings: [],
    robotsTxt: { url: robotsRes.finalUrl, status: robotsRes.status, body: robotsRes.body },
    llmsTxt: {
      url: `${origin}/llms.txt`,
      status: llmsRes.status,
      present: llmsRes.status === 200 && !!llmsRes.body && !/<html/i.test(llmsRes.body.slice(0, 200)),
    },
  };

  const findings: Finding[] = [
    ...checkRobotsPolicy(report),
    ...(robots ? checkRobotsFile(report, robots.malformed, robots.sitemaps) : []),
    ...checkDivergence(report),
    ...checkBasics(report),
    ...checkStructured(report),
    ...(await checkLanguage(report, opts)),
    ...checkAi(report),
    ...(await detectSoft404(opts.url, opts)),
  ];

  report.findings = rank(findings);
  report.elapsedMs = Date.now() - started;
  return { report, warnings };
}

const ORDER: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };

/** Collapses findings that say exactly the same thing. A page with seven
 *  identical nodes produced seven identical lines, which reads as seven
 *  problems when it is one. Evidence is merged so nothing is lost. */
function dedupe(findings: Finding[]): Finding[] {
  const groups = new Map<string, { item: Finding; count: number; evidence: string[] }>();
  for (const item of findings) {
    const key = `${item.code}\u0000${item.title}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      for (const line of item.evidence ?? []) {
        if (!existing.evidence.includes(line)) existing.evidence.push(line);
      }
    } else {
      groups.set(key, { item, count: 1, evidence: [...(item.evidence ?? [])] });
    }
  }
  return [...groups.values()].map(({ item, count, evidence }) => ({
    ...item,
    title: count > 1 ? `${item.title} (${count}\u00d7)` : item.title,
    ...(evidence.length ? { evidence: evidence.slice(0, 8) } : {}),
  }));
}

export function rank(findings: Finding[]): Finding[] {
  return dedupe(findings).sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));
}
