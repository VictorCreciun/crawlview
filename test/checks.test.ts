import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/extract/html.js";
import { checkStructured } from "../src/checks/structured.js";
import { checkBasics } from "../src/checks/basics.js";
import { checkDivergence } from "../src/checks/divergence.js";
import { checkAi } from "../src/checks/ai.js";
import { agentById } from "../src/agents.js";
import type { AgentResult, Capture, PageReport } from "../src/types.js";

const URL_ = "https://example.com/page";

function capture(html: string, extra: Partial<Capture> = {}): Capture {
  return {
    agentId: "googlebot", requestedUrl: URL_, finalUrl: URL_, status: 200, ok: true,
    redirects: [], headers: {}, html, bytes: html.length, elapsedMs: 10, rendered: false, ...extra,
  };
}

function agentResult(id: string, html: string, extra: Partial<Capture> = {}): AgentResult {
  const cap = capture(html, { agentId: id, ...extra });
  return {
    agent: agentById(id)!,
    capture: cap,
    facts: cap.error ? null : parseHtml(html, cap.finalUrl),
    robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null },
  };
}

function report(agents: AgentResult[], browserHtml?: string): PageReport {
  return {
    url: URL_, startedAt: new Date().toISOString(), elapsedMs: 1, agents,
    browser: browserHtml
      ? { capture: capture(browserHtml, { agentId: "browser", rendered: true }), facts: parseHtml(browserHtml, URL_) }
      : null,
    findings: [],
    robotsTxt: { url: "https://example.com/robots.txt", status: 200, body: "User-agent: *\nAllow: /" },
    llmsTxt: { url: "https://example.com/llms.txt", status: 404, present: false },
  };
}

const codes = (items: { code: string }[]) => items.map((i) => i.code);
const prose = "Words that a person can read on the page. ".repeat(20);
const page = (body: string, head = "") =>
  `<html lang="en"><head><title>T</title><meta name="description" content="D">
   <link rel="canonical" href="${URL_}">${head}</head><body>${body}</body></html>`;

describe("checkStructured", () => {
  it("flags a claim the page never shows", () => {
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","telephone":"+37360000000"}</script>`);
    const found = checkStructured(report([agentResult("googlebot", html)]));
    expect(codes(found)).toContain("jsonld-unsupported-claim");
  });

  it("accepts a phone number that lives in the footer", () => {
    // The article extractor throws footers away, and a footer is where a phone
    // number nearly always is. Checking the extracted body accused three real
    // sites of hiding a number they displayed on every page.
    const html = page(
      `<main><h1>H</h1><p>${prose}</p></main>
       <footer><p>TELEFON: +373 78 800 989</p></footer>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","telephone":"+37378800989"}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .not.toContain("jsonld-unsupported-claim");
  });

  it("accepts an address the page abbreviates", () => {
    const html = page(
      `<main><h1>H</h1><p>${prose}</p></main>
       <footer><p>str. Alba Iulia 198, Chisinau</p></footer>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":{"@type":"PostalAddress",
        "streetAddress":"Strada Alba Iulia 198"}}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .not.toContain("jsonld-unsupported-claim");
  });

  it("does not treat a priceRange band as a claim", () => {
    // "$$" is schema.org notation for a band. No page has ever printed it.
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","priceRange":"$$"}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .not.toContain("jsonld-unsupported-claim");
  });

  it("still flags a price band given as a figure the page never shows", () => {
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","priceRange":"450-900 MDL"}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .toContain("jsonld-unsupported-claim");
  });

  it("accepts a claim the page does show", () => {
    const html = page(`<main><h1>H</h1><p>Call us on +373 60 000 000 any weekday. ${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"LocalBusiness","name":"X","address":"a","telephone":"+37360000000"}</script>`);
    const found = checkStructured(report([agentResult("googlebot", html)]));
    expect(codes(found)).not.toContain("jsonld-unsupported-claim");
  });

  it("rejects a rating with nothing to rate", () => {
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"128"}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .toContain("aggregaterating-unsupported");
  });

  it("catches a rating outside its own scale", () => {
    const html = page(`<main><p>Our reviews: rated 9 by readers. ${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"AggregateRating","ratingValue":9,"bestRating":5,"reviewCount":3}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)]))))
      .toContain("rating-out-of-range");
  });

  it("does not demand a price from a service offer catalogue", () => {
    const html = page(`<main><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"Organization","name":"X","url":"https://example.com","logo":"l","sameAs":["s"],
        "hasOfferCatalog":{"@type":"OfferCatalog","name":"Services",
        "itemListElement":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Web"}}]}}</script>`);
    const found = checkStructured(report([agentResult("googlebot", html)]));
    expect(codes(found)).not.toContain("offer-no-price");
    expect(codes(found)).not.toContain("jsonld-required-missing");
  });

  it("does demand a price from a product offer", () => {
    const html = page(`<main><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"Product","name":"Thing","offers":{"@type":"Offer","availability":"InStock"}}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)])))).toContain("offer-no-price");
  });

  it("reports a block that does not parse", () => {
    const html = page("<p>x</p>", `<script type="application/ld+json">{oops}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)])))).toContain("jsonld-invalid");
  });

  it("catches breadcrumbs numbered out of order", () => {
    const html = page(`<main><p>${prose}</p></main>`,
      `<script type="application/ld+json">
       {"@type":"BreadcrumbList","itemListElement":[
        {"@type":"ListItem","position":1,"name":"Home"},
        {"@type":"ListItem","position":3,"name":"Here"}]}</script>`);
    expect(codes(checkStructured(report([agentResult("googlebot", html)])))).toContain("breadcrumb-positions");
  });
});

