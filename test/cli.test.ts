/**
 * The command line contract.
 *
 * 324 lines with no coverage at all, and the part of it that matters most is
 * the exit code: that is the whole promise made to a pipeline. A wrong number
 * here either breaks every build or silently passes a broken deploy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";
import pc from "picocolors";

let server: Server;
let origin = "";
/** Set per test: what the page looks like to a crawler. */
let body = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      return;
    }
    if (req.url !== "/") {
      res.writeHead(404, { "content-type": "text/html" }).end("<html><body>gone</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs the CLI with stdout captured, so a test asserts on output rather than
 *  printing several screens of report for every case. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk); return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk); return true;
  });
  try {
    const code = await main(args);
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const CLEAN = `<html lang="en"><head><title>A clean page</title>
  <meta name="description" content="It has everything a crawler wants.">
  <link rel="canonical" href="https://example.com/"></head>
  <body><main><h1>A clean page</h1>
  <p>${"Readable body copy that a person can actually read. ".repeat(20)}</p>
  <a href="/a">a</a></main></body></html>`;

const BROKEN = `<html lang="en"><head><title>Broken</title>
  <link rel="canonical" href="http://localhost:3000/"></head>
  <body><main><h1>Broken</h1><p>${"Some copy. ".repeat(20)}</p></main></body></html>`;

afterEach(() => vi.restoreAllMocks());

describe("exit codes", () => {
  it("returns 0 without --ci, whatever it found", async () => {
    body = BROKEN;
    const { code } = await run([`${origin}/`, "-a", "googlebot", "--no-color"]);
    expect(code).toBe(0);
  }, 20_000);

  it("returns 1 under --ci when there is a problem", async () => {
    body = BROKEN;
    const { code } = await run([`${origin}/`, "-a", "googlebot", "--ci", "--no-color"]);
    expect(code).toBe(1);
  }, 20_000);

  it("returns 0 under --ci when there is not", async () => {
    body = CLEAN;
    const { code } = await run([`${origin}/`, "-a", "googlebot", "--ci", "--no-color"]);
    expect(code).toBe(0);
  }, 20_000);

  it("passes once the problem is ignored", async () => {
    body = BROKEN;
    const { code, out } = await run([
      `${origin}/`, "-a", "googlebot", "--ci", "--no-color",
      "--ignore", "canonical-localhost",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("suppressed by --ignore");
  }, 20_000);

  it("fails on a warning when told to", async () => {
    body = CLEAN;
    const clean = await run([`${origin}/`, "-a", "googlebot", "--ci", "--no-color"]);
    expect(clean.code).toBe(0);

    const strict = await run([
      `${origin}/`, "-a", "googlebot", "--ci", "--no-color", "--fail-on", "warn",
    ]);
    // The clean page still has warnings — no Open Graph, no hreflang.
    expect(strict.code).toBe(1);
  }, 20_000);

  it("refuses a --fail-on it does not understand", async () => {
    body = CLEAN;
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exited");
    }) as never);
    await expect(run([`${origin}/`, "--ci", "--fail-on", "sometimes"])).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(2);
  }, 20_000);
});

describe("output", () => {
  it("prints the table and the findings", async () => {
    body = BROKEN;
    const { out } = await run([`${origin}/`, "-a", "googlebot", "--no-color"]);
    expect(out).toContain("Googlebot");
    expect(out).toContain("canonical");
  }, 20_000);

  it("prints JSON and nothing else when asked", async () => {
    body = CLEAN;
    const { out } = await run([`${origin}/`, "-a", "googlebot", "--json"]);
    const data = JSON.parse(out);
    expect(data.tool).toBe("crawlview");
    expect(data.url).toBe(`${origin}/`);
  }, 20_000);

  it("writes the files it is asked for", async () => {
    body = CLEAN;
    const dir = await mkdtemp(path.join(tmpdir(), "crawlview-cli-"));
    const html = path.join(dir, "report.html");
    const md = path.join(dir, "report.md");
    await run([`${origin}/`, "-a", "googlebot", "--no-color", "--html", html, "--md", md]);
    expect(await readFile(html, "utf8")).toContain("<!doctype html>");
    expect(await readFile(md, "utf8")).toContain("## crawlview");
  }, 20_000);

  it("reads settings from a named config file", async () => {
    body = BROKEN;
    const dir = await mkdtemp(path.join(tmpdir(), "crawlview-cli-"));
    const cfg = path.join(dir, "crawlview.json");
    await writeFile(cfg, JSON.stringify({ ignore: ["canonical-localhost"] }), "utf8");
    const { code, out } = await run([
      `${origin}/`, "-a", "googlebot", "--ci", "--no-color", "--config", cfg,
    ]);
    expect(code).toBe(0);
    expect(out).toContain("suppressed by crawlview.json");
  }, 20_000);

  it("takes the crawler list from the config file", async () => {
    body = CLEAN;
    const dir = await mkdtemp(path.join(tmpdir(), "crawlview-cli-"));
    const cfg = path.join(dir, "crawlview.json");
    await writeFile(cfg, JSON.stringify({ agents: ["gptbot"] }), "utf8");
    const { out } = await run([`${origin}/`, "--no-color", "--config", cfg]);
    expect(out).toContain("GPTBot");
    expect(out).not.toContain("Googlebot");
  }, 20_000);

  /* Only provable where colour exists at all: picocolors turns itself off for
     a pipe, and then a broken --no-color looks identical to a working one.
     That is exactly how it shipped. */
  it.skipIf(!pc.isColorSupported)("strips colour when told to", async () => {
    body = CLEAN;
    const ESC = String.fromCharCode(27);
    const off = await run([`${origin}/`, "-a", "googlebot", "--no-color"]);
    const on = await run([`${origin}/`, "-a", "googlebot"]);
    expect(off.out.includes(ESC)).toBe(false);
    expect(on.out.includes(ESC)).toBe(true);
  }, 20_000);

  it("lists the crawlers it knows", async () => {
    const { code, out } = await run(["--list-agents", "--no-color"]);
    expect(code).toBe(0);
    expect(out).toContain("googlebot");
    expect(out).toContain("robots token only");
  });

  it("prints the version on its own", async () => {
    const { code, out } = await run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help and fails when given nothing to do", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(1);
    expect(out).toContain("crawlview");
    expect(out).toContain("--render");
  });
});
