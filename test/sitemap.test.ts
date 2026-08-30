import { describe, expect, it } from "vitest";
import { candidateSitemaps } from "../src/site/sitemap.js";
import { resolveAgents, AGENTS } from "../src/agents.js";

describe("candidateSitemaps", () => {
  it("puts declared sitemaps before guesses", () => {
    const list = candidateSitemaps("https://e.com", ["https://e.com/custom.xml"]);
    expect(list[0]).toBe("https://e.com/custom.xml");
    expect(list).toContain("https://e.com/sitemap.xml");
  });

  it("does not repeat a declared sitemap that is also a guess", () => {
    const list = candidateSitemaps("https://e.com", ["https://e.com/sitemap.xml"]);
    expect(list.filter((u) => u === "https://e.com/sitemap.xml")).toHaveLength(1);
  });
});

describe("resolveAgents", () => {
  it("expands a group name", () => {
    const { agents } = resolveAgents(["ai"]);
    expect(agents.every((a) => a.group === "ai")).toBe(true);
    expect(agents.length).toBeGreaterThan(4);
  });

  it("mixes groups and ids without duplicating", () => {
    const { agents } = resolveAgents(["ai", "gptbot", "googlebot"]);
    const ids = agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("googlebot");
  });

  it("reports names it does not know", () => {
    const { agents, unknown } = resolveAgents(["googlebot", "notabot"]);
    expect(unknown).toEqual(["notabot"]);
    expect(agents).toHaveLength(1);
  });

  it("gives every agent a unique id and at least one robots token", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENTS.every((a) => a.robotsTokens.length > 0)).toBe(true);
  });

  it("keeps a user-agent string for everything except the robots-only tokens", () => {
    for (const agent of AGENTS) {
      if (agent.ua === null) expect(agent.id).toMatch(/-extended$/);
      else expect(agent.ua.length).toBeGreaterThan(10);
    }
  });
});
