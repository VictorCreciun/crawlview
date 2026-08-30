import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyIgnores, loadConfig } from "../src/config.js";
import { checkStructured } from "../src/checks/structured.js";
import { parseHtml } from "../src/extract/html.js";
import { agentById } from "../src/agents.js";
import type { Capture, Finding, PageReport } from "../src/types.js";

const URL_ = "https://example.com/page";
const f = (code: string, severity: Finding["severity"] = "error"): Finding =>
  ({ code, severity, title: code });

async function tempConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crawlview-"));
  const file = path.join(dir, "crawlview.json");
  await writeFile(file, contents, "utf8");
  return file;
}

describe("loadConfig", () => {
  it("reads settings from a named file", async () => {
    const file = await tempConfig(JSON.stringify({
      ignore: ["og-absent"], agents: ["ai"], failOn: "warn", minText: 85,
    }));
    const { config, path: found } = await loadConfig(file);
    expect(config).toEqual({ ignore: ["og-absent"], agents: ["ai"], failOn: "warn", minText: 85 });
    expect(found).toBe(file);
  });

  it("returns an empty config when there is no file to find", async () => {
    const { config, path: found } = await loadConfig();
    expect(config.ignore).toEqual([]);
    // Whether a file is discovered depends on the working directory; either
    // way the shape has to be usable.
    expect(found === null || typeof found === "string").toBe(true);
  });

  it("refuses a named file that does not parse, rather than ignoring it", async () => {
    const file = await tempConfig("{ not json");
    await expect(loadConfig(file)).rejects.toThrow(/not valid JSON/);
  });

  it("refuses a file holding something other than an object", async () => {
    const file = await tempConfig('["og-absent"]');
    await expect(loadConfig(file)).rejects.toThrow(/must contain a JSON object/);
  });

  it("drops values of the wrong type instead of trusting them", async () => {
    const file = await tempConfig(JSON.stringify({
      ignore: ["ok", 42, null], failOn: "sometimes", minText: "80",
    }));
    const { config } = await loadConfig(file);
    expect(config.ignore).toEqual(["ok"]);
    expect(config.failOn).toBeUndefined();
    expect(config.minText).toBeUndefined();
  });

  it("throws when a named file is missing, so a typo is not silently accepted", async () => {
    await expect(loadConfig("/nonexistent/crawlview.json")).rejects.toThrow();
  });
});

describe("applyIgnores", () => {
  it("keeps everything when nothing is ignored", () => {
    const items = [f("a"), f("b")];
    expect(applyIgnores(items, []).kept).toHaveLength(2);
  });

  it("separates the suppressed rather than dropping them", () => {
    const { kept, ignored } = applyIgnores([f("a"), f("b"), f("c")], ["b"]);
    expect(kept.map((x) => x.code)).toEqual(["a", "c"]);
    expect(ignored.map((x) => x.code)).toEqual(["b"]);
  });

  it("suppresses a sitemap-mode finding through its base code", () => {
    // Sitemap mode prefixes page-level codes, and nobody should have to know
    // that to write an ignore entry.
    const { kept, ignored } = applyIgnores([f("page:og-absent"), f("og-absent")], ["og-absent"]);
    expect(kept).toHaveLength(0);
    expect(ignored).toHaveLength(2);
  });

  it("does not let a prefix match by accident", () => {
    const { kept } = applyIgnores([f("og-absent-elsewhere")], ["og-absent"]);
    expect(kept).toHaveLength(1);
  });

  it("ignores blank entries", () => {
    expect(applyIgnores([f("a")], ["", "  "]).kept).toHaveLength(1);
  });
});

