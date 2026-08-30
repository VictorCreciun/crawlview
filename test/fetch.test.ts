import { afterEach, describe, expect, it, vi } from "vitest";
import { capture, fetchText, pool } from "../src/fetch.js";
import { DEFAULT_OPTIONS } from "../src/run.js";
import type { RunOptions } from "../src/types.js";

const opts = (over: Partial<RunOptions> = {}): RunOptions =>
  ({ ...DEFAULT_OPTIONS, url: "https://e.com/", agents: [], timeoutMs: 2000, ...over });

function respond(body: string | Uint8Array, init: {
  status?: number; headers?: Record<string, string>;
} = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(bytes, { status: init.status ?? 200, headers: init.headers ?? {} });
}

afterEach(() => vi.unstubAllGlobals());

describe("capture", () => {
  it("sends the agent's user-agent verbatim", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>)["User-Agent"] ?? "";
      return respond("<html><body>ok</body></html>");
    });
    await capture({ url: "https://e.com/", ua: "GPTBot/1.2", agentId: "gptbot" }, opts());
    expect(seen).toBe("GPTBot/1.2");
  });

  it("records every redirect hop instead of hiding them", async () => {
    const chain: Record<string, [number, string | null]> = {
      "https://e.com/a": [301, "/b"],
      "https://e.com/b": [302, "/c"],
      "https://e.com/c": [200, null],
    };
    vi.stubGlobal("fetch", async (u: string) => {
      const [status, loc] = chain[u]!;
      return respond(loc ? "" : "<html><body>done</body></html>",
        { status, headers: loc ? { location: loc } : {} });
    });
    const cap = await capture({ url: "https://e.com/a", ua: "x", agentId: "a" }, opts());
    expect(cap.redirects.map((r) => r.status)).toEqual([301, 302]);
    expect(cap.finalUrl).toBe("https://e.com/c");
    expect(cap.status).toBe(200);
  });

  it("stops on a redirect that points at itself", async () => {
    vi.stubGlobal("fetch", async (u: string) =>
      respond("", { status: 301, headers: { location: u } }));
    const cap = await capture({ url: "https://e.com/loop", ua: "x", agentId: "a" }, opts());
    expect(cap.error).toMatch(/loop/i);
  });

  it("gives up after maxRedirects", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () =>
      respond("", { status: 302, headers: { location: `/next-${n++}` } }));
    const cap = await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts({ maxRedirects: 3 }));
    expect(cap.error).toMatch(/more than 3 redirects/);
  });

  it("keeps a non-redirect status rather than following it", async () => {
    vi.stubGlobal("fetch", async () => respond("blocked", { status: 403 }));
    const cap = await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts());
    expect(cap.status).toBe(403);
    expect(cap.ok).toBe(false);
  });

  it("decodes a page declaring a legacy charset in its header", async () => {
    // "Ș" in windows-1250. Decoding this as UTF-8 yields a replacement
    // character, and every text check downstream would measure the damage.
    const bytes = new Uint8Array([0x8a, 0x74, 0x72, 0x61, 0x64, 0x61]); // Štrada
    vi.stubGlobal("fetch", async () =>
      respond(bytes, { headers: { "content-type": "text/html; charset=windows-1250" } }));
    const cap = await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts());
    expect(cap.html).toContain("Štrada");
    expect(cap.html).not.toContain("�");
  });

  it("falls back to the meta charset when the header says nothing", async () => {
    const meta = '<meta charset="windows-1251">';
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(`<html><head>${meta}</head><body>`),
      0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, // Привет
      ...new TextEncoder().encode("</body></html>"),
    ]);
    vi.stubGlobal("fetch", async () => respond(bytes, { headers: { "content-type": "text/html" } }));
    const cap = await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts());
    expect(cap.html).toContain("Привет");
  });

  it("reports a timeout as a timeout, not as a mystery", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }));
    const cap = await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts({ timeoutMs: 30 }));
    expect(cap.error).toMatch(/timed out after 30 ms/);
  });

  it("carries basic auth, cookies and custom headers", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return respond("<html><body>ok</body></html>");
    });
    await capture({ url: "https://e.com/", ua: "x", agentId: "a" }, opts({
      basicAuth: "user:pa:ss", cookies: "session=abc", headers: { "X-Preview": "1" },
    }));
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("user:pa:ss").toString("base64")}`);
    expect(headers.Cookie).toBe("session=abc");
    expect(headers["X-Preview"]).toBe("1");
  });

  it("resolves a relative Location against the current URL", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(u);
      return seen.length === 1
        ? respond("", { status: 301, headers: { location: "../up" } })
        : respond("<html><body>ok</body></html>");
    });
    const cap = await capture({ url: "https://e.com/deep/page", ua: "x", agentId: "a" }, opts());
    expect(cap.finalUrl).toBe("https://e.com/up");
  });
});

describe("fetchText", () => {
  it("returns the body and the status for robots.txt", async () => {
    vi.stubGlobal("fetch", async () => respond("User-agent: *\nAllow: /"));
    const res = await fetchText("https://e.com/robots.txt", opts());
    expect(res.status).toBe(200);
    expect(res.body).toContain("User-agent");
  });

  it("reports a network failure without throwing", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ENOTFOUND"); });
    const res = await fetchText("https://nope.invalid/robots.txt", opts());
    expect(res.status).toBe(0);
    expect(res.body).toBeNull();
    expect(res.error).toMatch(/ENOTFOUND/);
  });
});

describe("pool", () => {
  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await pool([...Array(20).keys()], 4, 0, async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("keeps results in input order, not completion order", async () => {
    const out = await pool([30, 5, 20, 1], 4, 0, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty list", async () => {
    expect(await pool([], 4, 0, async () => 1)).toEqual([]);
  });
});
