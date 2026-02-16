import type { ImageContent } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { isRecord } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { buildSystemPrompt } from "./cli-runner/helpers.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { resolveZigmemMemoryInjection } from "./memory-injection.js";
import { classifyFailoverReason } from "./pi-embedded-helpers.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/llmws");

const DEFAULT_LLMWS_ENDPOINT = "ws://127.0.0.1:8765";
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_HISTORY_CHARS = 12_000;
const DEFAULT_CONTEXT_FILES_TOTAL_MAX_CHARS = 6_000;
const DEFAULT_CONTEXT_FILES_FILE_MAX_CHARS = 4_000;
const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
]);

type LlmwsGenerationConfig = {
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  do_sample?: boolean;
};

type LlmwsGenerationNumberKey = Exclude<keyof LlmwsGenerationConfig, "do_sample">;
type LlmwsGenerationBooleanKey = "do_sample";

type LlmwsTarget = {
  url: string;
  capabilities: string[];
};

type LlmwsRuntimeSettings = {
  targets: LlmwsTarget[];
  connectTimeoutMs: number;
  readTimeoutMs: number;
  includeHistory: boolean;
  historyTurns: number;
  historyChars: number;
  generation: LlmwsGenerationConfig;
};

type LlmwsParsedMessage = Record<string, unknown>;

type LlmwsRunAttemptResult = {
  text: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
};

function toWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  // Accept common typos/escapes like ws:\\host:port and ws:/host:port.
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

function normalizeCapabilityTag(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, "-");
}

