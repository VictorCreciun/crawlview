import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/extract/html.js";
import { countWords, extractReadable } from "../src/extract/text.js";
import { baseLang, confusable, detectLanguage } from "../src/extract/language.js";
import * as cheerio from "cheerio/slim";

const BASE = "https://example.com/page";

describe("parseHtml", () => {
  it("pulls the facts a crawler would store", () => {
    const facts = parseHtml(`
      <html lang="en-GB">
      <head>
        <title>A page</title>
        <meta name="description" content="About a page.">
        <link rel="canonical" href="/canonical-target">
        <meta property="og:title" content="A page">
        <link rel="alternate" hreflang="ro" href="https://example.com/ro/page">
      </head>
      <body><main><h1>Heading</h1><p>Some words here.</p>
      <a href="/internal">in</a><a href="https://other.com/x">out</a></main></body>
      </html>`, BASE);

    expect(facts.title).toBe("A page");
    expect(facts.metaDescription).toBe("About a page.");
    expect(facts.canonical).toBe("https://example.com/canonical-target");
    expect(facts.htmlLang).toBe("en-GB");
    expect(facts.headings[0]).toMatchObject({ level: 1, text: "Heading" });
    expect(facts.openGraph.title).toBe("A page");
    expect(facts.hreflang).toEqual([{ lang: "ro", href: "https://example.com/ro/page" }]);
    expect(facts.links.filter((l) => l.internal)).toHaveLength(1);
    expect(facts.links.filter((l) => !l.internal)).toHaveLength(1);
  });

  it("reports an unrendered app as empty", () => {
    const facts = parseHtml(
      `<html><head><title>App</title></head><body><div id="root"></div>
       <script>window.__DATA__={a:1}</script></body></html>`, BASE);
    expect(facts.wordCount).toBe(0);
    expect(facts.headings).toHaveLength(0);
  });

  it("keeps a broken JSON-LD block instead of dropping it", () => {
    const facts = parseHtml(
      `<html><body><script type="application/ld+json">{"@type":"Thing",}</script></body></html>`, BASE);
    expect(facts.jsonLd).toHaveLength(1);
    expect(facts.jsonLd[0]!.error).toBeTruthy();
    expect(facts.jsonLd[0]!.types).toEqual([]);
  });

  it("finds types nested inside @graph", () => {
    const facts = parseHtml(
      `<html><body><script type="application/ld+json">
       {"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"x"},
       {"@type":["WebSite","Thing"],"name":"y"}]}</script></body></html>`, BASE);
    expect(facts.jsonLd[0]!.types.sort()).toEqual(["Organization", "Thing", "WebSite"]);
  });

  it("collects every robots meta variant", () => {
    const facts = parseHtml(
      `<html><head><meta name="robots" content="index,follow">
       <meta name="googlebot" content="noindex"></head><body>x</body></html>`, BASE);
    expect(facts.metaRobots).toHaveLength(2);
  });

  it("ignores fragment, mailto and javascript links", () => {
    const facts = parseHtml(
      `<html><body><a href="#a">a</a><a href="mailto:x@y.z">b</a>
       <a href="javascript:void(0)">c</a><a href="/real">d</a></body></html>`, BASE);
    expect(facts.links).toHaveLength(1);
  });
});

describe("countWords", () => {
  it("ignores punctuation-only tokens", () => {
    expect(countWords("one two — three")).toBe(3);
  });
  it("counts CJK characters individually", () => {
    expect(countWords("日本語のテキスト")).toBeGreaterThan(4);
  });
  it("returns zero for empty input", () => {
    expect(countWords("")).toBe(0);
  });
});

describe("extractReadable", () => {
  it("prefers <main> over navigation", () => {
    const $ = cheerio.load(`<body>
      <nav><a href="/a">Alpha</a><a href="/b">Beta</a><a href="/c">Gamma</a></nav>
      <main><p>${"The body copy carries the meaning of the page. ".repeat(12)}</p></main>
    </body>`);
    const { text } = extractReadable($);
    expect(text).toContain("body copy");
    expect(text).not.toContain("Alpha");
  });

  it("falls back to the densest block when there is no main", () => {
    const $ = cheerio.load(`<body>
      <div class="menu"><a href="/1">one</a><a href="/2">two</a></div>
      <div class="post"><p>${"Real sentences that a reader would actually read. ".repeat(12)}</p></div>
    </body>`);
    expect(extractReadable($).text).toContain("Real sentences");
  });
});

describe("detectLanguage", () => {
  it("declines to guess on a short string", () => {
    expect(detectLanguage("Salut").lang).toBeNull();
  });

  it("identifies a clear sample", () => {
    const romanian = "Acesta este un text scris în limba română care descrie pe larg ce face aplicația și de ce a fost construită astfel.";
    expect(detectLanguage(romanian).lang).toBe("ro");
  });

  it("normalises a region subtag", () => {
    expect(baseLang("ro-MD")).toBe("ro");
    expect(baseLang("EN")).toBe("en");
    expect(baseLang("not a tag")).toBeNull();
    expect(baseLang(null)).toBeNull();
  });

  it("knows which language pairs it cannot separate", () => {
    expect(confusable("hr", "sr")).toBe(true);
    expect(confusable("ro", "ru")).toBe(false);
  });
});
