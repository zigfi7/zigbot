import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { modelKey, normalizeProviderId, parseModelRef } from "./model-selection.js";

const DEFAULT_LLMWS_ENDPOINT = "ws://127.0.0.1:8765";
const DEFAULT_MAX_CAPABILITY_LINES = 20;

type ModelRef = {
  provider: string;
  model: string;
};

type ModelEntryLike = {
  alias?: string;
  capabilities?: string[];
  params?: Record<string, unknown>;
};

type LlmwsServerTarget = {
  url: string;
  capabilities: string[];
};

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeTag(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, "-");
}

function dedupeTags(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function toWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  // Match llmws-runner URL normalization (accept ws:\\host and ws:/host forms).
  const slashNormalized = trimmed.replace(/\\/g, "/");
  if (slashNormalized.includes("://")) {
    return slashNormalized;
  }
  const schemeSingleSlash = /^([a-z]+):\/(.+)$/i.exec(slashNormalized);
  if (schemeSingleSlash) {
    const [, scheme, rest] = schemeSingleSlash;
    return `${scheme.toLowerCase()}://${rest.replace(/^\/+/, "")}`;
  }
  return `ws://${slashNormalized.replace(/^\/+/, "")}`;
}

function dedupeLlmwsTargets(values: LlmwsServerTarget[]): LlmwsServerTarget[] {
  const out: LlmwsServerTarget[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const url = toWsUrl(entry.url);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push({
      url,
      capabilities: dedupeTags(entry.capabilities),
    });
  }
  return out;
}

function parseLlmwsServerTarget(raw: unknown): LlmwsServerTarget | null {
  if (typeof raw === "string") {
    const url = toWsUrl(raw);
    if (!url) {
      return null;
    }
    return { url, capabilities: [] };
  }
  if (!isRecord(raw)) {
    return null;
  }
  const url = readString(raw, "url") ?? readString(raw, "server");
  if (!url) {
    return null;
  }
  return {
    url: toWsUrl(url),
    capabilities: dedupeTags(readStringList(raw, "capabilities")),
  };
}

function parseLlmwsServerList(raw: unknown): LlmwsServerTarget[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const targets: LlmwsServerTarget[] = [];
  for (const entry of raw) {
    const parsed = parseLlmwsServerTarget(entry);
    if (!parsed) {
      continue;
    }
    targets.push(parsed);
  }
  return targets;
}

function parseEnvLlmwsTargets(): LlmwsServerTarget[] {
  const targets: LlmwsServerTarget[] = [];
  const list = process.env.OPENCLAW_LLMWS_SERVERS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const item of list ?? []) {
    targets.push({ url: item, capabilities: [] });
  }
  const single = process.env.OPENCLAW_LLMWS_SERVER?.trim();
  if (single) {
    targets.push({ url: single, capabilities: [] });
  }
  return targets;
}

