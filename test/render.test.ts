/**
 * The browser comparison, against a real browser.
 *
 * This is the headline feature and it had no test at all: everything else is
 * pure functions over fixtures, and the one path that shells out to Chrome was
 * covered by nothing. These skip when no browser is on the machine, so a
 * contributor without one still gets a green suite — CI runners have Chrome.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { analyse } from "../src/run.js";
import { renderCapability } from "../src/render.js";

const capability = await renderCapability();
const suite = capability.available ? describe : describe.skip;

const SPA = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme Analytics</title>
<meta name="description" content="Dashboards."></head>
<body>
<div id="root"></div>
<script>
  document.getElementById('root').innerHTML =
    '<nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav>' +
    '<main><h1>Real-time dashboards</h1><p>' +
    Array(80).fill('Acme turns an event stream into dashboards a whole team can read.').join(' ') +
    '</p></main>';
  var s = document.createElement('script');
  s.type = 'application/ld+json';
  s.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Acme" });
  document.head.appendChild(s);
</script>
</body></html>`;

const SERVER_RENDERED = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme Analytics</title>
<meta name="description" content="Dashboards.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head>
<body>
<nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav>
<main><h1>Real-time dashboards</h1><p>${
  Array(80).fill("Acme turns an event stream into dashboards a whole team can read.").join(" ")
}</p></main>
</body></html>`;

let server: Server;
let port = 0;
let mode: "spa" | "server" = "spa";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(mode === "spa" ? SPA : SERVER_RENDERED);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const run = (agents: string[]) =>
  analyse({ url: `http://127.0.0.1:${port}/`, agents, render: true, timeoutMs: 30_000 });

suite(`render (${capability.engine})`, () => {
  it("finds a browser without anything being installed for it", () => {
    expect(capability.available).toBe(true);
    expect(capability.detail).toBeTruthy();
  });

  it("reports a client-rendered page as invisible to every crawler", async () => {
    mode = "spa";
    const { report } = await run(["googlebot", "gptbot"]);
    const codes = report.findings.map((f) => f.code);

    expect(report.browser).not.toBeNull();
    expect(report.browser!.facts.wordCount).toBeGreaterThan(400);
    expect(codes).toContain("content-invisible");
    expect(codes).toContain("links-invisible");
    expect(codes).toContain("jsonld-client-only");
  }, 60_000);

  it("reports a server-rendered page as matching", async () => {
    mode = "server";
    const { report } = await run(["googlebot", "gptbot"]);
    const codes = report.findings.map((f) => f.code);

    expect(codes).toContain("content-match");
    expect(codes).not.toContain("content-invisible");
    expect(codes).not.toContain("links-invisible");
  }, 60_000);

  it("gives the browser the same text a crawler gets, once the page is prerendered", async () => {
    mode = "server";
    const { report } = await run(["googlebot"]);
    const bot = report.agents[0]!.facts!.wordCount;
    const browser = report.browser!.facts.wordCount;
    expect(Math.abs(bot - browser)).toBeLessThan(5);
  }, 60_000);

  it("carries on without the comparison when rendering is off", async () => {
    mode = "spa";
    const { report } = await analyse({
      url: `http://127.0.0.1:${port}/`, agents: ["googlebot"], render: false,
    });
    expect(report.browser).toBeNull();
    // Without a browser to compare against, the honest finding is that the
    // page is empty for everyone — not that something is being hidden.
    expect(report.findings.map((f) => f.code)).toContain("content-empty");
  }, 30_000);
});
