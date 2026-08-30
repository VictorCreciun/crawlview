import type { PageReport, Severity } from "../types.js";
import { starved as isStarved } from "../checks/util.js";

const LABEL: Record<Severity, string> = {
  error: "Problems", warn: "Worth fixing", info: "Notes", ok: "Passing",
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface HtmlOptions {
  /** Adds the studio's identity to the document, for sending to a client. */
  brand: boolean;
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#16181d;--muted:#6b7280;--line:#e5e7eb;--card:#fff;
--error:#b42318;--warn:#b54708;--info:#475467;--ok:#067647;
--errorbg:#fef3f2;--warnbg:#fffaeb;--okbg:#ecfdf3;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--muted:#9aa3af;--line:#242832;
--card:#161922;--error:#f97066;--warn:#fdb022;--info:#98a2b3;--ok:#47cd89;
--errorbg:#2a1614;--warnbg:#2a2011;--okbg:#0f2419}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:48px 24px 96px}
header{border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:32px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
h1 span{font-weight:400;color:var(--muted)}
.sub{color:var(--muted);font-size:13px}
.url{font-family:var(--mono);font-size:14px;word-break:break-all}
.counts{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0 8px}
.pill{border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:13px;background:var(--card)}
.pill b{font-variant-numeric:tabular-nums}
.pill.error{color:var(--error);border-color:color-mix(in srgb,var(--error) 35%,var(--line))}
.pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,var(--line))}
.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
margin:44px 0 14px;font-weight:600}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:9px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono)}
tr.browser td{font-weight:600;background:color-mix(in srgb,var(--fg) 4%,transparent)}
.g{color:var(--ok)}.r{color:var(--error)}.y{color:var(--warn)}.d{color:var(--muted)}
.f{border:1px solid var(--line);border-left-width:3px;border-radius:8px;background:var(--card);
padding:14px 16px;margin-bottom:10px}
.f.error{border-left-color:var(--error);background:var(--errorbg)}
.f.warn{border-left-color:var(--warn);background:var(--warnbg)}
.f.info{border-left-color:var(--info)}
.f.ok{border-left-color:var(--ok);background:var(--okbg)}
.f h3{margin:0;font-size:14.5px;font-weight:600;line-height:1.45}
.f p{margin:7px 0 0;color:var(--muted);font-size:13.5px}
.f ul{margin:9px 0 0;padding-left:18px}
.f li{font-family:var(--mono);font-size:12px;color:var(--muted);word-break:break-all;margin:2px 0}
.code{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:8px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);
color:var(--muted);font-size:12.5px}
footer a{color:inherit}
.brand{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px 20px;margin-bottom:32px}
.brand h2{margin:0 0 4px;font-size:15px;text-transform:none;letter-spacing:0;color:var(--fg)}
.brand p{margin:0;color:var(--muted);font-size:13.5px}
@media print{body{background:#fff}.wrap{padding:0}.f{break-inside:avoid}}
`;

export function toHtml(report: PageReport, options: HtmlOptions): string {
  const counts = {
    error: report.findings.filter((f) => f.severity === "error").length,
    warn: report.findings.filter((f) => f.severity === "warn").length,
    info: report.findings.filter((f) => f.severity === "info").length,
    ok: report.findings.filter((f) => f.severity === "ok").length,
  };

  const rows = report.agents.filter((a) => a.agent.ua !== null);
  const reference = report.browser?.facts.wordCount ?? Math.max(0, ...rows.map((r) => r.facts?.wordCount ?? 0));

  const cell = (ok: boolean, good = "yes", bad = "no") =>
    ok ? `<span class="g">${good}</span>` : `<span class="r">${bad}</span>`;

  const body: string[] = [];

  for (const result of rows) {
    const cap = result.capture;
    const facts = result.facts;
    const status = cap?.error ? `<span class="r">error</span>`
      : cap ? `<span class="${cap.status < 300 ? "g" : cap.status < 400 ? "y" : "r"}">${cap.status}</span>`
      : `<span class="d">—</span>`;
    const wordCount = facts?.wordCount ?? null;
    const starved = wordCount !== null && isStarved(wordCount, reference);
    const h1 = facts ? facts.headings.filter((h) => h.level === 1).length : null;

    body.push(`<tr>
<td>${esc(result.agent.label)}</td>
<td class="n">${status}</td>
<td class="n d">${bytes(cap?.bytes)}</td>
<td class="n${starved ? " r" : ""}">${wordCount === null ? "—" : wordCount.toLocaleString("en-US")}</td>
<td class="n">${facts ? cell(!!facts.title) : "—"}</td>
<td class="n">${facts ? cell(!!facts.metaDescription) : "—"}</td>
<td class="n">${h1 === null ? "—" : h1 === 1 ? `<span class="g">1</span>` : `<span class="r">${h1}</span>`}</td>
<td class="n">${facts ? cell(!!facts.canonical) : "—"}</td>
<td class="n">${facts ? facts.jsonLd.length : "—"}</td>
<td class="n">${result.robots ? (result.robots.allowed ? `<span class="g">allow</span>` : `<span class="r">block</span>`) : "—"}</td>
</tr>`);
  }

  for (const result of report.agents.filter((a) => a.agent.ua === null)) {
    body.push(`<tr>
<td>${esc(result.agent.label)}</td>
<td class="n d" colspan="8">robots.txt token only</td>
<td class="n">${result.robots?.allowed !== false ? `<span class="g">allow</span>` : `<span class="r">block</span>`}</td>
</tr>`);
  }

  if (report.browser) {
    const facts = report.browser.facts;
    const h1 = facts.headings.filter((h) => h.level === 1).length;
    body.push(`<tr class="browser">
<td>Browser (rendered)</td>
<td class="n g">${report.browser.capture.status}</td>
<td class="n d">${bytes(report.browser.capture.bytes)}</td>
<td class="n">${facts.wordCount.toLocaleString("en-US")}</td>
<td class="n">${cell(!!facts.title)}</td>
<td class="n">${cell(!!facts.metaDescription)}</td>
<td class="n">${h1 === 1 ? `<span class="g">1</span>` : `<span class="r">${h1}</span>`}</td>
<td class="n">${cell(!!facts.canonical)}</td>
<td class="n">${facts.jsonLd.length}</td>
<td class="n d">—</td>
</tr>`);
  }

  const sections: string[] = [];
  for (const severity of ["error", "warn", "info", "ok"] as Severity[]) {
    const items = report.findings.filter((f) => f.severity === severity);
    if (!items.length) continue;
    sections.push(`<h2>${LABEL[severity]}</h2>`);
    for (const item of items) {
      sections.push(`<div class="f ${severity}">
<h3>${esc(item.title)}</h3>
${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
${item.evidence?.length ? `<ul>${item.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
<div class="code">${esc(item.code)}</div>
</div>`);
    }
  }

  const when = new Date(report.startedAt).toISOString().replace("T", " ").slice(0, 16);

  const brandBlock = options.brand
    ? `<div class="brand">
<h2>coresmith.dev</h2>
<p>Independent engineering studio — websites, desktop and embedded applications, business automation.
Every problem in this report is one we fix. <a href="https://coresmith.dev">coresmith.dev</a> · services@coresmith.dev</p>
</div>`
    : "";

  const footer = options.brand
    ? `Prepared by <a href="https://coresmith.dev">coresmith.dev</a> · generated with crawlview on ${esc(when)} UTC`
    : `Generated with <a href="https://github.com/VictorCreciun/crawlview">crawlview</a> on ${esc(when)} UTC`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Crawler report — ${esc(new URL(report.url).host)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${brandBlock}
<header>
<h1>Crawler report <span>— what machines store for this page</span></h1>
<div class="url">${esc(report.url)}</div>
<div class="counts">
<span class="pill ${counts.error ? "error" : ""}"><b>${counts.error}</b> problem${counts.error === 1 ? "" : "s"}</span>
<span class="pill ${counts.warn ? "warn" : ""}"><b>${counts.warn}</b> worth fixing</span>
<span class="pill"><b>${counts.info}</b> note${counts.info === 1 ? "" : "s"}</span>
<span class="pill ${counts.ok ? "ok" : ""}"><b>${counts.ok}</b> passing</span>
</div>
<div class="sub">${report.agents.length} crawlers checked${report.browser ? ", compared against a rendered browser" : " (no browser comparison — run with --render)"} · ${(report.elapsedMs / 1000).toFixed(1)}s</div>
</header>

<h2>What each crawler receives</h2>
<div class="scroll"><table>
<thead><tr>
<th>Crawler</th><th>Status</th><th>HTML</th><th>Words</th><th>Title</th>
<th>Desc</th><th>H1</th><th>Canonical</th><th>JSON-LD</th><th>robots.txt</th>
</tr></thead>
<tbody>${body.join("\n")}</tbody>
</table></div>

${sections.join("\n")}

<footer>${footer}</footer>
</div>
</body>
</html>
`;
}
