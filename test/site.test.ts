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

/**
 * The sitemap-level checks.
 *
 * Fifteen of them in 307 lines, and until now exactly one had a mutation
 * behind it. Each case here is a shape a real site takes: a stale entry, a
 * page that redirects, a noindex left on, a template producing the same title
 * everywhere, a page nothing links to.
 */
describe("sitemap findings", () => {
  let sut: Server;
  let base = "";

  /** What the server should be for a given test. */
  let plan: {
    urls: string[];
    status?: Record<string, number>;
    redirect?: Record<string, string>;
    noindex?: string[];
    title?: (url: string) => string;
    canonical?: (url: string) => string;
    links?: (url: string) => string[];
    lastmod?: string | null;
    offsite?: string[];
    duplicateEntries?: boolean;
    noH1?: boolean;
    /** Raw JSON-LD to serve, per URL. */
    jsonld?: Record<string, string>;
    /** Served with a 200 but deliberately left out of the sitemap. */
    extra?: string[];
  } = { urls: [] };

  beforeAll(async () => {
    sut = createServer((req, res) => {
      const url = req.url ?? "/";

      if (url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
        return;
      }
      if (url === "/sitemap.xml") {
        const listed = [
          ...plan.urls.map((u) => `${base}${u}`),
          ...(plan.offsite ?? []),
          ...(plan.duplicateEntries ? plan.urls.map((u) => `${base}${u}`) : []),
        ];
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><urlset>${listed.map((loc, i) =>
          `<url><loc>${loc}</loc>${
            plan.lastmod === null ? "" : `<lastmod>${plan.lastmod ?? `2026-01-${String((i % 28) + 1).padStart(2, "0")}`}</lastmod>`
          }</url>`).join("")}</urlset>`);
        return;
      }

      const to = plan.redirect?.[url];
      if (to) {
        res.writeHead(301, { location: to }).end();
        return;
      }
      const known = plan.urls.includes(url) || (plan.extra ?? []).includes(url);
      const status = plan.status?.[url] ?? (known ? 200 : 404);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "text/html" }).end("<html><body>no</body></html>");
        return;
      }

      const title = plan.title ? plan.title(url) : `Page ${url}`;
      const canonical = plan.canonical ? plan.canonical(url) : `${base}${url}`;
      const links = plan.links ? plan.links(url) : plan.urls;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html lang="en"><head><title>${title}</title>
        <meta name="description" content="${title} — the description a template would produce.">
        <link rel="canonical" href="${canonical}">
        ${plan.noindex?.includes(url) ? '<meta name="robots" content="noindex">' : ""}
        ${plan.jsonld?.[url] ? `<script type="application/ld+json">${plan.jsonld[url]}</script>` : ""}
        </head><body><main>${plan.noH1 ? "" : `<h1>${title}</h1>`}
        <p>${"Readable body copy that a person can actually read. ".repeat(15)}</p>
        ${links.map((l) => `<a href="${l}">${l}</a>`).join("")}
        </main></body></html>`);
    });
    await new Promise<void>((resolve) => sut.listen(0, "127.0.0.1", resolve));
    const address = sut.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => sut.close(() => resolve())));

  const run = async () => {
    const { findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${base}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    return findings.map((f) => f.code);
  };

  it("reports a sitemap entry that no longer exists", async () => {
    plan = { urls: ["/", "/a"], status: { "/a": 404 } };
    expect(await run()).toContain("sitemap-broken");
  }, 20_000);

  it("reports a sitemap entry that redirects", async () => {
    plan = { urls: ["/", "/old"], redirect: { "/old": "/" } };
    expect(await run()).toContain("sitemap-redirects");
  }, 20_000);

  it("reports a listed page that tells crawlers not to index it", async () => {
    plan = { urls: ["/", "/hidden"], noindex: ["/hidden"] };
    expect(await run()).toContain("sitemap-noindex");
  }, 20_000);

  it("reports a page that canonicalises somewhere else", async () => {
    plan = { urls: ["/", "/dup"], canonical: (u) => `${base}${u === "/dup" ? "/" : u}` };
    expect(await run()).toContain("sitemap-canonical-mismatch");
  }, 20_000);

  it("reports a title used by more than one page", async () => {
    plan = { urls: ["/", "/a", "/b"], title: () => "Welcome" };
    const found = await run();
    expect(found).toContain("duplicate-titles");
    expect(found).toContain("duplicate-descriptions");
  }, 20_000);

  it("reports pages nothing links to", async () => {
    plan = { urls: ["/", "/orphan"], links: () => ["/"] };
    expect(await run()).toContain("orphan-pages");
  }, 20_000);

  it("reports a sitemap entry on another host without fetching it", async () => {
    plan = { urls: ["/"], offsite: ["https://elsewhere.example/page"] };
    const { site, findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${base}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    expect(findings.map((f) => f.code)).toContain("sitemap-offsite");
    // Reported, not requested: nobody asked this tool to touch another domain
    // because an address turned up in somebody else's file.
    expect(site.urls).not.toContain("https://elsewhere.example/page");
    expect(site.urls).toEqual([`${base}/`]);
  }, 20_000);

  it("runs the page-level checks on every page in the crawl", async () => {
    plan = { urls: ["/", "/a"], noH1: true };
    const found = await run();
    // The heading check belongs to the single-page pass. Seeing it here proves
    // that pass runs for each crawled page rather than only the named one.
    expect(found).toContain("page:h1-missing");
    expect(found.find((c) => c === "page:h1-missing")).toBeDefined();
  }, 20_000);

  it("reports the same URL listed twice", async () => {
    plan = { urls: ["/", "/a"], duplicateEntries: true };
    expect(await run()).toContain("sitemap-duplicates");
  }, 20_000);

  it("notes a lastmod that is identical everywhere", async () => {
    plan = { urls: ["/", "/a", "/b", "/c", "/d", "/e"], lastmod: "2026-08-30" };
    expect(await run()).toContain("sitemap-lastmod-uniform");
  }, 20_000);

  it("reports several routes that are secretly the same page", async () => {
    plan = { urls: ["/", "/a", "/b", "/c"], title: () => "Same" };
    expect(await run()).toContain("pages-identical");
  }, 20_000);

  it("reports a page linked internally but absent from the sitemap", async () => {
    plan = { urls: ["/"], extra: ["/unlisted"], links: () => ["/", "/unlisted"] };
    const found = await run();
    expect(found).toContain("missing-from-sitemap");
    // It exists, so it is a note about the sitemap and nothing more.
    expect(found).not.toContain("internal-link-broken");
  }, 20_000);

  it("does not call a page unlisted just because --limit stopped short of it", async () => {
    /* The sitemap set was built from the pages this run had room to fetch, so
       any limit below the sitemap's size — the default on a real site — turned
       the remainder into "linked but unlisted", and then into suspected dead
       links that got requested one by one. */
    plan = { urls: ["/", "/a", "/b", "/c"] };
    const { findings, site } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${base}/`, agents: ["googlebot"], limit: 2,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    expect(site.urls).toHaveLength(2);
    const codes = findings.map((f) => f.code);
    expect(codes).not.toContain("missing-from-sitemap");
    expect(codes).not.toContain("internal-link-broken");
  }, 20_000);

  it("reports an internal link that leads nowhere", async () => {
    /* A page nobody listed is usually fine; a page linked from the site that
       answers 404 is not, and the two used to be reported together as one
       shrug. Every internal link is a promise the site makes about itself. */
    plan = { urls: ["/"], links: () => ["/", "/gone-for-good"] };
    const found = await run();
    expect(found).toContain("internal-link-broken");
  }, 20_000);

  it("does not lend one page's numbers to the whole group", async () => {
    /* Grouping by problem showed the first page's counts as though they
       described every page in the group — "23 items, 11 missing" standing in
       for pages ranging from 13 and 1 to 30 and 24. Where the pages differ,
       the headline drops the numbers and each page carries its own. */
    plan = {
      urls: ["/", "/a", "/b"],
      jsonld: {
        "/a": '{"@context":"https://schema.org","@type":"Product","image":"i","description":"d","offers":{"@type":"Offer","price":"1","priceCurrency":"MDL"}}',
        "/b": '{"@context":"https://schema.org","@type":"Event","name":"Concert"}',
      },
    };
    const { findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${base}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    const grouped = findings.find((f) => f.code === "page:jsonld-required-missing")!;
    expect(grouped).toBeDefined();
    // One page is missing `name`, the other `startDate` and `location`.
    // Neither list may stand in for the group.
    expect(grouped.title).not.toContain("name");
    expect(grouped.title).not.toContain("startDate");
    const evidence = grouped.evidence!.join(" ");
    expect(evidence).toContain("name");
    expect(evidence).toContain("startDate");
  }, 20_000);

  it("keeps the wording when every page says the same thing", async () => {
    plan = { urls: ["/", "/a"], noH1: true };
    const { findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${base}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    const grouped = findings.find((f) => f.code === "page:h1-missing")!;
    expect(grouped.title).toContain("No <h1> on the page.");
    // Identical across the group, so the evidence stays a plain list of URLs.
    expect(grouped.evidence!.every((e) => e.startsWith("http"))).toBe(true);
  }, 20_000);

  it("stays quiet on a site with none of these problems", async () => {
    plan = { urls: ["/", "/a", "/b"] };
    const found = await run();
    for (const code of ["sitemap-broken", "sitemap-redirects", "sitemap-noindex",
                        "sitemap-canonical-mismatch", "duplicate-titles", "orphan-pages",
                        "sitemap-offsite", "sitemap-duplicates", "pages-identical"]) {
      expect(found).not.toContain(code);
    }
  }, 20_000);
});

/**
 * An apex that redirects to www.
 *
 * The sitemap is served from the host it redirects to and lists that host's
 * addresses, which is correct. Comparing them against the address someone
 * typed declared every entry to be on another host and then checked nothing:
 * a real run reported "646 sitemap entries are on another host" and "0 URLs
 * checked", with the site perfectly healthy.
 */
describe("a site that lives on another hostname", () => {
  let apex: Server;
  let www: Server;
  let apexBase = "";
  let wwwBase = "";

  const page = (path: string, host: string) =>
    `<html lang="en"><head><title>Page ${path}</title>
     <meta name="description" content="About ${path}.">
     <link rel="canonical" href="${host}${path}"></head>
     <body><main><h1>Page ${path}</h1>
     <p>${"Body copy a reader can see. ".repeat(20)}</p>
     <a href="${host}/">home</a><a href="${host}/a">a</a></main></body></html>`;

  beforeAll(async () => {
    www = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/robots.txt") {
        /* Deliberately no Sitemap line. The tool then guesses from the address
           it was given — the apex — and only the redirect tells it where the
           file, and so the site, actually is. With a declaration here the test
           would pass whether or not that resolution worked. */
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      if (url === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><urlset>${
          ["/", "/a"].map((p) => `<url><loc>${wwwBase}${p}</loc></url>`).join("")
        }</urlset>`);
        return;
      }
      if (url !== "/" && url !== "/a") {
        res.writeHead(404, { "content-type": "text/html" }).end("<html><body>no</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(url, wwwBase));
    });
    await new Promise<void>((r) => www.listen(0, "127.0.0.1", r));
    const wa = www.address();
    wwwBase = `http://127.0.0.1:${typeof wa === "object" && wa ? wa.port : 0}`;

    // Everything here is a permanent redirect onto the other host.
    apex = createServer((req, res) => {
      res.writeHead(301, { location: `${wwwBase}${req.url ?? "/"}` }).end();
    });
    await new Promise<void>((r) => apex.listen(0, "127.0.0.1", r));
    const aa = apex.address();
    apexBase = `http://127.0.0.1:${typeof aa === "object" && aa ? aa.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => www.close(() => r()));
    await new Promise<void>((r) => apex.close(() => r()));
  });

  it("follows the redirect and checks the pages that are really there", async () => {
    const { site, findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${apexBase}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: null, agentId: "googlebot", ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    expect(site.sitemapUrl).toBe(`${wwwBase}/sitemap.xml`);
    expect(site.urls).toHaveLength(2);
    expect(site.pages.every((p) => p.status === 200)).toBe(true);
    // The sitemap lists its own host, which is what a sitemap is for.
    expect(findings.map((f) => f.code)).not.toContain("sitemap-offsite");
  }, 20_000);

  it("still reports an entry that is genuinely elsewhere", async () => {
    // Same run, but the sitemap also names a host it has no business listing.
    const { findings } = await crawlSite({
      ...DEFAULT_OPTIONS, url: `${apexBase}/`, agents: ["googlebot"], limit: 50,
      sitemapUrl: `${wwwBase}/sitemap.xml`, agentId: "googlebot",
      ignoreCrawlDelay: true, timeoutMs: 5000,
    });
    expect(findings.map((f) => f.code)).not.toContain("sitemap-offsite");
  }, 20_000);
});
