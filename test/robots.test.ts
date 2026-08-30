import { describe, expect, it } from "vitest";
import { evaluate, parseRobots } from "../src/robots.js";
import { agentById } from "../src/agents.js";

const gptbot = agentById("gptbot")!;
const googlebot = agentById("googlebot")!;
const claudebot = agentById("claudebot")!;

describe("parseRobots", () => {
  it("groups consecutive user-agent lines together", () => {
    const robots = parseRobots(`
User-agent: GPTBot
User-agent: CCBot
Disallow: /private/
    `);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]!.tokens).toEqual(["gptbot", "ccbot"]);
  });

  it("starts a new group when a user-agent follows a rule", () => {
    const robots = parseRobots(`
User-agent: *
Disallow: /admin/
User-agent: GPTBot
Disallow: /
    `);
    expect(robots.groups).toHaveLength(2);
  });

  it("reads sitemap declarations", () => {
    const robots = parseRobots("Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nAllow: /");
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("records lines it cannot understand", () => {
    const robots = parseRobots("User-agent: *\nDisalow: /typo\nDisallow: /real");
    expect(robots.malformed).toContain("Disalow: /typo");
  });

  it("treats an empty Disallow as permission", () => {
    const robots = parseRobots("User-agent: *\nDisallow:");
    expect(evaluate(robots, googlebot, "https://e.com/x").allowed).toBe(true);
  });
});

describe("evaluate", () => {
  it("blocks an agent named in its own group", () => {
    const robots = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /");
    expect(evaluate(robots, gptbot, "https://e.com/page").allowed).toBe(false);
    expect(evaluate(robots, googlebot, "https://e.com/page").allowed).toBe(true);
  });

  it("prefers the most specific matching rule, not the first", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /blog/\nAllow: /blog/public/");
    expect(evaluate(robots, googlebot, "https://e.com/blog/private").allowed).toBe(false);
    expect(evaluate(robots, googlebot, "https://e.com/blog/public/post").allowed).toBe(true);
  });

  it("lets Allow win a tie of equal length", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x");
    expect(evaluate(robots, googlebot, "https://e.com/x").allowed).toBe(true);
  });

  it("honours wildcards and the end anchor", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$");
    expect(evaluate(robots, googlebot, "https://e.com/a/b.pdf").allowed).toBe(false);
    expect(evaluate(robots, googlebot, "https://e.com/a/b.pdf?x=1").allowed).toBe(true);
  });

  it("matches an agent through an alternate token", () => {
    const robots = parseRobots("User-agent: anthropic-ai\nDisallow: /");
    expect(evaluate(robots, claudebot, "https://e.com/").allowed).toBe(false);
  });

  it("falls back to the wildcard group", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /secret");
    expect(evaluate(robots, gptbot, "https://e.com/secret").allowed).toBe(false);
    expect(evaluate(robots, gptbot, "https://e.com/secret").matchedToken).toBeNull();
  });

  it("allows everything when there is no robots.txt", () => {
    expect(evaluate(null, gptbot, "https://e.com/anything").allowed).toBe(true);
  });
});
