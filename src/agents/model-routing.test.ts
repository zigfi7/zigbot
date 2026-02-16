import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePooledModelRoute } from "./model-routing.js";

function buildConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        modelRouting: {
          enabled: true,
          pool: {
            small: "google/gemini-2.5-flash",
            meta: "google/gemini-2.5-pro",
            coding: "anthropic/claude-sonnet-4-5",
            vision: "openai/gpt-4.1-mini",
            heavy: "anthropic/claude-opus-4-5",
            standard: "anthropic/claude-sonnet-4-5",
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolvePooledModelRoute", () => {
  it("routes short/simple prompts to the small pool model", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Napisz 1 zdanie podsumowania",
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-5",
      allowCurrentModelOverride: true,
    });

    expect(routed).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      task: "small",
    });
  });

  it("routes meta-analysis prompts to the meta pool model", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Zrob meta-analiza tradeoffow dla tej architektury",
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-5",
      allowCurrentModelOverride: true,
    });

    expect(routed).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
      task: "meta",
    });
  });

  it("routes coding prompts to the coding pool model", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Fix this bug in TypeScript and add tests",
      currentProvider: "google",
      currentModel: "gemini-2.5-flash",
      allowCurrentModelOverride: true,
    });

    expect(routed).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      task: "coding",
    });
  });

  it("routes image tasks to the vision pool model", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Co jest na tym obrazku?",
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-5",
      imagesCount: 1,
      allowCurrentModelOverride: true,
    });

    expect(routed).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      task: "vision",
    });
  });

  it("routes high-thinking runs to the heavy pool model", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Przeanalizuj to bardzo dokladnie",
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-5",
      thinkLevel: "high",
      allowCurrentModelOverride: true,
    });

    expect(routed).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      task: "heavy",
    });
  });

  it("returns null when the routed model matches the current one", () => {
    const routed = resolvePooledModelRoute({
      cfg: buildConfig(),
      prompt: "Fix this bug",
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-5",
      allowCurrentModelOverride: true,
    });

    expect(routed).toBeNull();
  });
});
