/**
 * Tests written to close gaps the mutation check found.
 *
 * Each of these covers a behaviour the suite claimed to test and did not: the
 * mutation harness broke the code and every test still passed. They are kept
 * together because that is what they have in common — not the module they
 * touch, but the fact that the first hundred tests missed them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cheerio from "cheerio/slim";
import { evaluate, parseRobots } from "../src/robots.js";
import { agentById } from "../src/agents.js";
import { extractReadable, visibleText } from "../src/extract/text.js";
import { detectLanguage } from "../src/extract/language.js";
import { parseHtml } from "../src/extract/html.js";
import { checkStructured } from "../src/checks/structured.js";
import { capture } from "../src/fetch.js";
import { loadSitemap } from "../src/site/sitemap.js";
import { toSnapshot } from "../src/snapshot.js";
import { DEFAULT_OPTIONS } from "../src/run.js";
import type { AgentResult, Capture, PageReport, RunOptions } from "../src/types.js";

const URL_ = "https://example.com/page";
const opts = (over: Partial<RunOptions> = {}): RunOptions =>
  ({ ...DEFAULT_OPTIONS, url: URL_, agents: [], timeoutMs: 2000, ...over });

afterEach(() => vi.unstubAllGlobals());

function agentResult(html: string): AgentResult {
  const cap: Capture = {
    agentId: "googlebot", requestedUrl: URL_, finalUrl: URL_, status: 200, ok: true,
    redirects: [], headers: {}, html, bytes: html.length, elapsedMs: 1, rendered: false,
  };
  return {
    agent: agentById("googlebot")!,
    capture: cap,
    facts: parseHtml(html, URL_),
    robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null },
  };
}

function report(html: string): PageReport {
  return {
    url: URL_, startedAt: new Date().toISOString(), elapsedMs: 1,
    agents: [agentResult(html)], browser: null, findings: [],
    robotsTxt: null, llmsTxt: null,
  };
}

const codes = (items: { code: string }[]) => items.map((i) => i.code);
const prose = "Sentences a reader can see on the page. ".repeat(20);
const page = (body: string, head = "") =>
  `<html lang="en"><head><title>T</title><meta name="description" content="D">
   <link rel="canonical" href="${URL_}">${head}</head><body>${body}</body></html>`;

describe("robots.txt, gaps", () => {
  it("matches a robots token that is a prefix of the crawler's name", () => {
    // Google documents token matching as a case-insensitive prefix, so a file
    // that writes `User-agent: Google` governs Googlebot too.
    const robots = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: Google\nDisallow: /private");
    const verdict = evaluate(robots, agentById("googlebot")!, "https://e.com/private");
    expect(verdict.allowed).toBe(false);
    expect(verdict.matchedToken).toBe("google");
  });

  it("treats `Disallow:` with no value as a rule-free permission, not a typo", () => {
    const robots = parseRobots("User-agent: *\nDisallow:");
    expect(robots.groups[0]!.rules).toHaveLength(0);
    expect(robots.malformed).toHaveLength(0);
  });
});

describe("text extraction, gaps", () => {
  it("keeps text that lives inside a button", () => {
    // The accessible accordion puts every FAQ question in a <button>. Dropping
    // buttons from the visible text made the tool report a displayed FAQ as
    // markup describing nothing.
    const $ = cheerio.load(`<body><main>
      <button type="button">Cum obțin certificat românesc în Moldova?</button>
      <div><p>Contactați-ne pentru consultanță.</p></div>
    </main></body>`);
    expect(visibleText($)).toContain("Cum obțin certificat");
  });

  it("leaves buttons out of the article body, where they are not prose", () => {
    const $ = cheerio.load(`<body><div class="post">
      <p>${prose}</p><button type="button">Add to cart</button>
    </div></body>`);
    expect(extractReadable($).text).not.toContain("Add to cart");
  });

  it("does not let a bigger, link-heavy block win over the article", () => {
    /* The numbers matter, because scoring is length discounted by link density.
       The sidebar is deliberately larger than the article: 1800 characters of
       link text and 1200 of prose, a density of 0.6. Without the 0.5 cut-off
       its discounted score (3000 x 0.4 = 1200) beats the article's 900, and the
       extractor returns a navigation column as the page's content. A smaller
       or a purely-links block would prove nothing — it loses either way. */
    const links = Array.from({ length: 58 },
      (_, i) => `<a href="/c/${i}">Shop category link number ${String(i).padStart(2, "0")} xx</a>`).join("");
    const filler = "Sidebar blurb text. ".repeat(60);
    const article = "Sentences a reader can see on the page. ".repeat(23);

    const $ = cheerio.load(
      `<body><div class="menu">${links}${filler}</div>` +
      `<div class="post">${article}</div></body>`);

    const menuLen = $(".menu").text().trim().length;
    const linkLen = $(".menu").find("a").text().trim().length;
    const postLen = $(".post").text().trim().length;
    const density = linkLen / menuLen;
    expect(density).toBeGreaterThan(0.5);
    expect(menuLen * (1 - density)).toBeGreaterThan(postLen);

    const { text } = extractReadable($);
    expect(text).toContain("Sentences a reader can see");
    expect(text).not.toContain("Shop category link");
  });
});

