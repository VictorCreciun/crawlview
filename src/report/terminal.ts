import pc from "picocolors";
import type { AgentResult, Finding, PageReport, Severity } from "../types.js";
import { starved as isStarved } from "../checks/util.js";

/* picocolors decides at import time whether the terminal wants colour, and
   `createColors(false)` returns a NEW object rather than switching the module
   off. Calling it and throwing the result away — which is what this file used
   to do — leaves every escape code exactly where it was, so --no-color did
   nothing. Locally it looked right, because piped output has picocolors
   disable itself anyway; CI forces colour on and the bug surfaced there. The
   object is now created once and passed down, and nothing reaches for the
   module default. */
type Ink = Omit<typeof pc, "createColors" | "isColorSupported">;
const PLAIN: Ink = pc.createColors(false);

const MARK: Record<Severity, string> = { error: "✗", warn: "!", info: "·", ok: "✓" };

function paint(ink: Ink, severity: Severity, text: string): string {
  switch (severity) {
    case "error": return ink.red(text);
    case "warn": return ink.yellow(text);
    case "info": return ink.dim(text);
    case "ok": return ink.green(text);
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function words(n: number): string {
  return `${n.toLocaleString("en-US")} w`;
}

/** Column widths are measured on the uncoloured text: escape codes have no
 *  width on screen but plenty in `String.length`, and mixing the two is how
 *  tables come out ragged. */
interface Column {
  header: string;
  align: "left" | "right";
  values: string[];
  painted: string[];
}

function table(ink: Ink, columns: Column[], indent = "  "): string[] {
  const widths = columns.map((c) => Math.max(c.header.length, ...c.values.map((v) => v.length)));
  const rows: string[] = [];

  rows.push(
    indent + columns.map((c, i) => {
      const w = widths[i]!;
      const h = c.header.toUpperCase();
      return ink.dim(c.align === "right" ? h.padStart(w) : h.padEnd(w));
    }).join("  "),
  );

  const count = columns[0]?.values.length ?? 0;
  for (let r = 0; r < count; r++) {
    rows.push(
      indent + columns.map((c, i) => {
        const w = widths[i]!;
        const raw = c.values[r] ?? "";
        const pad = w - raw.length;
        const cell = c.painted[r] ?? raw;
        return c.align === "right" ? " ".repeat(Math.max(0, pad)) + cell : cell + " ".repeat(Math.max(0, pad));
      }).join("  "),
    );
  }
  return rows;
}

function statusCell(ink: Ink, result: AgentResult): { raw: string; painted: string } {
  const cap = result.capture;
  if (!cap) return { raw: "—", painted: ink.dim("—") };
  if (cap.error) return { raw: "err", painted: ink.red("err") };
  const raw = String(cap.status);
  if (cap.status >= 200 && cap.status < 300) return { raw, painted: ink.green(raw) };
  if (cap.status >= 300 && cap.status < 400) return { raw, painted: ink.yellow(raw) };
  return { raw, painted: ink.red(raw) };
}

export function renderTerminal(report: PageReport, opts: { color: boolean; verbose: boolean }): string {
  const ink: Ink = opts.color ? pc : PLAIN;
  const lines: string[] = [];

  lines.push("");
  lines.push(`${ink.bold("crawlview")}  ${report.url}`);

  const fetchedCount = report.agents.filter((a) => a.capture && !a.capture.error).length;
  const seconds = (report.elapsedMs / 1000).toFixed(1);
  lines.push(ink.dim(`           ${fetchedCount} crawler${fetchedCount === 1 ? "" : "s"} in ${seconds}s${report.browser ? ", plus a rendered browser" : ""}`));
  lines.push("");

  // --- The matrix --------------------------------------------------------------
  const rows: AgentResult[] = report.agents.filter((a) => a.agent.ua !== null);

  const name: Column = { header: "agent", align: "left", values: [], painted: [] };
  const status: Column = { header: "status", align: "right", values: [], painted: [] };
  const size: Column = { header: "html", align: "right", values: [], painted: [] };
  const text: Column = { header: "text", align: "right", values: [], painted: [] };
  const title: Column = { header: "title", align: "right", values: [], painted: [] };
  const desc: Column = { header: "desc", align: "right", values: [], painted: [] };
  const h1: Column = { header: "h1", align: "right", values: [], painted: [] };
  const canon: Column = { header: "canon", align: "right", values: [], painted: [] };
  const ld: Column = { header: "ld", align: "right", values: [], painted: [] };
  const rob: Column = { header: "robots", align: "right", values: [], painted: [] };

  const push = (col: Column, raw: string, painted?: string) => {
    col.values.push(raw);
    col.painted.push(painted ?? raw);
  };

  const yes = (ok: boolean, good = "ok", bad = "—") =>
    ok ? { raw: good, painted: ink.green(good) } : { raw: bad, painted: ink.red(bad) };

  const reference = report.browser?.facts.wordCount ?? Math.max(0, ...rows.map((r) => r.facts?.wordCount ?? 0));

  for (const result of rows) {
    push(name, result.agent.label);
    const st = statusCell(ink, result);
    push(status, st.raw, st.painted);

    const facts = result.facts;
    if (!facts || !result.capture || result.capture.error) {
      for (const col of [size, text, title, desc, h1, canon, ld]) push(col, "—", ink.dim("—"));
    } else {
      push(size, bytes(result.capture.bytes), ink.dim(bytes(result.capture.bytes)));

      const w = words(facts.wordCount);
      const starved = isStarved(facts.wordCount, reference);
      push(text, w, starved ? ink.red(w) : ink.reset(w));

      const t = yes(!!facts.title); push(title, t.raw, t.painted);
      const d = yes(!!facts.metaDescription); push(desc, d.raw, d.painted);

      const h1count = facts.headings.filter((h) => h.level === 1).length;
      push(h1, String(h1count), h1count === 1 ? ink.green("1") : ink.red(String(h1count)));

      const c = yes(!!facts.canonical); push(canon, c.raw, c.painted);

      const blocks = facts.jsonLd.length;
      const broken = facts.jsonLd.some((b) => b.error);
      push(ld, String(blocks), broken ? ink.red(String(blocks)) : blocks > 0 ? ink.green(String(blocks)) : ink.dim("0"));
    }

    const robots = result.robots;
    if (!robots) push(rob, "—", ink.dim("—"));
    else if (robots.allowed) push(rob, "allow", ink.green("allow"));
    else push(rob, "block", ink.red("block"));
  }

  // robots-only tokens: no fetch, but the policy is the whole point of listing them.
  for (const result of report.agents.filter((a) => a.agent.ua === null)) {
    push(name, ink.dim(result.agent.label));
    name.values[name.values.length - 1] = result.agent.label;
    for (const col of [status, size, text, title, desc, h1, canon, ld]) push(col, "—", ink.dim("—"));
    const allowed = result.robots?.allowed ?? true;
    push(rob, allowed ? "allow" : "block", allowed ? ink.green("allow") : ink.red("block"));
  }

  if (report.browser) {
    const facts = report.browser.facts;
    push(name, "browser (rendered)", ink.bold("browser (rendered)"));
    push(status, String(report.browser.capture.status), ink.green(String(report.browser.capture.status)));
    push(size, bytes(report.browser.capture.bytes), ink.dim(bytes(report.browser.capture.bytes)));
    push(text, words(facts.wordCount), ink.bold(words(facts.wordCount)));
    const t = yes(!!facts.title); push(title, t.raw, t.painted);
    const d = yes(!!facts.metaDescription); push(desc, d.raw, d.painted);
    const h1count = facts.headings.filter((h) => h.level === 1).length;
    push(h1, String(h1count), h1count === 1 ? ink.green("1") : ink.red(String(h1count)));
    const c = yes(!!facts.canonical); push(canon, c.raw, c.painted);
    push(ld, String(facts.jsonLd.length));
    push(rob, "—", ink.dim("—"));
  }

  lines.push(...table(ink, [name, status, size, text, title, desc, h1, canon, ld, rob]));
  lines.push("");

  if (report.site) {
    const site = report.site;
    const failed = site.pages.filter((p) => p.status === null || p.status >= 400).length;
    lines.push(`  ${ink.bold("site")}  ${site.sitemapUrl ?? ink.red("no sitemap found")}`);
    if (site.sitemapUrl) {
      lines.push(ink.dim(`        ${site.urls.length} URL${site.urls.length === 1 ? "" : "s"} checked${failed ? `, ${failed} did not return a page` : ""}`));
    }
    lines.push("");
  }

  // --- Findings ----------------------------------------------------------------
  const groups: Severity[] = ["error", "warn", "info", "ok"];
  const labels: Record<Severity, string> = {
    error: "problems",
    warn: "worth fixing",
    info: "notes",
    ok: "passing",
  };

  for (const severity of groups) {
    const items = report.findings.filter((f) => f.severity === severity);
    if (!items.length) continue;
    if (severity === "ok" && !opts.verbose) continue;
    if (severity === "info" && !opts.verbose) continue;

    lines.push(`  ${paint(ink, severity, MARK[severity])} ${ink.bold(labels[severity])}`);
    for (const item of items) lines.push(...renderFinding(ink, item, severity));
    lines.push("");
  }

  const hidden = report.findings.filter((f) => (f.severity === "info" || f.severity === "ok")).length;
  if (hidden && !opts.verbose) {
    lines.push(ink.dim(`  ${hidden} more note${hidden === 1 ? "" : "s"} — run with --verbose to see them`));
    lines.push("");
  }

  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warns = report.findings.filter((f) => f.severity === "warn").length;
  if (errors === 0 && warns === 0) {
    lines.push(`  ${ink.green("Nothing broken.")} Every crawler checked receives the page a browser does.`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderFinding(ink: Ink, item: Finding, severity: Severity): string[] {
  const out: string[] = [];
  out.push(`    ${paint(ink, severity, item.title)}`);
  if (item.detail) {
    for (const line of wrap(item.detail, 76)) out.push(ink.dim(`      ${line}`));
  }
  for (const evidence of item.evidence ?? []) {
    out.push(ink.dim(`      · ${evidence}`));
  }
  return out;
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