function dedupeCapabilityTags(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeCapabilityTag(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function dedupeTargets(values: LlmwsTarget[]): LlmwsTarget[] {
  const out: LlmwsTarget[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = toWsUrl(raw.url);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push({
      url: value,
      capabilities: dedupeCapabilityTags(raw.capabilities),
    });
  }
  return out;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
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

function parseServerEntry(raw: unknown): LlmwsTarget | null {
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
    capabilities: dedupeCapabilityTags(readStringList(raw, "capabilities")),
  };
}

function readServerList(record: Record<string, unknown>, key: string): LlmwsTarget[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const out: LlmwsTarget[] = [];
  for (const entry of value) {
    const parsed = parseServerEntry(entry);
    if (!parsed) {
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function parseEnvTargets(): LlmwsTarget[] {
  const list = process.env.OPENCLAW_LLMWS_SERVERS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const single = process.env.OPENCLAW_LLMWS_SERVER?.trim();
  return [
    ...(list ?? []).map((url) => ({ url, capabilities: [] })),
    ...(single ? [{ url: single, capabilities: [] }] : []),
  ];
}

function resolvePreferredServerCapabilities(modelParams: Record<string, unknown>): string[] {
  return dedupeCapabilityTags([
    ...readStringList(modelParams, "serverCapabilities"),
    ...readStringList(modelParams, "preferredServerCapabilities"),
    ...readStringList(modelParams, "preferredCapabilities"),
  ]);
}

function sortTargetsByCapabilities(targets: LlmwsTarget[], preferred: string[]): LlmwsTarget[] {
  if (preferred.length === 0 || targets.length <= 1) {
    return targets;
  }
  const preferredSet = new Set(preferred.map((tag) => normalizeCapabilityTag(tag)));
  return [...targets].toSorted((left, right) => {
    const leftCaps = new Set(left.capabilities.map((tag) => normalizeCapabilityTag(tag)));
    const rightCaps = new Set(right.capabilities.map((tag) => normalizeCapabilityTag(tag)));
    const leftMatches = Array.from(preferredSet).filter((tag) => leftCaps.has(tag)).length;
    const rightMatches = Array.from(preferredSet).filter((tag) => rightCaps.has(tag)).length;
    const leftAll = leftMatches === preferredSet.size;
    const rightAll = rightMatches === preferredSet.size;
    if (leftAll !== rightAll) {
      return leftAll ? -1 : 1;
    }
    if (leftMatches !== rightMatches) {
      return rightMatches - leftMatches;
    }
    return 0;
  });
}

function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function resolveModelParams(
  config: OpenClawConfig | undefined,
  provider: string,
  model: string,
): Record<string, unknown> {
  const models = config?.agents?.defaults?.models ?? {};
  const key = `${provider}/${model}`;
  const entry = models[key];
  if (!entry || !isRecord(entry) || !isRecord(entry.params)) {
    return {};
  }
  return entry.params;
}

function resolveGenerationConfig(params: {
  defaults: Record<string, unknown>;
  modelParams: Record<string, unknown>;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
}): LlmwsGenerationConfig {
  const out: LlmwsGenerationConfig = {};
  const setNumber = (key: LlmwsGenerationNumberKey, value?: number) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  };
  const setBoolean = (key: LlmwsGenerationBooleanKey, value?: boolean) => {
    if (typeof value === "boolean") {
      out[key] = value;
    }
  };

  const defaultsConfig = isRecord(params.defaults.config) ? params.defaults.config : {};
  const modelConfig = isRecord(params.modelParams.config) ? params.modelParams.config : {};

  const getNumber = (key: string, fallback?: number) =>
    readNumber(modelConfig, key) ??
    readNumber(params.modelParams, key) ??
    readNumber(defaultsConfig, key) ??
    readNumber(params.defaults, key) ??
    fallback;
  const getBoolean = (key: string, fallback?: boolean) =>
    readBoolean(modelConfig, key) ??
    readBoolean(params.modelParams, key) ??
    readBoolean(defaultsConfig, key) ??
    readBoolean(params.defaults, key) ??
    fallback;

  setNumber("max_new_tokens", getNumber("max_new_tokens", getNumber("maxNewTokens")));
  setNumber("temperature", getNumber("temperature"));
  setNumber("top_p", getNumber("top_p", getNumber("topP")));
  setNumber("top_k", getNumber("top_k", getNumber("topK")));
  setNumber("repetition_penalty", getNumber("repetition_penalty", getNumber("repetitionPenalty")));
  setBoolean("do_sample", getBoolean("do_sample", getBoolean("doSample")));

  if (typeof params.streamParams?.temperature === "number") {
    setNumber("temperature", params.streamParams.temperature);
  }
  if (typeof params.streamParams?.maxTokens === "number") {
    setNumber("max_new_tokens", params.streamParams.maxTokens);
  }

  return out;
}

function resolveLlmwsRuntimeSettings(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  timeoutMs: number;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
}): LlmwsRuntimeSettings {
  const llmwsDefaults = isRecord(params.config?.agents?.defaults?.llmws)
    ? params.config.agents?.defaults?.llmws
    : {};
  const modelParams = resolveModelParams(params.config, params.provider, params.model);
  const modelServer = parseServerEntry(readString(modelParams, "server"));
  const defaultServer = parseServerEntry(readString(llmwsDefaults, "server"));
  const preferredServerCapabilities = resolvePreferredServerCapabilities(modelParams);

  const targets = sortTargetsByCapabilities(
    dedupeTargets([
      ...readServerList(modelParams, "servers"),
      ...(modelServer ? [modelServer] : []),
      ...readServerList(llmwsDefaults, "servers"),
      ...(defaultServer ? [defaultServer] : []),
      ...parseEnvTargets(),
      { url: DEFAULT_LLMWS_ENDPOINT, capabilities: [] },
    ]),
    preferredServerCapabilities,
  );

  const connectTimeoutMs = Math.max(
    1,
    Math.floor(
      readNumber(modelParams, "connectTimeoutMs") ??
        readNumber(llmwsDefaults, "connectTimeoutMs") ??
        Math.min(DEFAULT_CONNECT_TIMEOUT_MS, params.timeoutMs),
    ),
  );
  const readTimeoutMs = Math.max(
    1,
    Math.floor(
      readNumber(modelParams, "readTimeoutMs") ??
        readNumber(llmwsDefaults, "readTimeoutMs") ??
        params.timeoutMs,
    ),
  );
  const includeHistory =
    readBoolean(modelParams, "includeHistory") ??
    readBoolean(llmwsDefaults, "includeHistory") ??
    true;
  const historyTurns = Math.max(
    0,
    Math.floor(
      readNumber(modelParams, "historyTurns") ??
        readNumber(llmwsDefaults, "historyTurns") ??
        DEFAULT_HISTORY_TURNS,
    ),
  );
  const historyChars = Math.max(
    0,
    Math.floor(
      readNumber(modelParams, "historyChars") ??
        readNumber(llmwsDefaults, "historyChars") ??
        DEFAULT_HISTORY_CHARS,
    ),
  );
  const generation = resolveGenerationConfig({
    defaults: llmwsDefaults,
    modelParams,
    streamParams: params.streamParams,
  });

  return {
    targets,
    connectTimeoutMs,
    readTimeoutMs,
    includeHistory,
    historyTurns,
    historyChars,
    generation,
  };
}

class LlmwsMessageQueue {
  private queue: LlmwsParsedMessage[] = [];
  private waiters: Array<{
    resolve: (message: LlmwsParsedMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private terminalError: Error | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onRawData(rawDataToString(data)));
    ws.on("error", (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", (code, reason) => {
      this.fail(new Error(`LLMWS socket closed (${code}): ${rawDataToString(reason)}`));
    });
  }

  async next(timeoutMs: number): Promise<LlmwsParsedMessage> {
    if (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        return item;
      }
    }
    if (this.terminalError) {
      throw this.terminalError;
    }
    return await new Promise<LlmwsParsedMessage>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) {
              this.waiters.splice(index, 1);
            }
            reject(new Error(`LLMWS read timeout (${timeoutMs}ms)`));
          },
          Math.max(1, timeoutMs),
        ),
      };
      this.waiters.push(waiter);
    });
  }

  private onRawData(raw: string) {
    const lines = raw.split(/\r?\n/g).map((line) => line.trim());
    for (const line of lines) {
      if (!line) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      this.push(parsed);
    }
  }

  private push(message: LlmwsParsedMessage) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  private fail(error: Error) {
    if (!this.terminalError) {
      this.terminalError = error;
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(this.terminalError);
    }
  }
}

