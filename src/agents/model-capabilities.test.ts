import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildModelCapabilityLines,
  resolveModelRuntimeCapabilities,
} from "./model-capabilities.js";

describe("model-capabilities", () => {
  it("resolves runtime capabilities from model entry and llmws serverCapabilities", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "llmws/qwen-8b": {
              capabilities: ["small", "coding"],
              params: {
                serverCapabilities: ["vision"],
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const capabilities = resolveModelRuntimeCapabilities({
      cfg,
      provider: "llmws",
      model: "qwen-8b",
    });

    expect(capabilities).toContain("small");
    expect(capabilities).toContain("coding");
    expect(capabilities).toContain("llmws");
    expect(capabilities).toContain("server-vision");
  });

  it("builds capability lines with alias and llmws server hints", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "llmws/qwen-8b",
          models: {
            "llmws/qwen-8b": {
              alias: "LocalFast",
              capabilities: ["small"],
              params: {
                serverCapabilities: ["vision"],
              },
            },
          },
          llmws: {
            servers: [
              { url: "127.0.0.1:9001", capabilities: ["fast"] },
              { url: "127.0.0.1:9002", capabilities: ["vision"] },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const lines = buildModelCapabilityLines({
      cfg,
      activeModel: { provider: "llmws", model: "qwen-8b" },
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("LocalFast -> llmws/qwen-8b");
    expect(lines[0]).toContain("caps=small,llmws,server-vision");
    expect(lines[0]).toContain("server=");
    expect(lines[0]).toContain("prefer=vision");
  });

  it("normalizes ws:\\\\host notation in llmws server hints", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "llmws/qwen-8b",
          models: {
            "llmws/qwen-8b": {
              params: {
                serverCapabilities: ["vision"],
              },
            },
          },
          llmws: {
            servers: [{ url: "ws:\\\\10.10.27.10:8766", capabilities: ["vision"] }],
          },
        },
      },
    } as OpenClawConfig;

    const lines = buildModelCapabilityLines({
      cfg,
      activeModel: { provider: "llmws", model: "qwen-8b" },
    });

    expect(lines[0]).toContain("server=ws://10.10.27.10:8766[vision]");
  });
});
