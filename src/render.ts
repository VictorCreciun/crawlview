import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capture, RunOptions } from "./types.js";
import { BROWSER_UA } from "./agents.js";

const run = promisify(execFile);

/* Rendering is optional on purpose. `npx crawlview` has to start instantly, and
   a first run that downloads a browser is where most people stop. So: use
   Playwright if the project already has it, otherwise drive whatever Chrome is
   on the machine, and only ask for an install when neither exists. */

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => !!p);

/** Playwright keeps downloaded browsers in a shared cache outside any one
 *  project. A machine that has ever run Playwright for something else already
 *  has a usable Chromium, and borrowing it saves a 150 MB download for a
 *  comparison that takes two seconds. */
function playwrightCache(): string[] {
  const roots = process.platform === "darwin"
    ? [join(homedir(), "Library", "Caches", "ms-playwright")]
    : process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")]
      : [process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")];

  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Newest build number first: the directory names sort naturally.
    for (const entry of entries.filter((e) => e.startsWith("chromium")).sort().reverse()) {
      // The layout changed between Playwright versions, so both are tried.
      for (const suffix of [
        join("chrome-linux64", "chrome"),
        join("chrome-linux", "chrome"),
        join("chrome-headless-shell-linux64", "chrome-headless-shell"),
        join("chrome-linux", "headless_shell"),
        join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join("chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join("chrome-win", "chrome.exe"),
        join("chrome-win64", "chrome.exe"),
      ]) {
        found.push(join(root, entry, suffix));
      }
    }
  }
  return found;
}

export function findChrome(): string | null {
  return [...CANDIDATES, ...playwrightCache()].find((path) => existsSync(path)) ?? null;
}

/* Playwright is an optional peer dependency, so it must not be resolved at
   compile time. The specifier goes through a variable to keep the module
   graph free of it, and only the handful of calls we make are typed. */
interface PlaywrightLike {
  chromium: {
    launch(options?: { args?: string[] }): Promise<{
      newContext(options?: Record<string, unknown>): Promise<{
        addCookies(cookies: Record<string, unknown>[]): Promise<void>;
        newPage(): Promise<{
          goto(url: string, options?: Record<string, unknown>): Promise<{
            status(): number;
            allHeaders(): Promise<Record<string, string>>;
          } | null>;
          content(): Promise<string>;
          url(): string;
        }>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

const PLAYWRIGHT = "playwright";

async function loadPlaywright(): Promise<PlaywrightLike | null> {
  try {
    return (await import(PLAYWRIGHT)) as PlaywrightLike;
  } catch {
    return null;
  }
}

export interface RenderCapability {
  available: boolean;
  engine: "playwright" | "chrome" | null;
  detail: string;
}

export async function renderCapability(): Promise<RenderCapability> {
  if (await loadPlaywright()) {
    return { available: true, engine: "playwright", detail: "playwright" };
  }
  const chrome = findChrome();
  if (chrome) return { available: true, engine: "chrome", detail: chrome };
  return {
    available: false,
    engine: null,
    detail: "no browser found — install Playwright (npm i -D playwright && npx playwright install chromium) or set CHROME_PATH",
  };
}

async function renderWithPlaywright(url: string, opts: RunOptions): Promise<Capture> {
  const started = Date.now();
  const playwright = await loadPlaywright();
  if (!playwright) throw new Error("playwright is not installed");
  const { chromium } = playwright;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      ignoreHTTPSErrors: opts.insecure,
      extraHTTPHeaders: opts.headers,
      ...(opts.basicAuth
        ? {
            httpCredentials: {
              username: opts.basicAuth.split(":")[0] ?? "",
              password: opts.basicAuth.slice(opts.basicAuth.indexOf(":") + 1),
            },
          }
        : {}),
    });
    if (opts.cookies) {
      const { host } = new URL(url);
      await context.addCookies(
        opts.cookies.split(";").map((pair) => {
          const eq = pair.indexOf("=");
          return {
            name: pair.slice(0, eq).trim(),
            value: pair.slice(eq + 1).trim(),
            domain: host,
            path: "/",
          };
        }).filter((c) => c.name),
      );
    }
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs });
    const html = await page.content();
    const status = response?.status() ?? 0;
    return {
      agentId: "browser",
      requestedUrl: url,
      finalUrl: page.url(),
      status,
      ok: status >= 200 && status < 300,
      redirects: [],
      headers: response ? await response.allHeaders() : {},
      html,
      bytes: Buffer.byteLength(html),
      elapsedMs: Date.now() - started,
      rendered: true,
    };
  } finally {
    await browser.close();
  }
}

/** Drives an installed Chrome with --dump-dom. No WebSocket client, no
 *  protocol handling, and --virtual-time-budget makes it deterministic:
 *  the browser fast-forwards its own clock instead of us guessing a sleep. */
async function renderWithChrome(url: string, opts: RunOptions, binary: string): Promise<Capture> {
  const started = Date.now();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    `--user-agent=${BROWSER_UA}`,
    `--virtual-time-budget=${Math.min(opts.timeoutMs, 15000)}`,
    "--dump-dom",
  ];
  if (opts.insecure) args.push("--ignore-certificate-errors");

  let target = url;
  if (opts.basicAuth) {
    const parsed = new URL(url);
    const [user, ...rest] = opts.basicAuth.split(":");
    parsed.username = encodeURIComponent(user ?? "");
    parsed.password = encodeURIComponent(rest.join(":"));
    target = parsed.toString();
  }
  args.push(target);

  try {
    const { stdout } = await run(binary, args, {
      timeout: opts.timeoutMs + 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      agentId: "browser",
      requestedUrl: url,
      finalUrl: url,
      status: stdout.trim() ? 200 : 0,
      ok: !!stdout.trim(),
      redirects: [],
      headers: {},
      html: stdout,
      bytes: Buffer.byteLength(stdout),
      elapsedMs: Date.now() - started,
      rendered: true,
    };
  } catch (err) {
    return {
      agentId: "browser",
      requestedUrl: url,
      finalUrl: url,
      status: 0,
      ok: false,
      redirects: [],
      headers: {},
      html: "",
      bytes: 0,
      elapsedMs: Date.now() - started,
      rendered: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function render(url: string, opts: RunOptions): Promise<Capture> {
  const capability = await renderCapability();
  if (!capability.available) {
    throw new Error(capability.detail);
  }
  if (capability.engine === "playwright") return renderWithPlaywright(url, opts);
  return renderWithChrome(url, opts, capability.detail);
}