async function openLlmwsSocket(
  target: string,
  connectTimeoutMs: number,
): Promise<{
  ws: WebSocket;
  queue: LlmwsMessageQueue;
}> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(target, {
      handshakeTimeout: connectTimeoutMs,
      maxPayload: 25 * 1024 * 1024,
    });
    const queue = new LlmwsMessageQueue(ws);
    let settled = false;

    const timer = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        ws.terminate();
        reject(new Error(`LLMWS connect timeout (${connectTimeoutMs}ms)`));
      },
      Math.max(1, connectTimeoutMs),
    );

    ws.once("open", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ws, queue });
    });
    ws.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      ws.terminate();
      done();
    }, 1_000);
    ws.once("close", () => {
      clearTimeout(timer);
      done();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

async function sendJson(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
  const encoded = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    ws.send(encoded, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function hasConnectivityHint(error: unknown, message: string): boolean {
  if (isRecord(error)) {
    const code = readString(error, "code")?.toUpperCase();
    if (code && CONNECTIVITY_ERROR_CODES.has(code)) {
      return true;
    }
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("connect timeout") ||
    lower.includes("read timeout") ||
    lower.includes("socket closed") ||
    lower.includes("connection closed") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("timed out")
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (!error) {
    return "";
  }
  if (typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return "unknown error";
    }
  }
  return "unknown error";
}

function toFailoverError(error: unknown, provider: string, model: string): FailoverError {
  if (error instanceof FailoverError) {
    return error;
  }
  const message = describeError(error).trim() || "LLMWS request failed";
  const classified = classifyFailoverReason(message);
  const reason = classified ?? (hasConnectivityHint(error, message) ? "timeout" : "unknown");
  return new FailoverError(message, {
    reason,
    provider,
    model,
    status: resolveFailoverStatus(reason),
    cause: error instanceof Error ? error : undefined,
  });
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (typeof block.content === "string") {
        parts.push(block.content);
        continue;
      }
      if (typeof block.thinking === "string") {
        parts.push(block.thinking);
      }
    }
    return parts.join("\n");
  }
  if (isRecord(content)) {
    if (typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.content === "string") {
      return content.content;
    }
  }
  return "";
}

function normalizeTranscriptText(text: string): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\n{3,}/g, "\n\n");
}