function resolveLlmwsTargets(params: {
  cfg?: OpenClawConfig;
  modelParams?: Record<string, unknown>;
}): LlmwsServerTarget[] {
  const defaults = isRecord(params.cfg?.agents?.defaults?.llmws)
    ? params.cfg?.agents?.defaults?.llmws
    : {};
  const modelParams = params.modelParams ?? {};
  const modelServer = readString(modelParams, "server");
  const defaultServer = readString(defaults, "server");

  return dedupeLlmwsTargets([
    ...parseLlmwsServerList(modelParams.servers),
    ...(modelServer ? [{ url: modelServer, capabilities: [] }] : []),
    ...parseLlmwsServerList(defaults.servers),
    ...(defaultServer ? [{ url: defaultServer, capabilities: [] }] : []),
    ...parseEnvLlmwsTargets(),
    { url: DEFAULT_LLMWS_ENDPOINT, capabilities: [] },
  ]);
}

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): Record<string, unknown> | undefined {
  const providers = cfg?.models?.providers ?? {};
  const normalized = normalizeProviderId(provider);
  for (const [key, entry] of Object.entries(providers)) {
    if (normalizeProviderId(key) !== normalized || !isRecord(entry)) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function resolveProviderModelConfig(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): Record<string, unknown> | undefined {
  const providerCfg = resolveProviderConfig(params.cfg, params.provider);
  const models = providerCfg?.models;
  if (!Array.isArray(models)) {
    return undefined;
  }
  const normalizedModel = params.model.trim().toLowerCase();
  for (const raw of models) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = readString(raw, "id");
    if (!id || id.toLowerCase() !== normalizedModel) {
      continue;
    }
    return raw;
  }
  return undefined;
}

function resolveConfiguredModelMap(cfg?: OpenClawConfig): Map<string, ModelEntryLike> {
  const map = new Map<string, ModelEntryLike>();
  const configured = cfg?.agents?.defaults?.models ?? {};
  for (const [rawKey, rawEntry] of Object.entries(configured)) {
    const parsed = parseModelRef(String(rawKey ?? ""), DEFAULT_PROVIDER);
    if (!parsed || !isRecord(rawEntry)) {
      continue;
    }
    map.set(modelKey(parsed.provider, parsed.model), {
      alias: readString(rawEntry, "alias"),
      capabilities: readStringList(rawEntry, "capabilities"),
      params: isRecord(rawEntry.params) ? rawEntry.params : undefined,
    });
  }
  return map;
}

function resolveConfigListValues(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  const values = [];
  const primary = readString(value, "primary");
  if (primary) {
    values.push(primary);
  }
  const fallbacks = value.fallbacks;
  if (Array.isArray(fallbacks)) {
    for (const raw of fallbacks) {
      if (typeof raw !== "string") {
        continue;
      }
      const trimmed = raw.trim();
      if (trimmed) {
        values.push(trimmed);
      }
    }
  }
  return values;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 8) {
    return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  const head = Math.floor((maxChars - 1) / 2);
  const tail = maxChars - head - 1;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function collectModelRefs(params: {
  cfg?: OpenClawConfig;
  activeModel?: { provider: string; model: string };
}): ModelRef[] {
  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  const add = (provider: string, model: string) => {
    const normalizedProvider = normalizeProviderId(provider);
    const trimmedModel = model.trim();
    if (!normalizedProvider || !trimmedModel) {
      return;
    }
    const key = modelKey(normalizedProvider, trimmedModel);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push({ provider: normalizedProvider, model: trimmedModel });
  };
  const addRaw = (raw: string, defaultProvider: string) => {
    const parsed = parseModelRef(raw, defaultProvider);
    if (!parsed) {
      return;
    }
    add(parsed.provider, parsed.model);
  };

  const configured = params.cfg?.agents?.defaults?.models ?? {};
  for (const rawKey of Object.keys(configured)) {
    addRaw(rawKey, DEFAULT_PROVIDER);
  }

  for (const raw of resolveConfigListValues(params.cfg?.agents?.defaults?.model)) {
    addRaw(raw, DEFAULT_PROVIDER);
  }
  for (const raw of resolveConfigListValues(params.cfg?.agents?.defaults?.imageModel)) {
    addRaw(raw, DEFAULT_PROVIDER);
  }
  if (params.activeModel) {
    add(params.activeModel.provider, params.activeModel.model);
  }
  return refs;
}

function resolveModelServerHint(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  entry?: ModelEntryLike;
}): string | undefined {
  if (normalizeProviderId(params.provider) === "llmws") {
    const modelParams = params.entry?.params ?? {};
    const targets = resolveLlmwsTargets({
      cfg: params.cfg,
      modelParams,
    });
    if (targets.length === 0) {
      return undefined;
    }
    const preferredCapabilities = dedupeTags(readStringList(modelParams, "serverCapabilities"));
    const visible = targets.slice(0, 2).map((target) => {
      if (target.capabilities.length === 0) {
        return target.url;
      }
      return `${target.url}[${target.capabilities.join(",")}]`;
    });
    const more = targets.length > 2 ? ` +${targets.length - 2}` : "";
    const preferred =
      preferredCapabilities.length > 0 ? ` prefer=${preferredCapabilities.join(",")}` : "";
    return truncateMiddle(`${visible.join("; ")}${more}${preferred}`, 140);
  }

  const providerCfg = resolveProviderConfig(params.cfg, params.provider);
  const baseUrl = providerCfg ? readString(providerCfg, "baseUrl") : undefined;
  return baseUrl ? truncateMiddle(baseUrl, 120) : undefined;
}

function resolveDerivedModelCapabilities(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  entry?: ModelEntryLike;
}): string[] {
  const out: string[] = [];
  if (params.entry?.capabilities) {
    out.push(...params.entry.capabilities);
  }

  const providerModel = resolveProviderModelConfig({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
  });
  if (providerModel) {
    if (providerModel.reasoning === true) {
      out.push("reasoning");
    }
    if (Array.isArray(providerModel.input)) {
      const hasImage = providerModel.input.some((entry) => String(entry).trim() === "image");
      const hasText = providerModel.input.some((entry) => String(entry).trim() === "text");
      if (hasImage) {
        out.push("vision");
      }
      if (hasText) {
        out.push("text");
      }
    }
  }

  const normalizedProvider = normalizeProviderId(params.provider);
  if (normalizedProvider === "llmws") {
    out.push("llmws");
    const requestedServerCaps = readStringList(params.entry?.params ?? {}, "serverCapabilities");
    if (requestedServerCaps.length > 0) {
      out.push(...requestedServerCaps.map((entry) => `server-${entry}`));
    }
  } else if (normalizedProvider.endsWith("-cli")) {
    out.push("cli");
  }
  return dedupeTags(out);
}

