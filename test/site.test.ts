/**
 * Sitemap mode against a real server.
 *
 * The politeness rules cannot be checked with a stub: the point of a
 * crawl-delay is what the clock does, and a stubbed fetch has no clock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { crawlSite } from "../src/site/crawl.js";
import { DEFAULT_OPTIONS } from "../src/run.js";
import type { SiteOptions } from "../src/site/crawl.js";

const PAGES = ["/", "/one", "/two", "/three"];

let server: Server;
let origin = "";
let crawlDelay = 0;
let requests: string[] = [];

const html = (title: string) =>
  `<html lang="en"><head><title>${title}</title>
   <meta name="description" content="A page about ${title}.">
   <link rel="canonical" href="${origin}${title === "Home" ? "/" : `/${title.toLowerCase()}`}"></head>
   <body><main><h1>${title}</h1><p>${"Readable body copy for the page. ".repeat(20)}</p>
   ${PAGES.map((p) => `<a href="${p}">${p}</a>`).join("")}</main></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push(url);

    if (url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nAllow: /\n${crawlDelay ? `Crawl-delay: ${crawlDelay}\n` : ""}Sitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset>${
        PAGES.map((p) => `<url><loc>${origin}${p}</loc><lastmod>2026-0${PAGES.indexOf(p) + 1}-01</lastmod></url>`).join("")
      }</urlset>`);
      return;
    }
    if (!PAGES.includes(url)) {
      res.writeHead(404, { "content-type": "text/html" }).end("<html><body>gone</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(url === "/" ? "Home" : url.slice(1)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const options = (over: Partial<SiteOptions> = {}): SiteOptions => ({
  ...DEFAULT_OPTIONS,
  url: `${origin}/`,
  agents: ["googlebot"],
  limit: 50,
  sitemapUrl: null,
  agentId: "googlebot",
  ignoreCrawlDelay: false,
  timeoutMs: 5000,
  ...over,
});

describe("crawlSite", () => {
  it("finds the sitemap declared in robots.txt and walks it", async () => {
    crawlDelay = 0;
    const { site } = await crawlSite(options());
    expect(site.sitemapUrl).toBe(`${origin}/sitemap.xml`);
    expect(site.urls).toHaveLength(PAGES.length);
    expect(site.pages.every((p) => p.status === 200)).toBe(true);
  }, 20_000);

  it("obeys a crawl-delay declared in robots.txt", async () => {
    crawlDelay = 0.4;
    const started = Date.now();
    const { findings } = await crawlSite(options());
    const elapsed = Date.now() - started;

    expect(findings.map((f) => f.code)).toContain("crawl-delay-honoured");
    // Four pages, one every 400ms after the first: at least 1.2s of waiting.
    expect(elapsed).toBeGreaterThan(1000);
  }, 20_000);

  it("skips the delay when asked to", async () => {
    crawlDelay = 0.4;
    const started = Date.now();
    const { findings } = await crawlSite(options({ ignoreCrawlDelay: true }));
    const elapsed = Date.now() - started;

    expect(findings.map((f) => f.code)).not.toContain("crawl-delay-honoured");
    expect(elapsed).toBeLessThan(1000);
  }, 20_000);

  it("keeps an explicit delay when it is the slower of the two", async () => {
    crawlDelay = 0.05;
    const started = Date.now();
    const { findings } = await crawlSite(options({ delayMs: 400 }));
    expect(Date.now() - started).toBeGreaterThan(1000);
    // The site asked for less than we were already giving it, so there is
    // nothing to report: no rule was applied that the caller did not choose.
    expect(findings.map((f) => f.code)).not.toContain("crawl-delay-honoured");
  }, 20_000);

  it("reports pages that are in the sitemap and linked from nowhere", async () => {
    crawlDelay = 0;
    const { findings } = await crawlSite(options());
    // Every page links to every other here, so nothing is orphaned.
    expect(findings.map((f) => f.code)).not.toContain("orphan-pages");
  }, 20_000);

  it("runs the page checks on every page, not only the first", async () => {
    crawlDelay = 0;
    const { site } = await crawlSite(options());
    expect(site.pages).toHaveLength(PAGES.length);
    expect(site.pages.every((p) => Array.isArray(p.findings))).toBe(true);
  }, 20_000);

  it("says so when there is no sitemap to walk", async () => {
    crawlDelay = 0;
    const { findings, site } = await crawlSite(options({
      sitemapUrl: `${origin}/nothing-here.xml`,
    }));
    expect(findings.map((f) => f.code)).toContain("sitemap-missing");
    expect(site.urls).toHaveLength(0);
  }, 20_000);

  it("stops at the limit", async () => {
    crawlDelay = 0;
    requests = [];
    const { site } = await crawlSite(options({ limit: 2 }));
    expect(site.urls).toHaveLength(2);
    expect(requests.filter((u) => PAGES.includes(u))).toHaveLength(2);
  }, 20_000);
});