describe("checkBasics", () => {
  it("finds a canonical pointing at localhost", () => {
    const html = `<html lang="en"><head><title>T</title>
      <link rel="canonical" href="http://localhost:3000/page"></head><body><h1>H</h1></body></html>`;
    expect(codes(checkBasics(report([agentResult("googlebot", html)])))).toContain("canonical-localhost");
  });

  it("prefers the header when it contradicts the meta tag", () => {
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`, `<meta name="robots" content="index,follow">`);
    const result = agentResult("googlebot", html, { headers: { "x-robots-tag": "noindex" } });
    const found = codes(checkBasics(report([result])));
    expect(found).toContain("noindex-header");
    expect(found).toContain("robots-conflict");
  });

  it("notices a heading level that skips a step", () => {
    const html = page(`<main><h1>A</h1><h4>B</h4><p>${prose}</p></main>`);
    expect(codes(checkBasics(report([agentResult("googlebot", html)])))).toContain("heading-skip");
  });

  it("stays quiet on a page that is put together correctly", () => {
    const html = page(`<main><h1>A</h1><h2>B</h2><p>${prose}</p></main>`);
    const found = checkBasics(report([agentResult("googlebot", html)]));
    expect(found.filter((f) => f.severity === "error")).toHaveLength(0);
  });
});

describe("checkDivergence", () => {
  const shell = `<html lang="en"><head><title>T</title></head><body><div id="root"></div></body></html>`;
  const full = page(`<main><h1>H</h1><p>${prose}</p><a href="/next">next</a></main>`,
    `<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>`);

  it("reports a page that only exists after rendering", () => {
    const found = codes(checkDivergence(report([agentResult("gptbot", shell), agentResult("googlebot", shell)], full)));
    expect(found).toContain("content-invisible");
    expect(found).toContain("jsonld-client-only");
    expect(found).toContain("links-invisible");
  });

  it("passes a prerendered page", () => {
    const found = codes(checkDivergence(report([agentResult("gptbot", full), agentResult("googlebot", full)], full)));
    expect(found).toContain("content-match");
    expect(found).not.toContain("content-invisible");
  });

  it("reports a page that is partly, not wholly, invisible", () => {
    /* The middle case: the crawler gets real content, just less of it. Neither
       "identical" nor "empty" — and the only finding whose wording depends on
       the percentage rather than on a yes or no. */
    const trimmed = page(`<main><h1>H</h1><p>${"Half the sentences survive. ".repeat(9)}</p></main>`);
    const whole = page(`<main><h1>H</h1><p>${"Half the sentences survive. ".repeat(30)}</p></main>`);
    const found = checkDivergence(report([agentResult("googlebot", trimmed)], whole));
    expect(codes(found)).toContain("content-reduced");
    expect(codes(found)).not.toContain("content-invisible");
    expect(codes(found)).not.toContain("content-match");
    expect(found.find((f) => f.code === "content-reduced")!.title).toMatch(/\d+% of the browser/);
  });

  it("calls out a status that differs between crawlers", () => {
    const found = codes(checkDivergence(report([
      agentResult("googlebot", full),
      agentResult("gptbot", "", { status: 403, ok: false }),
    ], full)));
    expect(found).toContain("status-divergence");
    expect(found).toContain("crawler-blocked");
  });

  it("separates crawlers that render from crawlers that do not", () => {
    const found = codes(checkDivergence(report([agentResult("googlebot", full), agentResult("gptbot", shell)], full)));
    expect(found).toContain("content-partial");
  });
});

describe("checkAi", () => {
  it("says so when AI crawlers get nothing", () => {
    const shell = `<html lang="en"><head><title>T</title></head><body><div id="root"></div></body></html>`;
    const full = page(`<main><h1>H</h1><p>${prose}</p></main>`);
    expect(codes(checkAi(report([agentResult("gptbot", shell)], full)))).toContain("ai-sees-nothing");
  });

  it("notes a page with nothing to attribute", () => {
    const html = page(`<main><h1>H</h1><p>${prose}</p></main>`);
    expect(codes(checkAi(report([agentResult("gptbot", html)])))).toContain("citability-weak");
  });
});