async function readHistoryContext(params: {
  sessionFile: string;
  historyTurns: number;
  historyChars: number;
}): Promise<string | undefined> {
  if (params.historyTurns <= 0 || params.historyChars <= 0) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.readFile(params.sessionFile, "utf-8");
  } catch {
    return undefined;
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const parsed: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const role = readString(entry.message, "role")?.toLowerCase();
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = normalizeTranscriptText(extractTextFromContent(entry.message.content));
    if (!text) {
      continue;
    }
    if (role === "assistant" && isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      continue;
    }
    parsed.push({ role, text });
  }

  if (parsed.length === 0) {
    return undefined;
  }

  const selected: string[] = [];
  let usedChars = 0;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    if (selected.length >= params.historyTurns) {
      break;
    }
    const item = parsed[i];
    const label = item.role === "user" ? "User" : "Assistant";
    const block = `${label}: ${item.text}`;
    if (usedChars > 0 && usedChars + block.length + 2 > params.historyChars) {
      break;
    }
    if (usedChars === 0 && block.length > params.historyChars) {
      selected.push(`${block.slice(0, Math.max(0, params.historyChars - 1))}…`);
      usedChars = params.historyChars;
      break;
    }
    selected.push(block);
    usedChars += block.length + 2;
  }

  if (selected.length === 0) {
    return undefined;
  }

  selected.reverse();
  return `Conversation history:\n${selected.join("\n\n")}`;
}

function clampEmbeddedContextFiles(
  files: Array<{ path: string; content: string }>,
  opts: { maxTotalChars: number; maxFileChars: number },
): Array<{ path: string; content: string }> {
  const maxTotal = Math.max(0, Math.floor(opts.maxTotalChars));
  const maxFile = Math.max(0, Math.floor(opts.maxFileChars));
  if (maxTotal <= 0 || maxFile <= 0) {
    return [];
  }

  const out: Array<{ path: string; content: string }> = [];
  let used = 0;
  for (const file of files) {
    if (used >= maxTotal) {
      break;
    }
    const pathValue = String(file?.path ?? "").trim();
    const contentValue = String(file?.content ?? "").trim();
    if (!pathValue || !contentValue) {
      continue;
    }

    const available = Math.min(maxFile, maxTotal - used);
    if (available <= 0) {
      break;
    }
    const clipped =
      contentValue.length <= available
        ? contentValue
        : `${contentValue.slice(0, Math.max(0, available - 1))}…`;
    if (!clipped) {
      continue;
    }
    out.push({ path: pathValue, content: clipped });
    used += clipped.length;
  }
  return out;
}

function normalizeImageBase64(raw: string): string {
  const trimmed = raw.trim();
  const marker = ";base64,";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex === -1) {
    return trimmed;
  }
  return trimmed.slice(markerIndex + marker.length);
}

function imageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().trim();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return ".jpg";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  return ".png";
}

