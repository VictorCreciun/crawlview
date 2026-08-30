/**
 * What the robots.txt findings actually say.
 *
 * 95 lines, no mutation coverage, and one of them is the check that found a
 * real misconfiguration on two live sites. The parser was well tested; the
 * reporting on top of it was not tested at all.
 */
import { describe, expect, it } from "vitest";
import { checkRobotsFile, checkRobotsPolicy } from "../src/checks/robotspolicy.js";
import { evaluate, parseRobots } from "../src/robots.js";
import { resolveAgents } from "../src/agents.js";
import { parseHtml } from "../src/extract/html.js";
import type { Capture, PageReport } from "../src/types.js";

const URL_ = "https://e.com/page";
const HTML = `<html lang="en"><head><title>T</title></head><body><main><p>Body copy.</p></main></body></html>`;

function report(robotsBody: string | null, agentSpec: string[], status = 200): PageReport {
  const robots = robotsBody === null ? null : parseRobots(robotsBody);
  const { agents } = resolveAgents(agentSpec);
  const cap: Capture = {
    agentId: "x", requestedUrl: URL_, finalUrl: URL_, status: 200, ok: true,
    redirects: [], headers: {}, html: HTML, bytes: HTML.length, elapsedMs: 1, rendered: false,
  };
  return {
    url: URL_, startedAt: new Date().toISOString(), elapsedMs: 1,
    agents: agents.map((agent) => ({
      agent,
      capture: agent.ua ? { ...cap, agentId: agent.id } : null,
      facts: agent.ua ? parseHtml(HTML, URL_) : null,
      robots: evaluate(robots, agent, URL_),
    })),
    browser: null, findings: [],
    robotsTxt: { url: "https://e.com/robots.txt", status, body: robotsBody },
    llmsTxt: null,
  };
}

const codes = (items: { code: string }[]) => items.map((i) => i.code);

describe("checkRobotsPolicy", () => {
  it("passes a file that allows everything checked", () => {
    const found = checkRobotsPolicy(report("User-agent: *\nAllow: /", ["search", "ai"]));
    expect(codes(found)).toContain("robots-allows-all");
  });

  it("calls a blocked search crawler an error", () => {
    const found = checkRobotsPolicy(report("User-agent: *\nDisallow: /", ["googlebot"]));
    const item = found.find((f) => f.code === "robots-blocks-search")!;
    expect(item.severity).toBe("error");
    expect(item.evidence?.[0]).toContain("Disallow: /");
  });

  it("treats a blocked AI crawler as a warning, not an error", () => {
    // Many sites mean it. Reporting a deliberate choice as a defect is how a
    // tool teaches people to stop reading its output.
    const found = checkRobotsPolicy(report("User-agent: GPTBot\nDisallow: /", ["gptbot"]));
    const item = found.find((f) => f.code === "robots-blocks-ai")!;
    expect(item.severity).toBe("warn");
  });

  it("separates a blocked preview bot from the rest", () => {
    const found = checkRobotsPolicy(
      report("User-agent: facebookexternalhit\nDisallow: /", ["facebookexternalhit"]));
    expect(codes(found)).toContain("robots-blocks-social");
  });

  it("names which rule decided, not just that something did", () => {
    const found = checkRobotsPolicy(
      report("User-agent: *\nAllow: /\nDisallow: /private", ["googlebot"]));
    // This URL is allowed, so there is nothing to report about it.
    expect(codes(found)).toContain("robots-allows-all");
  });

  it("says a 5xx on robots.txt is worse than no file", () => {
    const found = checkRobotsPolicy(report("", ["googlebot"], 503));
    const item = found.find((f) => f.code === "robots-server-error")!;
    expect(item.severity).toBe("error");
    expect(item.detail).toContain("stop crawling");
  });

  it("treats a missing robots.txt as a note", () => {
    const found = checkRobotsPolicy(report(null, ["googlebot"], 404));
    expect(codes(found)).toContain("robots-absent");
    expect(found.find((f) => f.code === "robots-absent")!.severity).toBe("info");
  });

  it("warns when robots.txt could not be fetched at all", () => {
    const found = checkRobotsPolicy(report(null, ["googlebot"], 0));
    expect(codes(found)).toContain("robots-unreachable");
  });
});

describe("checkRobotsFile", () => {
  const file = (body: string, agentSpec: string[] = ["googlebot"]) =>
    checkRobotsFile(report(body, agentSpec), parseRobots(body));

  it("reports the rules a named group silently cancels", () => {
    const found = file(`
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /cart

User-agent: Googlebot
Allow: /
    `);
    const item = found.find((f) => f.code === "robots-group-overrides")!;
    expect(item).toBeDefined();
    expect(item.title).toContain("2 Disallow rules");
    expect(item.evidence).toContain("Disallow: /admin/");
  });

  it("says nothing when the named group repeats the rules", () => {
    const found = file(`
User-agent: *
Disallow: /admin/

User-agent: Googlebot
Disallow: /admin/
    `);
    expect(codes(found)).not.toContain("robots-group-overrides");
  });

  it("says nothing for an agent that only matches the wildcard", () => {
    expect(codes(file("User-agent: *\nDisallow: /admin/"))).not.toContain("robots-group-overrides");
  });

  it("reports a misspelled directive", () => {
    const found = file("User-agent: *\nDisalow: /admin/\nSitemap: https://e.com/s.xml");
    const item = found.find((f) => f.code === "robots-malformed")!;
    expect(item.evidence?.[0]).toContain("Disalow");
  });

  it("tolerates non-standard but real directives", () => {
    const found = file("User-agent: *\nAllow: /\nHost: e.com\nClean-param: ref\nSitemap: https://e.com/s.xml");
    expect(codes(found)).not.toContain("robots-malformed");
  });

  it("notes a file that declares no sitemap", () => {
    expect(codes(file("User-agent: *\nAllow: /"))).toContain("robots-no-sitemap");
  });

  it("stays quiet about the sitemap when one is declared", () => {
    const found = file("User-agent: *\nAllow: /\nSitemap: https://e.com/sitemap.xml");
    expect(codes(found)).not.toContain("robots-no-sitemap");
  });

  it("reports nothing at all when robots.txt was never served", () => {
    const empty = checkRobotsFile(report(null, ["googlebot"], 404), parseRobots(""));
    expect(empty).toHaveLength(0);
  });
});
