#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import pc from "picocolors";
import { AGENTS, DEFAULT_AGENT_IDS } from "./agents.js";
import { analyse, DEFAULT_OPTIONS, rank } from "./run.js";
import { crawlSite } from "./site/crawl.js";
import { renderCapability } from "./render.js";
import { renderTerminal } from "./report/terminal.js";
import { toJson } from "./report/json.js";
import { toHtml } from "./report/html.js";
import { toMarkdown } from "./report/markdown.js";
import { diffSnapshot, readSnapshot, writeSnapshot } from "./snapshot.js";
import { applyIgnores, loadConfig } from "./config.js";
import type { RunOptions } from "./types.js";

/* Same trap as the renderer: createColors returns a new object and leaves the
   module untouched, so --no-color has to be threaded rather than switched on.
   The help text is a function for the same reason — built at import time it
   would bake in whatever picocolors decided before the flags were parsed. */
type Ink = Omit<typeof pc, "createColors" | "isColorSupported">;
const PLAIN: Ink = pc.createColors(false);

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const help = (ink: Ink) => `
${pc.bold("crawlview")} — see what search engines and AI crawlers actually store

  ${pc.dim("$")} crawlview <url> [options]

${pc.bold("What it does")}
  Requests the page once as each crawler, compares what comes back, and — with
  --render — compares all of it against a real browser. Reports what a machine
  can and cannot see, and why.

${pc.bold("Options")}
  -a, --agents <list>    Crawlers to check. Ids or groups: search, ai, social,
                         all, default. ${pc.dim(`(default: ${DEFAULT_AGENT_IDS.length} common ones)`)}
  -r, --render           Also load the page in a browser and diff the two.
                         Uses Playwright if installed, otherwise system Chrome.
  -s, --sitemap          Site mode: walk the sitemap and check it as a whole.
      --sitemap-url <u>  Use this sitemap instead of discovering one.
  -l, --limit <n>        Pages to check in site mode. ${pc.dim("(default: 50)")}

  -v, --verbose          Show notes and passing checks too.
      --json             Machine-readable output, on stdout.
      --html <file>      Standalone HTML report.
      --md <file>        Markdown, for an issue or a PR comment.
      --brand            Add studio identity to the HTML report.

      --ignore <codes>   Finding codes to suppress, comma separated.
      --config <file>    Settings file. Otherwise crawlview.json is used if
                         it sits in the working directory.
      --fail-on <level>  What --ci treats as failure: error (default) or warn.

      --snapshot <file>  Write a baseline to compare against later.
      --diff <file>      Compare this run against a baseline and report changes.
      --ci               Exit non-zero when anything is a problem.
      --min-text <pct>   In --ci, fail when a crawler sees less than this share
                         of the browser's text. ${pc.dim("(default: 60)")}

  -H, --header <k: v>    Extra request header. Repeatable.
      --auth <user:pass> HTTP basic auth.
      --cookie <string>  Cookie header, for pages behind a session.
      --timeout <ms>     Per-request timeout. ${pc.dim("(default: 20000)")}
      --concurrency <n>  Parallel requests. ${pc.dim("(default: 4)")}
      --delay <ms>       Pause between requests. ${pc.dim("(default: 0)")}
      --insecure         Do not verify TLS certificates.
      --no-color         Plain output.

      --list-agents      Print every crawler this knows about.
  -h, --help             This text.
      --version          Print the version.

${pc.bold("Examples")}
  ${pc.dim("$")} crawlview https://example.com --render
  ${pc.dim("$")} crawlview https://example.com -a ai --verbose
  ${pc.dim("$")} crawlview https://example.com --sitemap --limit 200
  ${pc.dim("$")} crawlview https://example.com --html audit.html --brand
  ${pc.dim("$")} crawlview https://example.com --render --ci --min-text 80

${pc.dim("crawlview sends each crawler's real user-agent string, because that is what")}
${pc.dim("the server answers on. It respects nothing else about being a bot: one")}
${pc.dim("request per agent, and --delay if you want it slower.")}
`;

function fail(message: string): never {
  process.stderr.write(`${pc.red("crawlview:")} ${message}\n`);
  process.exit(2);
}

function normaliseUrl(input: string): string {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(candidate).toString();
  } catch {
    fail(`not a usable URL: ${input}`);
  }
}

