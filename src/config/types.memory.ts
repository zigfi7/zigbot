import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "zigmem";
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  zigmem?: MemoryZigmemConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

export type MemoryZigmemConfig = {
  /** Base URL for ZigMem API (e.g. http://127.0.0.1:8000). */
  baseUrl?: string;
  /** Optional bearer token (sent as Authorization header). */
  apiKey?: string;
  /** Optional additional headers for ZigMem requests. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Default ZigMem search mode. */
  mode?: "lexical" | "semantic" | "hybrid";
  /** Default max results per query. */
  maxResults?: number;
  /** Prefix for synthetic file paths exposed to memory_get. */
  pathPrefix?: string;
};