describe("ItemList against the page", () => {
  function report(html: string): PageReport {
    const cap: Capture = {
      agentId: "googlebot", requestedUrl: URL_, finalUrl: URL_, status: 200, ok: true,
      redirects: [], headers: {}, html, bytes: html.length, elapsedMs: 1, rendered: false,
    };
    return {
      url: URL_, startedAt: new Date().toISOString(), elapsedMs: 1,
      agents: [{ agent: agentById("googlebot")!, capture: cap, facts: parseHtml(html, URL_),
                 robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null } }],
      browser: null, findings: [], robotsTxt: null, llmsTxt: null,
    };
  }

  const products = (names: string[]) => JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: names.map((name, i) => ({
      "@type": "ListItem", position: i + 1,
      item: { "@type": "Product", name, offers: { "@type": "Offer", price: String(100 + i), priceCurrency: "MDL" } },
    })),
  });

  const page = (visible: string[], marked: string[]) =>
    `<html lang="en"><head><title>Category</title><meta name="description" content="D">
     <link rel="canonical" href="${URL_}">
     <script type="application/ld+json">${products(marked)}</script></head>
     <body><main><h1>Category</h1>
     ${visible.map((n) => `<article><h2>${n}</h2><span>${100 + marked.indexOf(n)} MDL</span></article>`).join("")}
     </main></body></html>`;

  const all = ["Dashcam AZDOME M330", "Dashcam AZDOME M550", "Camera 4K 360 grade",
               "Modulator FM auto", "Repeater WiFi 1200"];

  it("names the gap when the markup lists more than the grid renders", () => {
    const found = checkStructured(report(page(all.slice(0, 3), all)));
    const item = found.find((x) => x.code === "itemlist-not-on-page");
    expect(item).toBeDefined();
    expect(item!.title).toContain("5 items");
    expect(item!.title).toContain("2 of them");
  });

  it("stays quiet when every marked item is on the page", () => {
    const found = checkStructured(report(page(all, all)));
    expect(found.map((x) => x.code)).not.toContain("itemlist-not-on-page");
  });

  it("does not also report each missing price separately", () => {
    // One problem, one line. Listing six unfamiliar prices alongside it says
    // nothing about where to look.
    const found = checkStructured(report(page(all.slice(0, 3), all)));
    expect(found.map((x) => x.code)).not.toContain("jsonld-unsupported-claim");
  });

  it("still reports a claim outside any flagged list", () => {
    const html = `<html lang="en"><head><title>T</title>
      <script type="application/ld+json">${products(all)}</script>
      <script type="application/ld+json">
      {"@type":"LocalBusiness","name":"X","address":"a","telephone":"+37360000000"}</script>
      </head><body><main>${all.map((n) => `<p>${n}</p>`).join("")}</main></body></html>`;
    expect(checkStructured(report(html)).map((x) => x.code)).toContain("jsonld-unsupported-claim");
  });

  it("says more than half when most of the list is missing", () => {
    const found = checkStructured(report(page(all.slice(0, 1), all)));
    const item = found.find((x) => x.code === "itemlist-not-on-page")!;
    expect(item.detail).toContain("More than half");
  });

  it("leaves a short list alone, where a difference proves nothing", () => {
    const found = checkStructured(report(page(["Only one"], ["Only one", "Another"])));
    expect(found.map((x) => x.code)).not.toContain("itemlist-not-on-page");
  });

  it("leaves a long list alone when almost none of it is named", () => {
    /* Two guards look alike and are not: one counts entries, the other counts
       entries carrying a name. A list of five items where three have no name
       clears the first and has to be stopped by the second — comparing two
       names against a page says nothing about either. */
    const html = `<html lang="en"><head><title>T</title>
      <link rel="canonical" href="${URL_}">
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Named one" } },
          { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "Named two" } },
          { "@type": "ListItem", position: 3, item: { "@type": "Product", sku: "no-name-a" } },
          { "@type": "ListItem", position: 4, item: { "@type": "Product", sku: "no-name-b" } },
          { "@type": "ListItem", position: 5, item: { "@type": "Product", sku: "no-name-c" } },
        ],
      })}</script></head><body><main><h1>Category</h1><p>Nothing matching here.</p></main></body></html>`;
    expect(checkStructured(report(html)).map((x) => x.code)).not.toContain("itemlist-not-on-page");
  });
});
