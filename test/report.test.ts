import { describe, expect, it } from "vitest";
import { renderTerminal } from "../src/report/terminal.js";
import { toHtml } from "../src/report/html.js";
import { toMarkdown } from "../src/report/markdown.js";
import { toJson } from "../src/report/json.js";
import { parseHtml } from "../src/extract/html.js";
import { agentById } from "../src/agents.js";
import pc from "picocolors";
import type { Capture, PageReport } from "../src/types.js";

const URL_ = "https://example.com/page";
const ESC = String.fromCharCode(27);

const html = (body: string) =>
  `<html lang="en"><head><title>A page</title><meta name="description" content="D">
   <link rel="canonical" href="${URL_}"></head><body>${body}</body></html>`;

function cap(source: string, over: Partial<Capture> = {}): Capture {
  return {
    agentId: "googlebot", requestedUrl: URL_, finalUrl: URL_, status: 200, ok: true,
    redirects: [], headers: {}, html: source, bytes: source.length, elapsedMs: 12,
    rendered: false, ...over,
  };
}

function report(over: Partial<PageReport> = {}): PageReport {
  const full = html(`<main><h1>Heading</h1><p>${"Body copy that a reader sees. ".repeat(20)}</p></main>`);
  const shell = html(`<div id="root"></div>`);
  return {
    url: URL_, startedAt: "2026-08-30T10:00:00.000Z", elapsedMs: 1234,
    agents: [
      { agent: agentById("googlebot-mobile")!, capture: cap(shell, { agentId: "googlebot-mobile" }),
        facts: parseHtml(shell, URL_),
        robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null } },
      { agent: agentById("gptbot")!, capture: cap(shell, { agentId: "gptbot" }),
        facts: parseHtml(shell, URL_),
        robots: { matchedToken: "gptbot", allowed: false, decidingRule: "Disallow: /", crawlDelay: null } },
      { agent: agentById("google-extended")!, capture: null, facts: null,
        robots: { matchedToken: "google-extended", allowed: true, decidingRule: null, crawlDelay: null } },
    ],
    browser: { capture: cap(full, { agentId: "browser", rendered: true }), facts: parseHtml(full, URL_) },
    findings: [
      { code: "content-invisible", severity: "error", title: "Nothing is stored.",
        detail: "The page is built in the browser.", evidence: ["gptbot: 0 words"] },
      { code: "og-absent", severity: "warn", title: "No Open Graph tags." },
      { code: "llms-txt-absent", severity: "info", title: "No /llms.txt." },
      { code: "robots-allows-all", severity: "ok", title: "robots.txt allows every crawler checked." },
    ],
    robotsTxt: { url: "https://example.com/robots.txt", status: 200, body: "User-agent: *" },
    llmsTxt: { url: "https://example.com/llms.txt", status: 404, present: false },
    ...over,
  };
}

describe("renderTerminal", () => {
  const plain = (r: PageReport, verbose = false) => renderTerminal(r, { color: false, verbose });

  it("lists one row per crawler plus the browser", () => {
    const out = plain(report());
    expect(out).toContain("Googlebot (mobile)");
    expect(out).toContain("GPTBot");
    expect(out).toContain("browser (rendered)");
  });

  it("shows a robots-only token without inventing a status for it", () => {
    const line = plain(report()).split("\n").find((l) => l.includes("Google-Extended"))!;
    expect(line).toContain("allow");
    expect(line).not.toMatch(/\b200\b/);
  });

  it("hides notes until asked, and says how many are hidden", () => {
    const out = plain(report());
    expect(out).not.toContain("No /llms.txt.");
    expect(out).toMatch(/2 more notes/);
    expect(plain(report(), true)).toContain("No /llms.txt.");
  });

  it("prints problems before warnings", () => {
    const out = plain(report());
    expect(out.indexOf("Nothing is stored.")).toBeLessThan(out.indexOf("No Open Graph tags."));
  });

  /* Only provable when colour is on. picocolors decides that at import time
     and turns itself off for a pipe, which is every local run — so without the
     guard this reads as a passing test while proving nothing, and that is how
     the broken --no-color shipped. CI and the mutation harness both force
     colour, so the check does run where it counts. */
  it.skipIf(!pc.isColorSupported)("emits no escape codes when colour is off", () => {
    expect(plain(report()).includes(ESC)).toBe(false);
    // And the same report with colour on must contain them, or the assertion
    // above is measuring an environment rather than the code.
    expect(renderTerminal(report(), { color: true, verbose: false }).includes(ESC)).toBe(true);
  });

  it("says so plainly when there is nothing to report", () => {
    const clean = report({ findings: [{ code: "ok", severity: "ok", title: "fine" }] });
    expect(plain(clean)).toContain("Nothing broken.");
  });

  it("names the sitemap and the count in site mode", () => {
    const withSite = report({
      site: { sitemapUrl: "https://example.com/sitemap.xml", urls: ["a", "b"], checked: 2,
              pages: [{ url: "a", findings: [], wordCount: 10, status: 200 },
                      { url: "b", findings: [], wordCount: 10, status: 200 }], findings: [] },
    });
    const out = plain(withSite);
    expect(out).toContain("https://example.com/sitemap.xml");
    expect(out).toContain("2 URLs checked");
  });
});

describe("toHtml", () => {
  it("produces one standalone document with the findings in it", () => {
    const out = toHtml(report(), { brand: false });
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<style>");
    expect(out).toContain("Nothing is stored.");
    expect(out).not.toContain("<script");
  });

  it("escapes markup coming from the page it audited", () => {
    const nasty = report({
      findings: [{ code: "x", severity: "error", title: '<img src=x onerror="alert(1)">' }],
    });
    const out = toHtml(nasty, { brand: false });
    expect(out).toContain("&lt;img src=x");
    expect(out).not.toContain("<img src=x");
  });

  it("keeps the studio out of the report unless asked", () => {
    expect(toHtml(report(), { brand: false })).not.toContain("services@coresmith.dev");
    expect(toHtml(report(), { brand: true })).toContain("services@coresmith.dev");
  });

  it("tells a search engine not to index the report itself", () => {
    expect(toHtml(report(), { brand: false })).toContain('name="robots" content="noindex"');
  });
});

describe("toMarkdown", () => {
  it("renders a table and the findings", () => {
    const out = toMarkdown(report());
    expect(out).toContain("| Crawler |");
    expect(out).toContain("### Problems");
    expect(out).toContain("Nothing is stored.");
  });

  it("neutralises backticks in evidence so the table survives", () => {
    const out = toMarkdown(report({
      findings: [{ code: "x", severity: "error", title: "t", evidence: ["a `b` c"] }],
    }));
    expect(out).toContain("`a 'b' c`");
  });
});

describe("toJson", () => {
  it("summarises counts and keeps every finding", () => {
    const data = JSON.parse(toJson(report()));
    expect(data.summary).toEqual({ errors: 1, warnings: 1, notes: 1, passed: 1 });
    expect(data.findings).toHaveLength(4);
    expect(data.tool).toBe("crawlview");
  });

  it("leaves the raw HTML out of the artefact", () => {
    expect(toJson(report())).not.toContain("<html");
  });

  it("carries the per-agent robots verdict", () => {
    const data = JSON.parse(toJson(report()));
    const gpt = data.agents.find((a: { id: string }) => a.id === "gptbot");
    expect(gpt.robots.allowed).toBe(false);
    expect(gpt.robots.decidingRule).toBe("Disallow: /");
  });
});