function buildMediaPayload(images: ImageContent[] | undefined): Array<Record<string, unknown>> {
  if (!images || images.length === 0) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const data = normalizeImageBase64(image.data ?? "");
    if (!data) {
      continue;
    }
    const ext = imageExtension(image.mimeType ?? "");
    out.push({
      type: "image",
      data,
      name: `image-${i + 1}${ext}`,
    });
  }
  return out;
}

async function appendTranscriptMessages(params: {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: 10_000,
  });
  try {
    let existing = "";
    try {
      existing = await fs.readFile(params.sessionFile, "utf-8");
    } catch (err) {
      const code = isRecord(err) ? readString(err, "code") : undefined;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    const lines = existing
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    let hasHeader = false;
    let lastMessageId: string | null = null;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      if (parsed.type === "session") {
        hasHeader = true;
      }
      if (parsed.type === "message") {
        const id = readString(parsed, "id");
        if (id) {
          lastMessageId = id;
        }
      }
    }

    const now = new Date().toISOString();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const additions: string[] = [];
    if (!hasHeader) {
      additions.push(
        JSON.stringify({
          type: "session",
          version: 7,
          id: params.sessionId,
          timestamp: now,
          cwd: path.resolve(params.workspaceDir),
        }),
      );
    }
    additions.push(
      JSON.stringify({
        type: "message",
        id: userId,
        parentId: lastMessageId,
        timestamp: now,
        message: {
          role: "user",
          content: [{ type: "text", text: params.userText }],
        },
      }),
    );
    additions.push(
      JSON.stringify({
        type: "message",
        id: assistantId,
        parentId: userId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: params.assistantText }],
        },
      }),
    );

    const prefix = lines.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(params.sessionFile, `${prefix}${additions.join("\n")}\n`, "utf-8");
  } finally {
    await lock.release();
  }
}

