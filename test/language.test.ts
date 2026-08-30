/**
 * The language checks.
 *
 * 129 lines carrying one of the three findings this tool exists for — a
 * translated route that declares one language and serves another — and it had
 * no mutation coverage at all. The suite said 71/71 while the check that found
 * a real bug on a live site was verified by nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLanguage } from "../src/checks/language.js";
import { parseHtml } from "../src/extract/html.js";
import { agentById } from "../src/agents.js";
import { DEFAULT_OPTIONS } from "../src/run.js";
import type { Capture, PageReport, RunOptions } from "../src/types.js";

const opts: RunOptions = { ...DEFAULT_OPTIONS, url: "https://e.com/", agents: [], timeoutMs: 2000 };

/* Every hreflang alternate is fetched, so a test without a stub reaches for
   the real network and waits out the timeout. Three of these took two seconds
   each and would fail on a machine with no route out. The default answers 404;
   the tests that care about a body install their own. */
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("nothing", { status: 404 }));
});
afterEach(() => vi.unstubAllGlobals());

function report(html: string, url = "https://e.com/page"): PageReport {
  const cap: Capture = {
    agentId: "googlebot", requestedUrl: url, finalUrl: url, status: 200, ok: true,
    redirects: [], headers: {}, html, bytes: html.length, elapsedMs: 1, rendered: false,
  };
  return {
    url, startedAt: new Date().toISOString(), elapsedMs: 1,
    agents: [{ agent: agentById("googlebot")!, capture: cap, facts: parseHtml(html, url),
               robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null } }],
    browser: null, findings: [], robotsTxt: null, llmsTxt: null,
  };
}

const codes = async (r: PageReport) => (await checkLanguage(r, opts)).map((f) => f.code);

const RO = "Acesta este un text scris în limba română care descrie pe larg serviciile oferite și modul în care se desfășoară colaborarea cu fiecare client în parte.";
const RU = "Это достаточно длинный текст на русском языке, который подробно описывает предлагаемые услуги и порядок работы с каждым клиентом отдельно.";
const EN = "This is a reasonably long passage of English prose describing the services on offer and how the work proceeds with each client in turn.";

const page = (lang: string, body: string, head = "") =>
  `<html lang="${lang}"><head><title>T</title>${head}</head>
   <body><main><h1>H</h1><p>${body.repeat(3)}</p></main></body></html>`;

describe("declared language against the text", () => {
  it("catches a route serving the wrong language behind a correct tag", async () => {
    // The bug this check was written for: /ru renders the default copy, the
    // attribute and the URL both say Russian, and every translation ends up
    // with the same word count.
    const found = await codes(report(page("ru", RO), "https://e.com/ru/page"));
    expect(found).toContain("lang-mismatch");
  });

  it("stays quiet when the tag and the text agree", async () => {
    expect(await codes(report(page("ru", RU), "https://e.com/ru/page"))).not.toContain("lang-mismatch");
    expect(await codes(report(page("ro", RO), "https://e.com/ro/page"))).not.toContain("lang-mismatch");
    expect(await codes(report(page("en", EN)))).not.toContain("lang-mismatch");
  });

  it("ignores a region subtag", async () => {
    expect(await codes(report(page("ro-MD", RO)))).not.toContain("lang-mismatch");
  });

  it("does not accuse on a pair the detector cannot separate", async () => {
    // Romanian and Moldovan are the same language under two tags; a detector
    // disagreeing there says nothing about the page.
    expect(await codes(report(page("mo", RO)))).not.toContain("lang-mismatch");
  });

  it("reports a missing lang attribute", async () => {
    const html = `<html><head><title>T</title></head><body><main><p>${EN}</p></main></body></html>`;
    expect(await codes(report(html))).toContain("lang-missing");
  });

  it("reports a lang attribute that is not a language tag", async () => {
    expect(await codes(report(page("english", EN)))).toContain("lang-invalid");
  });

  it("notices a URL promising a language the page does not declare", async () => {
    const found = await codes(report(page("en", EN), "https://e.com/ro/page"));
    expect(found).toContain("lang-path-mismatch");
  });

  it("asks for hreflang on a language-scoped URL that has none", async () => {
    const found = await codes(report(page("ro", RO), "https://e.com/ro/page"));
    expect(found).toContain("hreflang-absent");
  });
});

describe("hreflang", () => {
  const withAlternates = (links: string, lang = "en", url = "https://e.com/page") =>
    report(page(lang, EN, `<link rel="canonical" href="${url}">${links}`), url);

  it("reports a set that does not include the page itself", async () => {
    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="ro" href="https://e.com/ro/page">`));
    expect(found).toContain("hreflang-no-self");
  });

  it("reports the same language declared twice", async () => {
    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="ro" href="https://e.com/ro/page">
       <link rel="alternate" hreflang="ro" href="https://e.com/ro/other">`));
    expect(found).toContain("hreflang-duplicate");
  });

  it("reports a value that is not a language tag", async () => {
    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="romanian" href="https://e.com/ro/page">`));
    expect(found).toContain("hreflang-invalid");
  });

  it("notes a missing x-default", async () => {
    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="en" href="https://e.com/page">`));
    expect(found).toContain("hreflang-no-xdefault");
  });

  it("fetches each alternate and reports one that does not link back", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      // The alternate names only itself, so the pair is one-way.
      `<html lang="ro"><head><link rel="alternate" hreflang="ro" href="https://e.com/ro/page"></head><body>x</body></html>`,
      { status: 200, headers: { "content-type": "text/html" } }));

    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="en" href="https://e.com/page">
       <link rel="alternate" hreflang="ro" href="https://e.com/ro/page">
       <link rel="alternate" hreflang="x-default" href="https://e.com/page">`));
    expect(found).toContain("hreflang-not-reciprocal");
  });

  it("passes a set where every alternate links back", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      `<html lang="ro"><head>
        <link rel="alternate" hreflang="en" href="https://e.com/page">
        <link rel="alternate" hreflang="ro" href="https://e.com/ro/page">
       </head><body>x</body></html>`,
      { status: 200, headers: { "content-type": "text/html" } }));

    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="en" href="https://e.com/page">
       <link rel="alternate" hreflang="ro" href="https://e.com/ro/page">
       <link rel="alternate" hreflang="x-default" href="https://e.com/page">`));
    expect(found).toContain("hreflang-reciprocal");
    expect(found).not.toContain("hreflang-not-reciprocal");
  });

  it("reports an alternate that does not load", async () => {
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    const found = await codes(withAlternates(
      `<link rel="alternate" hreflang="en" href="https://e.com/page">
       <link rel="alternate" hreflang="ro" href="https://e.com/ro/page">`));
    expect(found).toContain("hreflang-unreachable");
  });
});
