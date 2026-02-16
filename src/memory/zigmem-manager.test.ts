import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZigmemConfig } from "./backend-config.js";
import { ZigmemMemoryManager } from "./zigmem-manager.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_CONFIG: ResolvedZigmemConfig = {
  baseUrl: "http://127.0.0.1:8000",
  timeoutMs: 8000,
  mode: "hybrid",
  maxResults: 6,
  pathPrefix: "zigmem",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ZigmemMemoryManager", () => {
  it("maps /search responses to memory results", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      expect(url).toContain("/search");
      expect(url).toContain("mode=hybrid");
      expect(url).toContain("limit=4");
      return jsonResponse({
        items: [
          {
            id: "note-1",
            text: "Pierwsza notatka",
            score: 0.92,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ZigmemMemoryManager(BASE_CONFIG);

    const results = await manager.search("test query", { maxResults: 4 });
    expect(results).toEqual([
      {
        path: "zigmem:note-1",
        startLine: 1,
        endLine: 1,
        score: 0.92,
        snippet: "Pierwsza notatka",
        source: "memory",
      },
    ]);
  });

  it("reads zigmem content via memory_get paths", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      expect(url).toContain("/content/note-2");
      return jsonResponse({
        id: "note-2",
        text: "linia-1\nlinia-2\nlinia-3",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ZigmemMemoryManager(BASE_CONFIG);

    const result = await manager.readFile({
      relPath: "zigmem:note-2",
      from: 2,
      lines: 2,
    });
    expect(result).toEqual({
      path: "zigmem:note-2",
      text: "linia-2\nlinia-3",
    });
  });
});