async function runLlmwsAttempt(params: {
  target: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  resumeSessionId?: string;
  systemPrompt: string;
  userPrompt: string;
  media: Array<Record<string, unknown>>;
  generation: LlmwsGenerationConfig;
}): Promise<LlmwsRunAttemptResult> {
  // llmws_server.py (as deployed in the wild) has a known bug:
  // it computes `max_tokens = max_new_tokens - tokens_in` and then loops while
  // `generated_len < max_tokens`. If `max_tokens <= tokens_in`, it never enters
  // the loop and never emits `done`, causing clients to hang until timeout.
  //
  // Workaround: if the server reports `max_tokens <= tokens_in`, retry once with
  // `max_new_tokens = 2*tokens_in + desiredNewTokens`. This makes the buggy loop
  // behave like an actual "max new tokens" budget.
  let generation: LlmwsGenerationConfig = { ...params.generation };
  let retriedForTokenBudget = false;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const { ws, queue } = await openLlmwsSocket(params.target, params.connectTimeoutMs);
    let needsRetry = false;
    try {
      const helloPayload: Record<string, unknown> = {};
      const resumeSessionId = params.resumeSessionId?.trim();
      if (resumeSessionId) {
        helloPayload.session_id = resumeSessionId;
      }
      await sendJson(ws, helloPayload);

      const welcomeDeadline = Date.now() + params.readTimeoutMs;
      let sessionId: string | undefined;
      let sawWelcome = false;

      while (!sawWelcome) {
        const remaining = welcomeDeadline - Date.now();
        if (remaining <= 0) {
          throw new Error("LLMWS welcome timeout");
        }
        const message = await queue.next(remaining);
        if (readString(message, "type") !== "welcome") {
          continue;
        }
        sawWelcome = true;
        sessionId = readString(message, "session_id");
      }
      if (!sessionId) {
        sessionId = randomUUID();
      }

      await sendJson(ws, {
        type: "inference",
        prompt: {
          system: params.systemPrompt,
          user: params.userPrompt,
        },
        media: params.media,
        config: generation,
      });

      let readDeadline = Date.now() + params.readTimeoutMs;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let done = false;
      let text = "";

      while (!done) {
        const remaining = readDeadline - Date.now();
        if (remaining <= 0) {
          throw new Error("LLMWS stream timeout");
        }
        const message = await queue.next(remaining);
        readDeadline = Date.now() + params.readTimeoutMs;
        const type = readString(message, "type");
        if (type === "start") {
          const tokensIn = readNumber(message, "tokens_in");
          const maxTokens = readNumber(message, "max_tokens");
          if (typeof tokensIn === "number") {
            inputTokens = tokensIn;
          }

          if (
            !retriedForTokenBudget &&
            typeof tokensIn === "number" &&
            typeof maxTokens === "number" &&
            tokensIn > 0 &&
            maxTokens <= tokensIn
          ) {
            // Retry with corrected "max new tokens" semantics.
            const desiredNewTokens = generation.max_new_tokens;
            if (
              typeof desiredNewTokens !== "number" ||
              !Number.isFinite(desiredNewTokens) ||
              desiredNewTokens <= 0
            ) {
              throw new Error(
                `LLMWS server token budget invalid (tokens_in=${tokensIn}, max_tokens=${maxTokens}). Configure llmws.config.maxNewTokens (or update llmws_server.py).`,
              );
            }
            generation = {
              ...generation,
              max_new_tokens: Math.floor(tokensIn * 2 + desiredNewTokens),
            };
            retriedForTokenBudget = true;
            needsRetry = true;
            break;
          }

          continue;
        }
        if (type === "token") {
          // Preserve whitespace exactly as streamed by the server (token chunks can end in spaces/newlines).
          const chunkValue = message.data;
          if (typeof chunkValue === "string") {
            text += chunkValue;
          }
          continue;
        }
        if (type === "done") {
          const total = readNumber(message, "total_tokens");
          if (typeof total === "number") {
            outputTokens = total;
          }
          done = true;
          continue;
        }
        if (type === "error") {
          const errorMessage = readString(message, "message") ?? "LLMWS returned an error";
          throw new Error(errorMessage);
        }
      }

      if (needsRetry) {
        continue;
      }

      const usage =
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              input: inputTokens,
              output: outputTokens,
              total:
                (inputTokens ?? 0) + (outputTokens ?? 0) > 0
                  ? (inputTokens ?? 0) + (outputTokens ?? 0)
                  : undefined,
            }
          : undefined;

      return {
        text: text.trim(),
        sessionId,
        usage,
      };
    } finally {
      await closeSocket(ws);
    }
  }

  throw new Error("LLMWS retry failed: server did not accept adjusted token budget");
}