describe("language detection, gaps", () => {
  it("refuses a sample too short to be reliable, even a recognisable one", () => {
    // Under the guard this is null. Without it, tinyld answers confidently on
    // forty characters, and a wrong language claim is worse than no claim.
    const short = "Это короткий текст на русском языке.";
    expect(short.length).toBeLessThan(60);
    expect(detectLanguage(short).lang).toBeNull();
  });

  it("answers once there is enough text", () => {
    const long = "Это достаточно длинный текст на русском языке, чтобы определение сработало надёжно.";
    expect(long.length).toBeGreaterThanOrEqual(60);
    expect(detectLanguage(long).lang).toBe("ru");
  });
});

describe("structured data, gaps", () => {
  it("reports a required property that is missing", () => {
    const html = page(`<main><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"Product","offers":{"@type":"Offer","price":"10","priceCurrency":"MDL"}}</script>`);
    const found = checkStructured(report(html));
    expect(codes(found)).toContain("jsonld-required-missing");
    expect(found.find((f) => f.code === "jsonld-required-missing")!.title).toContain("name");
  });

  it("accepts a value when most of its identifying words are on the page", () => {
    // Three of four tokens present: 0.75, over the 0.7 floor.
    const html = page(
      `<main><p>${prose}</p></main><footer><p>Alba Iulia 198, Chisinau</p></footer>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":{"@type":"PostalAddress",
        "streetAddress":"Alba Iulia 198 Botanica"}}</script>`);
    expect(codes(checkStructured(report(html)))).not.toContain("jsonld-unsupported-claim");
  });

  it("rejects a value when most of its words are missing", () => {
    // One of four tokens present: 0.25, under the floor.
    const html = page(
      `<main><p>${prose}</p></main><footer><p>Chisinau</p></footer>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":{"@type":"PostalAddress",
        "streetAddress":"Alba Iulia 198 Botanica"}}</script>`);
    expect(codes(checkStructured(report(html)))).toContain("jsonld-unsupported-claim");
  });

  it("ignores a priceRange band because it has no words to look for", () => {
    const html = page(`<main><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","priceRange":"$$"}</script>`);
    expect(codes(checkStructured(report(html)))).not.toContain("jsonld-unsupported-claim");
  });
});

describe("fetch, gaps", () => {
  it("asks for redirects to be handed back rather than followed", () => {
    // Following them inside fetch would hide the hops, and a server that sends
    // bots somewhere it does not send people is exactly what we came to see.
    let mode: string | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      mode = init.redirect;
      return new Response("<html><body>ok</body></html>", { status: 200 });
    });
    return capture({ url: URL_, ua: "x", agentId: "a" }, opts()).then(() => {
      expect(mode).toBe("manual");
    });
  });
});

describe("sitemap, gaps", () => {
  it("decodes escaped angle brackets in a location", () => {
    vi.stubGlobal("fetch", async () => new Response(
      "<urlset><url><loc>https://e.com/a?a=1&lt;2&amp;b=3&gt;4</loc></url></urlset>",
      { status: 200, headers: { "content-type": "application/xml" } }));
    return loadSitemap("https://e.com/sitemap.xml", opts()).then((r) => {
      expect(r.entries[0]!.loc).toBe("https://e.com/a?a=1<2&b=3>4");
    });
  });
});

describe("snapshot, gaps", () => {
  it("stores only the findings a regression could be measured against", () => {
    const base = report(page(`<main><p>${prose}</p></main>`));
    base.findings = [
      { code: "bad", severity: "error", title: "Something is wrong" },
      { code: "fine", severity: "ok", title: "Something is right" },
      { code: "note", severity: "info", title: "Something is worth knowing" },
    ];
    const snap = toSnapshot(base);
    expect(snap.findings.map((f) => f.code).sort()).toEqual(["bad", "note"]);
    expect(snap.findings.some((f) => f.severity === "ok")).toBe(false);
  });
});
