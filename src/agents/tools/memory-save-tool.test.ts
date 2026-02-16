import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createMemorySaveTool } from "./memory-tool.js";

describe("createMemorySaveTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns disabled when memory.backend is not zigmem", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as unknown as OpenClawConfig;

    const tool = createMemorySaveTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { text: "hello" });
    expect(result.details).toMatchObject({
      ok: false,
      disabled: true,
    });
  });

  it("posts to zigmem /save when backend is zigmem", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "mem_1" }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "zigmem",
        zigmem: {
          baseUrl: "http://127.0.0.1:8000",
          timeoutMs: 5000,
        },
      },
    } as unknown as OpenClawConfig;

    const tool = createMemorySaveTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_2", {
      text: "remember this",
      metadata: { kind: "test" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:8000/save");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("remember this");

    expect(result.details).toMatchObject({
      ok: true,
      response: { id: "mem_1" },
    });
  });
});