/* Flags that read as `--no-x`. Node's parseArgs has no notion of negation: it
   sees an unknown option and throws, so `--no-color` and `--no-crawl-delay`
   both failed with "Unknown option" while being documented in the help text
   and the README. They are lifted out of the arguments here and turned into
   plain false values. */
const NEGATABLE = new Set(["color", "crawl-delay"]);

function liftNegations(argv: string[]): { args: string[]; negated: Set<string> } {
  const negated = new Set<string>();
  const args: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (arg === "--") passthrough = true;
    const match = passthrough ? null : /^--no-([a-z][a-z-]*)$/.exec(arg);
    if (match && NEGATABLE.has(match[1]!)) negated.add(match[1]!);
    else args.push(arg);
  }
  return { args, negated };
}

export async function main(argv: string[]): Promise<number> {
  const { args: cleanArgs, negated } = liftNegations(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: cleanArgs,
      allowPositionals: true,
      options: {
        agents: { type: "string", short: "a" },
        render: { type: "boolean", short: "r", default: false },
        sitemap: { type: "boolean", short: "s", default: false },
        "sitemap-url": { type: "string" },
        limit: { type: "string", short: "l" },
        verbose: { type: "boolean", short: "v", default: false },
        json: { type: "boolean", default: false },
        html: { type: "string" },
        md: { type: "string" },
        brand: { type: "boolean", default: false },
        snapshot: { type: "string" },
        diff: { type: "string" },
        ci: { type: "boolean", default: false },
        ignore: { type: "string" },
        config: { type: "string" },
        "fail-on": { type: "string" },
        "min-text": { type: "string" },
        header: { type: "string", short: "H", multiple: true },
        auth: { type: "string" },
        cookie: { type: "string" },
        timeout: { type: "string" },
        concurrency: { type: "string" },
        delay: { type: "string" },
        insecure: { type: "boolean", default: false },
        "crawl-delay": { type: "boolean", default: true },
        color: { type: "boolean", default: true },
        "list-agents": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const { values, positionals } = parsed;
  const color = !negated.has("color") && values.color !== false && !process.env.NO_COLOR;
  const ink: Ink = color ? pc : PLAIN;

  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (values.help || (!positionals.length && !values["list-agents"])) {
    process.stdout.write(`${help(ink)}\n`);
    return positionals.length ? 0 : values.help ? 0 : 1;
  }
  if (values["list-agents"]) {
    const width = Math.max(...AGENTS.map((a) => a.id.length));
    for (const group of ["search", "ai", "social"] as const) {
      process.stdout.write(`\n${ink.bold(group)}\n`);
      for (const agent of AGENTS.filter((a) => a.group === group)) {
        const js = agent.ua === null ? "robots token only" : `js: ${agent.js}`;
        process.stdout.write(`  ${agent.id.padEnd(width)}  ${ink.dim(js.padEnd(18))}${agent.note ? ink.dim(agent.note) : ""}\n`);
      }
    }
    process.stdout.write("\n");
    return 0;
  }

  const url = normaliseUrl(positionals[0]!);

  let config;
  let configPath: string | null = null;
  try {
    ({ config, path: configPath } = await loadConfig(values.config));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const ignore = [
    ...config.ignore,
    ...(values.ignore ? values.ignore.split(",") : []),
  ];

  const headers: Record<string, string> = {};
  for (const raw of values.header ?? []) {
    const sep = raw.indexOf(":");
    if (sep === -1) fail(`--header expects "Name: value", got: ${raw}`);
    headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
  }

  const number = (value: string | undefined, fallbackValue: number, label: string): number => {
    if (value === undefined) return fallbackValue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) fail(`--${label} expects a number, got: ${value}`);
    return n;
  };

  const options: Partial<RunOptions> & { url: string } = {
    url,
    agents: values.agents ? values.agents.split(",") : config.agents ?? ["default"],
    render: values.render ?? false,
    timeoutMs: number(values.timeout, 20_000, "timeout"),
    concurrency: Math.max(1, number(values.concurrency, 4, "concurrency")),
    delayMs: number(values.delay, 0, "delay"),
    headers,
    basicAuth: values.auth ?? null,
    cookies: values.cookie ?? null,
    insecure: values.insecure ?? false,
  };

  if (options.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  if (values.render) {
    const capability = await renderCapability();
    if (!capability.available) {
      process.stderr.write(`${ink.yellow("crawlview:")} ${capability.detail}\n`);
      process.stderr.write(ink.dim("           continuing without the browser comparison\n"));
      options.render = false;
    }
  }

  const { report, warnings } = await analyse(options);
  for (const warning of warnings) {
    process.stderr.write(`${ink.yellow("crawlview:")} ${warning}\n`);
  }

  // Site mode runs on top of the single-page analysis so the report carries both.
  if (values.sitemap) {
    // The defaults have to be merged in explicitly: `options` is partial, and
    // handing it over as-is left maxRedirects undefined, which made every
    // fetch fall straight through its own redirect loop and return nothing.
    const { site, findings } = await crawlSite({
      ...DEFAULT_OPTIONS,
      ...options,
      agents: options.agents ?? ["default"],
      limit: Math.max(1, number(values.limit, 50, "limit")),
      sitemapUrl: values["sitemap-url"] ?? null,
      ignoreCrawlDelay: negated.has("crawl-delay") || values["crawl-delay"] === false,
      agentId: report.agents.find((a) => a.agent.ua)?.agent.id ?? "googlebot-mobile",
    });
    report.site = site;
    report.findings = rank([...report.findings, ...findings]);
  }

  if (values.diff) {
    try {
      const baseline = await readSnapshot(values.diff);
      const { findings } = diffSnapshot(baseline, report);
      report.findings = rank([...findings, ...report.findings]);
    } catch (err) {
      fail(`could not read snapshot ${values.diff}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { kept, ignored } = applyIgnores(report.findings, ignore);
  report.findings = kept;

  // --- Output -------------------------------------------------------------------
  let wroteStdout = false;

  if (values.json) {
    process.stdout.write(`${toJson(report)}\n`);
    wroteStdout = true;
  }
  if (values.html) {
    await writeFile(values.html, toHtml(report, { brand: values.brand ?? false }), "utf8");
  }
  if (values.md) {
    await writeFile(values.md, `${toMarkdown(report)}\n`, "utf8");
  }
  if (values.snapshot) {
    await writeSnapshot(values.snapshot, report);
  }

  if (!wroteStdout) {
    process.stdout.write(`${renderTerminal(report, { color, verbose: values.verbose ?? false })}\n`);
    if (ignored.length) {
      const where = configPath ? path.basename(configPath) : "--ignore";
      process.stdout.write(ink.dim(`  ${ignored.length} finding${ignored.length === 1 ? "" : "s"} suppressed by ${where}\n\n`));
    }
    const written = [values.html, values.md, values.snapshot].filter(Boolean);
    if (written.length) {
      process.stdout.write(ink.dim(`  wrote ${written.join(", ")}\n\n`));
    }
  }

  // --- Exit code -----------------------------------------------------------------
  if (!values.ci) return 0;

  const failOn = values["fail-on"] ?? config.failOn ?? "error";
  if (failOn !== "error" && failOn !== "warn") {
    fail(`--fail-on expects "error" or "warn", got: ${failOn}`);
  }
  const failing = report.findings.filter((f) =>
    f.severity === "error" || (failOn === "warn" && f.severity === "warn"));
  if (failing.length) return 1;

  const minText = number(values["min-text"], config.minText ?? 60, "min-text");
  if (report.browser && report.browser.facts.wordCount >= 50) {
    const reference = report.browser.facts.wordCount;
    const worst = report.agents
      .filter((a) => a.facts)
      .reduce((acc, a) => Math.min(acc, (a.facts!.wordCount / reference) * 100), 100);
    if (worst < minText) {
      process.stderr.write(`${ink.red("crawlview:")} a crawler sees ${Math.round(worst)}% of the browser's text, below the ${minText}% floor\n`);
      return 1;
    }
  }
  return 0;
}

/* Whether this file is the program being run, rather than a module somebody
   imported. The previous test asked whether the entry path contained the
   string "crawlview", which is true of every file inside a checkout of this
   project — so importing the library from here ran the CLI, on whatever
   arguments the host process happened to have. Comparing resolved paths is
   the only answer that means what it says; realpath matters because npm
   installs the binary as a symlink. */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // Outside main, so the parsed flags are gone; picocolors' own detection
      // is the best available answer for a crash message.
      process.stderr.write(`${pc.red("crawlview:")} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(2);
    });
}
