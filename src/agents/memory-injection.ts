import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

const log = createSubsystemLogger("agent/memory-injection");

export const DEFAULT_MEMORY_INJECTION_MAX_RESULTS = 4;
export const DEFAULT_MEMORY_INJECTION_MAX_CHARS = 1_800;
export const DEFAULT_MEMORY_INJECTION_HEADER =
  "Relevant memory snippets (ZigMem). Use only if helpful; ignore if irrelevant:";

function parseEnvPositiveInt(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) {
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    return Math.max(1, Math.floor(parsed));
  }
  return fallback;
}

export function buildPromptWithMemoryInjection(params: {
  prompt: string;
  injection?: string;
}): string {
  const prompt = params.prompt.trim();
  const injection = params.injection?.trim();
  if (!injection) {
    return prompt;
  }
  return `${injection}\n\nCurrent user request:\n${prompt}`;
}

export function formatMemoryInjection(
  results: Array<{ snippet: string }>,
  budgetChars: number,
  header: string = DEFAULT_MEMORY_INJECTION_HEADER,
): string | undefined {
  const budget = Math.max(0, Math.floor(budgetChars));
  if (budget <= 0) {
    return undefined;
  }

  const headerText = header.trim() || DEFAULT_MEMORY_INJECTION_HEADER;
  const lines: string[] = [headerText];
  let used = headerText.length + 1;

  for (const entry of results) {
    if (used >= budget) {
      break;
    }
    const snippet = String(entry?.snippet ?? "").trim();
    if (!snippet) {
      continue;
    }
    const prefix = "- ";
    const available = budget - used - prefix.length;
    if (available <= 0) {
      break;
    }
    const clipped =
      snippet.length <= available ? snippet : `${snippet.slice(0, Math.max(0, available - 1))}…`;
    lines.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length + 1;
  }

  if (lines.length <= 1) {
    return undefined;
  }
  return lines.join("\n");
}

export async function resolveZigmemMemoryInjection(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  query: string;
  maxResultsDefault?: number;
  maxCharsDefault?: number;
  maxResultsEnvVars?: string[];
  maxCharsEnvVars?: string[];
  header?: string;
  logContext?: string;
}): Promise<string | undefined> {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }

  const query = params.query.trim();
  if (!query) {
    return undefined;
  }

  const resolved = resolveMemoryBackendConfig({ cfg, agentId: params.agentId });
  if (resolved.backend !== "zigmem") {
    return undefined;
  }

  const { manager } = await getMemorySearchManager({ cfg, agentId: params.agentId });
  if (!manager) {
    return undefined;
  }

  const maxResults = parseEnvPositiveInt(
    params.maxResultsEnvVars ?? ["OPENCLAW_MEMORY_INJECTION_MAX_RESULTS"],
    params.maxResultsDefault ?? DEFAULT_MEMORY_INJECTION_MAX_RESULTS,
  );
  const maxChars = parseEnvPositiveInt(
    params.maxCharsEnvVars ?? ["OPENCLAW_MEMORY_INJECTION_MAX_CHARS"],
    params.maxCharsDefault ?? DEFAULT_MEMORY_INJECTION_MAX_CHARS,
  );

  try {
    const results = await manager.search(query, {
      maxResults,
      sessionKey: params.sessionKey,
    });
    if (!results || results.length === 0) {
      return undefined;
    }
    return formatMemoryInjection(results, maxChars, params.header);
  } catch (err) {
    const context = params.logContext ? `${params.logContext}: ` : "";
    log.debug(
      `${context}zigmem injection skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
