import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSitemap } from "../src/site/sitemap.js";
import { DEFAULT_OPTIONS } from "../src/run.js";
import type { RunOptions } from "../src/types.js";

const opts: RunOptions = { ...DEFAULT_OPTIONS, url: "https://e.com/", agents: [] };
const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

afterEach(() => vi.unstubAllGlobals());

describe("loadSitemap", () => {
  it("reads locations and lastmod from a urlset", async () => {
    vi.stubGlobal("fetch", async () => xml(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://e.com/</loc><lastmod>2026-01-02</lastmod></url>
        <url><loc>https://e.com/about</loc></url>
      </urlset>`));
    const r = await loadSitemap("https://e.com/sitemap.xml", opts);
    expect(r.entries).toEqual([
      { loc: "https://e.com/", lastmod: "2026-01-02" },
      { loc: "https://e.com/about", lastmod: null },
    ]);
  });

  it("follows a sitemap index one level down", async () => {
    vi.stubGlobal("fetch", async (u: string) => {
      if (u.endsWith("index.xml")) return xml(`<sitemapindex>
        <sitemap><loc>https://e.com/a.xml</loc></sitemap>
        <sitemap><loc>https://e.com/b.xml</loc></sitemap>
      </sitemapindex>`);
      return xml(`<urlset><url><loc>${u.replace(".xml", "-page")}</loc></url></urlset>`);
    });
    const r = await loadSitemap("https://e.com/index.xml", opts);
    expect(r.entries.map((e) => e.loc)).toEqual(["https://e.com/a-page", "https://e.com/b-page"]);
    expect(r.sources).toHaveLength(3);
  });

  it("refuses to recurse forever through a self-referencing index", async () => {
    vi.stubGlobal("fetch", async () => xml(
      `<sitemapindex><sitemap><loc>https://e.com/index.xml</loc></sitemap></sitemapindex>`));
    const r = await loadSitemap("https://e.com/index.xml", opts);
    expect(r.entries).toHaveLength(0);
    expect(r.errors.some((e) => /too deep/i.test(e))).toBe(true);
  });

  it("accepts the plain-text sitemap format", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      "https://e.com/one\nhttps://e.com/two\n\n# a comment\n",
      { status: 200, headers: { "content-type": "text/plain" } }));
    const r = await loadSitemap("https://e.com/sitemap.txt", opts);
    expect(r.entries.map((e) => e.loc)).toEqual(["https://e.com/one", "https://e.com/two"]);
  });

  it("unwraps CDATA and entities in a location", async () => {
    vi.stubGlobal("fetch", async () => xml(`<urlset>
      <url><loc><![CDATA[https://e.com/a?x=1&y=2]]></loc></url>
      <url><loc>https://e.com/b?x=1&amp;y=2</loc></url>
    </urlset>`));
    const r = await loadSitemap("https://e.com/sitemap.xml", opts);
    expect(r.entries.map((e) => e.loc)).toEqual([
      "https://e.com/a?x=1&y=2", "https://e.com/b?x=1&y=2",
    ]);
  });

  it("records a sitemap that does not exist rather than pretending it is empty", async () => {
    vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }));
    const r = await loadSitemap("https://e.com/sitemap.xml", opts);
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]).toContain("404");
  });

  it("survives a sitemap served as HTML by a catch-all route", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      "<html><body><div id=root></div></body></html>",
      { status: 200, headers: { "content-type": "text/html" } }));
    const r = await loadSitemap("https://e.com/sitemap.xml", opts);
    expect(r.entries).toHaveLength(0);
  });

  it("ignores namespace prefixes on the url elements", async () => {
    vi.stubGlobal("fetch", async () => xml(
      `<urlset><url><loc>https://e.com/x</loc><xhtml:link rel="alternate" hreflang="ro" href="https://e.com/ro/x"/></url></urlset>`));
    const r = await loadSitemap("https://e.com/sitemap.xml", opts);
    expect(r.entries.map((e) => e.loc)).toEqual(["https://e.com/x"]);
  });
});
