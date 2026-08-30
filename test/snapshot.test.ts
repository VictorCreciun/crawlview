import { describe, expect, it } from "vitest";
import { diffSnapshot, toSnapshot } from "../src/snapshot.js";
import { rank } from "../src/run.js";
import { parseHtml } from "../src/extract/html.js";
import { agentById } from "../src/agents.js";
import type { Capture, Finding, PageReport } from "../src/types.js";

const URL_ = "https://example.com/";

function build(words: number, jsonLd: number, status = 200): PageReport {
  const body = "word ".repeat(words);
  const ld = Array.from({ length: jsonLd },
    () => `<script type="application/ld+json">{"@type":"Thing","name":"x"}</script>`).join("");
  const html = `<html lang="en"><head><title>T</title>${ld}</head><body><main>${body}</main></body></html>`;
  const cap: Capture = {
    agentId: "googlebot", requestedUrl: URL_, finalUrl: URL_, status, ok: status < 300,
    redirects: [], headers: {}, html, bytes: html.length, elapsedMs: 5, rendered: false,
  };
  return {
    url: URL_, startedAt: new Date().toISOString(), elapsedMs: 1,
    agents: [{ agent: agentById("googlebot")!, capture: cap, facts: parseHtml(html, URL_),
               robots: { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null } }],
    browser: null, findings: [], robotsTxt: null, llmsTxt: null,
  };
}

describe("snapshot", () => {
  it("keeps only what a regression needs", () => {
    const snap = toSnapshot(build(300, 2));
    expect(snap.version).toBe(1);
    expect(snap.agents[0]).toMatchObject({ id: "googlebot", status: 200, jsonLd: 2 });
    expect(JSON.stringify(snap)).not.toContain("<html");
  });

  it("fails a build when content disappears", () => {
    const before = toSnapshot(build(300, 1));
    const { findings, regressions } = diffSnapshot(before, build(10, 1));
    expect(findings.map((f) => f.code)).toContain("regress:words:googlebot");
    expect(regressions).toBeGreaterThan(0);
  });

  it("fails a build when structured data disappears", () => {
    const before = toSnapshot(build(300, 3));
    const { findings } = diffSnapshot(before, build(300, 0));
    expect(findings.map((f) => f.code)).toContain("regress:jsonld:googlebot");
  });

  it("reports a status change", () => {
    const before = toSnapshot(build(300, 1, 200));
    const { findings, regressions } = diffSnapshot(before, build(300, 1, 500));
    expect(findings.map((f) => f.code)).toContain("regress:status:googlebot");
    expect(regressions).toBe(1);
  });

  it("says nothing when nothing moved", () => {
    const before = toSnapshot(build(300, 1));
    expect(diffSnapshot(before, build(300, 1)).regressions).toBe(0);
  });

  it("celebrates a fix without failing the build", () => {
    const withProblem = build(300, 1);
    withProblem.findings = [{ code: "x", severity: "error", title: "Something was wrong" }];
    const after = build(300, 1);
    const { findings, regressions } = diffSnapshot(toSnapshot(withProblem), after);
    expect(findings.map((f) => f.code)).toContain("fixed:x");
    expect(regressions).toBe(0);
  });
});

describe("rank", () => {
  const f = (code: string, severity: Finding["severity"], title: string, evidence?: string[]): Finding =>
    ({ code, severity, title, ...(evidence ? { evidence } : {}) });

  it("puts problems first", () => {
    const out = rank([f("a", "ok", "fine"), f("b", "error", "broken"), f("c", "warn", "iffy")]);
    expect(out.map((x) => x.severity)).toEqual(["error", "warn", "ok"]);
  });

  it("collapses identical findings and counts them", () => {
    const out = rank([
      f("dup", "error", "Same problem", ["one"]),
      f("dup", "error", "Same problem", ["two"]),
      f("dup", "error", "Same problem", ["one"]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Same problem (3×)");
    expect(out[0]!.evidence).toEqual(["one", "two"]);
  });

  it("keeps findings that differ", () => {
    expect(rank([f("a", "error", "One"), f("a", "error", "Two")])).toHaveLength(2);
  });
});
