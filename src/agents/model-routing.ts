import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveModelRefFromString,
} from "./model-selection.js";

type RoutedTaskKind = "small" | "meta" | "coding" | "vision" | "heavy" | "standard";

const DEFAULT_SMALL_PROMPT_MAX_CHARS = 220;
const DEFAULT_META_KEYWORDS = [
  "meta",
  "analysis",
  "analyze",
  "analyse",
  "strategy",
  "plan",
  "tradeoff",
  "evaluate",
  "comparison",
  "compare",
  "synthesize",
  "architecture",
  "review options",
  "analiza",
  "porownaj",
  "porównaj",
  "strategia",
  "planowanie",
  "meta-analiza",
];
const DEFAULT_CODING_KEYWORDS = [
  "bug",
  "stacktrace",
  "traceback",
  "compile",
  "build",
  "test",
  "refactor",
  "typescript",
  "javascript",
  "python",
  "function",
  "class",
  "script",
  "patch",
  "implement",
  "fix",
];

function normalizeKeywordList(value: string[] | undefined, fallback: string[]): string[] {
  const source = value && value.length > 0 ? value : fallback;
  return source.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

function includesAnyKeyword(input: string, keywords: string[]): boolean {
  return keywords.some((keyword) => input.includes(keyword));
}

function classifyTask(params: {
  prompt: string;
  thinkLevel?: ThinkLevel;
  imagesCount?: number;
  smallPromptMaxChars: number;
  metaKeywords: string[];
  codingKeywords: string[];
}): RoutedTaskKind {
  if ((params.imagesCount ?? 0) > 0) {
    return "vision";
  }

  const prompt = params.prompt.trim();
  const lower = prompt.toLowerCase();
  const hasCodeFence = lower.includes("```");
  const hasNewline = lower.includes("\n");
  const hasMetaKeyword = includesAnyKeyword(lower, params.metaKeywords);
  const hasCodingKeyword = hasCodeFence || includesAnyKeyword(lower, params.codingKeywords);
  const thinkLevel = params.thinkLevel ?? "off";

  if (hasMetaKeyword) {
    return "meta";
  }
  if (hasCodingKeyword) {
    return "coding";
  }
  if (thinkLevel === "high" || thinkLevel === "xhigh") {
    return "heavy";
  }
  if (prompt.length > 2_200) {
    return "heavy";
  }
  if (
    prompt.length > 0 &&
    prompt.length <= params.smallPromptMaxChars &&
    !hasNewline &&
    !hasMetaKeyword &&
    !hasCodingKeyword
  ) {
    return "small";
  }
  return "standard";
}

function resolveRoutingConfig(cfg: OpenClawConfig | undefined) {
  return cfg?.agents?.defaults?.modelRouting;
}

function selectPoolModel(params: {
  cfg?: OpenClawConfig;
  task: RoutedTaskKind;
}): string | undefined {
  const routing = resolveRoutingConfig(params.cfg);
  const pool = routing?.pool;
  if (!pool) {
    return undefined;
  }
  const order = (() => {
    switch (params.task) {
      case "small":
        return [pool.small, pool.standard];
      case "meta":
        return [pool.meta, pool.standard];
      case "coding":
        return [pool.coding, pool.standard];
      case "vision":
        return [pool.vision, pool.standard];
      case "heavy":
        return [pool.heavy, pool.standard];
      default:
        return [pool.standard];
    }
  })();
  for (const candidate of order) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolvePooledModelRoute(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  prompt: string;
  currentProvider: string;
  currentModel: string;
  thinkLevel?: ThinkLevel;
  imagesCount?: number;
  allowCurrentModelOverride: boolean;
}): {
  provider: string;
  model: string;
  task: RoutedTaskKind;
} | null {
  const routing = resolveRoutingConfig(params.cfg);
  if (routing?.enabled !== true || !params.allowCurrentModelOverride) {
    return null;
  }

  const smallPromptMaxChars =
    typeof routing.smallPromptMaxChars === "number" &&
    Number.isFinite(routing.smallPromptMaxChars) &&
    routing.smallPromptMaxChars > 0
      ? Math.floor(routing.smallPromptMaxChars)
      : DEFAULT_SMALL_PROMPT_MAX_CHARS;
  const metaKeywords = normalizeKeywordList(routing.metaKeywords, DEFAULT_META_KEYWORDS);
  const codingKeywords = normalizeKeywordList(routing.codingKeywords, DEFAULT_CODING_KEYWORDS);
  const task = classifyTask({
    prompt: params.prompt,
    thinkLevel: params.thinkLevel,
    imagesCount: params.imagesCount,
    smallPromptMaxChars,
    metaKeywords,
    codingKeywords,
  });
  const selected = selectPoolModel({ cfg: params.cfg, task });
  if (!selected) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: selected,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved) {
    return null;
  }

  const currentProvider = normalizeProviderId(params.currentProvider);
  const currentModel = params.currentModel.trim();
  if (
    normalizeProviderId(resolved.ref.provider) === currentProvider &&
    resolved.ref.model.trim() === currentModel
  ) {
    return null;
  }

  return {
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    task,
  };
}