export async function runLlmwsAgent(params: {
  sessionId: string;
  remoteSessionId?: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const modelId = (params.model ?? "default").trim() || "default";
  try {
    const workspaceResolution = resolveRunWorkspaceDir({
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.config,
    });
    const resolvedWorkspace = workspaceResolution.workspaceDir;
    const redactedSessionId = redactRunIdentifier(params.sessionId);
    const redactedSessionKey = redactRunIdentifier(params.sessionKey);
    const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
    if (workspaceResolution.usedFallback) {
      log.warn(
        `[workspace-fallback] caller=runLlmwsAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
      );
    }
    const workspaceDir = resolvedWorkspace;

    const runtimeSettings = resolveLlmwsRuntimeSettings({
      config: params.config,
      provider: params.provider,
      model: modelId,
      timeoutMs: params.timeoutMs,
      streamParams: params.streamParams,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
    });
    const contextFilesClamped = clampEmbeddedContextFiles(contextFiles, {
      maxTotalChars: parseEnvPositiveInt(
        "OPENCLAW_LLMWS_CONTEXT_FILES_MAX_CHARS",
        DEFAULT_CONTEXT_FILES_TOTAL_MAX_CHARS,
      ),
      maxFileChars: parseEnvPositiveInt(
        "OPENCLAW_LLMWS_CONTEXT_FILE_MAX_CHARS",
        DEFAULT_CONTEXT_FILES_FILE_MAX_CHARS,
      ),
    });
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const heartbeatPrompt =
      sessionAgentId === defaultAgentId
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined;
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });

    const extraSystemPrompt = [
      params.extraSystemPrompt?.trim(),
      "Tools are disabled in this session. Do not call tools.",
    ]
      .filter(Boolean)
      .join("\n");
    const modelDisplay = `${params.provider}/${modelId}`;
    const systemPrompt = buildSystemPrompt({
      workspaceDir,
      config: params.config,
      defaultThinkLevel: params.thinkLevel,
      extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      heartbeatPrompt,
      docsPath: docsPath ?? undefined,
      tools: [],
      contextFiles: contextFilesClamped,
      modelDisplay,
      agentId: sessionAgentId,
      // Local LLMWS models are more sensitive to long, multi-section system prompts.
      // "minimal" drops heartbeats/silent-reply sections (NO_REPLY) and reduces tokens-in.
      promptMode: "minimal",
    });

    const historyContext =
      runtimeSettings.includeHistory && params.sessionFile
        ? await readHistoryContext({
            sessionFile: params.sessionFile,
            historyTurns: runtimeSettings.historyTurns,
            historyChars: runtimeSettings.historyChars,
          })
        : undefined;
    const memoryInjection = await resolveZigmemMemoryInjection({
      cfg: params.config,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      query: params.prompt,
      maxResultsEnvVars: [
        "OPENCLAW_LLMWS_MEMORY_INJECTION_MAX_RESULTS",
        "OPENCLAW_MEMORY_INJECTION_MAX_RESULTS",
      ],
      maxCharsEnvVars: [
        "OPENCLAW_LLMWS_MEMORY_INJECTION_MAX_CHARS",
        "OPENCLAW_MEMORY_INJECTION_MAX_CHARS",
      ],
      logContext: "llmws",
    });
    const promptParts: string[] = [];
    if (historyContext) {
      promptParts.push(historyContext);
    }
    if (memoryInjection) {
      promptParts.push(memoryInjection);
    }
    if (promptParts.length > 0) {
      promptParts.push(`Current user request:\n${params.prompt}`);
    }
    const promptBody = promptParts.length > 0 ? promptParts.join("\n\n") : params.prompt;

    const media = buildMediaPayload(params.images);

    let attemptResult: LlmwsRunAttemptResult | null = null;
    const endpointErrors: string[] = [];
    for (const target of runtimeSettings.targets) {
      const targetUrl = target.url;
      try {
        attemptResult = await runLlmwsAttempt({
          target: targetUrl,
          connectTimeoutMs: runtimeSettings.connectTimeoutMs,
          readTimeoutMs: runtimeSettings.readTimeoutMs,
          resumeSessionId: params.remoteSessionId,
          systemPrompt,
          userPrompt: promptBody,
          media,
          generation: runtimeSettings.generation,
        });
        break;
      } catch (err) {
        endpointErrors.push(`${targetUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!attemptResult) {
      const message =
        endpointErrors.length > 0
          ? `LLMWS endpoints failed: ${endpointErrors.join(" | ")}`
          : "LLMWS endpoints failed";
      throw new Error(message);
    }

    const finalText = stripReasoningTagsFromText(attemptResult.text);
    if (finalText) {
      try {
        await appendTranscriptMessages({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          workspaceDir,
          userText: params.prompt,
          assistantText: finalText,
        });
      } catch (err) {
        log.warn(`failed to persist llmws transcript: ${String(err)}`);
      }
    }

    return {
      payloads: finalText ? [{ text: finalText }] : undefined,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: attemptResult.sessionId ?? params.sessionId,
          provider: params.provider,
          model: modelId,
          usage: attemptResult.usage,
        },
      },
    };
  } catch (error) {
    throw toFailoverError(error, params.provider, modelId);
  }
}
