import type { ResolvedZigmemConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";

const log = createSubsystemLogger("memory");
const DEFAULT_SNIPPET_MAX_CHARS = 700;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function clipSnippet(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function parseZigmemId(params: { relPath: string; pathPrefix: string }): string {
  const raw = params.relPath.trim();
  if (!raw) {
    throw new Error("path required");
  }
  const prefix = `${params.pathPrefix}:`;
  if (raw.startsWith(prefix)) {
    const id = raw.slice(prefix.length).trim();
    if (!id) {
      throw new Error("path required");
    }
    return id;
  }
  return raw;
}

export class ZigmemMemoryManager implements MemorySearchManager {
  constructor(private readonly config: ResolvedZigmemConfig) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const limit = clampPositiveInt(opts?.maxResults, this.config.maxResults);
    const url = new URL(`${this.config.baseUrl}/search`);
    url.searchParams.set("q", cleaned);
    url.searchParams.set("mode", this.config.mode);
    url.searchParams.set("limit", String(limit));

    const body = await this.requestJson(url);
    const rows = isRecord(body) && Array.isArray(body.items) ? body.items : [];
    const minScore =
      typeof opts?.minScore === "number" && Number.isFinite(opts.minScore)
        ? opts.minScore
        : undefined;

    const mapped: MemorySearchResult[] = [];
    for (const row of rows) {
      if (!isRecord(row)) {
        continue;
      }
      const id = asString(row.id);
      const text = asRawString(row.text) ?? "";
      if (!id || !text) {
        continue;
      }
      const score = asNumber(row.score) ?? 0;
      if (minScore !== undefined && score < minScore) {
        continue;
      }
      const snippet = clipSnippet(text, DEFAULT_SNIPPET_MAX_CHARS);
      const lineCount = Math.max(1, snippet.split("\n").length);
      mapped.push({
        path: `${this.config.pathPrefix}:${id}`,
        startLine: 1,
        endLine: lineCount,
        score,
        snippet,
        source: "memory",
      });
    }
    return mapped;
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const id = parseZigmemId({
      relPath: params.relPath,
      pathPrefix: this.config.pathPrefix,
    });
    const url = `${this.config.baseUrl}/content/${encodeURIComponent(id)}`;
    const body = await this.requestJson(url);
    if (!isRecord(body)) {
      throw new Error(`zigmem invalid content response for "${id}"`);
    }
    const text = asRawString(body.text) ?? "";
    if (!params.from && !params.lines) {
      return { text, path: `${this.config.pathPrefix}:${id}` };
    }
    const from = clampPositiveInt(params.from, 1);
    const lines = clampPositiveInt(params.lines, Number.MAX_SAFE_INTEGER);
    const chunks = text.split("\n");
    const slice = chunks.slice(from - 1, from - 1 + lines).join("\n");
    return { text: slice, path: `${this.config.pathPrefix}:${id}` };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "zigmem",
      provider: "zigmem",
      custom: {
        baseUrl: this.config.baseUrl,
        mode: this.config.mode,
        maxResults: this.config.maxResults,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const body = await this.requestJson(`${this.config.baseUrl}/embed`, {
        method: "POST",
        body: JSON.stringify({ text: "ping" }),
        headers: { "content-type": "application/json" },
      });
      if (!isRecord(body) || !Array.isArray(body.embedding)) {
        return { ok: false, error: "zigmem /embed response missing embedding" };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const url = new URL(`${this.config.baseUrl}/search`);
      url.searchParams.set("q", "ping");
      url.searchParams.set("mode", "semantic");
      url.searchParams.set("limit", "1");
      await this.requestJson(url);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}

  private async requestJson(urlOrPath: string | URL, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = this.buildHeaders(init?.headers);
    try {
      const response = await fetch(urlOrPath, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = {};
      if (raw.trim()) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`zigmem invalid JSON (${response.status})`);
        }
      }
      if (!response.ok) {
        const detail = isRecord(parsed) ? asString(parsed.detail) : undefined;
        throw new Error(`zigmem request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("aborted")) {
        throw new Error(`zigmem request timed out after ${this.config.timeoutMs}ms`, {
          cause: err,
        });
      }
      log.debug(`zigmem request failed: ${message}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(extra?: HeadersInit): HeadersInit {
    const out: Record<string, string> = {
      accept: "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      out.authorization = `Bearer ${this.config.apiKey}`;
    }
    if (extra instanceof Headers) {
      extra.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(extra)) {
      for (const [key, value] of extra) {
        out[key] = value;
      }
      return out;
    }
    return {
      ...out,
      ...extra,
    };
  }
}