export function resolveModelRuntimeCapabilities(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): string[] {
  const configured = resolveConfiguredModelMap(params.cfg);
  const key = modelKey(normalizeProviderId(params.provider), params.model.trim());
  const entry = configured.get(key);
  return resolveDerivedModelCapabilities({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    entry,
  });
}

export function buildModelCapabilityLines(params: {
  cfg?: OpenClawConfig;
  activeModel?: { provider: string; model: string };
  maxLines?: number;
}): string[] {
  const configured = resolveConfiguredModelMap(params.cfg);
  const refs = collectModelRefs({
    cfg: params.cfg,
    activeModel: params.activeModel,
  });
  const maxLines =
    typeof params.maxLines === "number" && Number.isFinite(params.maxLines) && params.maxLines > 0
      ? Math.floor(params.maxLines)
      : DEFAULT_MAX_CAPABILITY_LINES;
  if (refs.length === 0 || maxLines <= 0) {
    return [];
  }

  const lines: string[] = [];
  for (const ref of refs) {
    const key = modelKey(ref.provider, ref.model);
    const entry = configured.get(key);
    const capabilities = resolveDerivedModelCapabilities({
      cfg: params.cfg,
      provider: ref.provider,
      model: ref.model,
      entry,
    });
    const serverHint = resolveModelServerHint({
      cfg: params.cfg,
      provider: ref.provider,
      model: ref.model,
      entry,
    });
    const label = entry?.alias?.trim()
      ? `${entry.alias.trim()} -> ${ref.provider}/${ref.model}`
      : `${ref.provider}/${ref.model}`;
    const capabilityLabel = capabilities.length > 0 ? capabilities.join(",") : "general";
    const serverLabel = serverHint ? ` | server=${serverHint}` : "";
    lines.push(`- ${label} | caps=${capabilityLabel}${serverLabel}`);
  }

  if (lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines - 1), `- ... +${lines.length - (maxLines - 1)} more`];
}
