type ToolCallFromText = {
  name: string;
  params: Record<string, unknown>;
};

const TOOL_CALL_PREFIX_RE = /^\s*(?:TOOL_CALL|CALL_TOOL)\s*:?\s*/i;

const CODE_FENCE_START_RE = /^\s*```[a-z0-9_-]*\s*\n/i;

const CODE_FENCE_END_RE = /\n\s*```\s*$/i;

const ALLOWED_KEYS = new Set([
  // tool name
  "name",
  "tool",
  "toolname",
  // params
  "arguments",
  "params",
  "input",
  // optional metadata
  "id",
  "reason",
  "comment",
  "notes",
  "meta",
  "thought",
  "analysis",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return text;
  }
  const withoutStart = trimmed.replace(CODE_FENCE_START_RE, "");
  return withoutStart.replace(CODE_FENCE_END_RE, "").trim();
}

function stripPrefix(text: string): string {
  return text.replace(TOOL_CALL_PREFIX_RE, "").trim();
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readToolName(obj: Record<string, unknown>): string | null {
  const candidates = [obj.name, obj.tool, obj.toolName];
  for (const entry of candidates) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function readToolParams(obj: Record<string, unknown>): Record<string, unknown> {
  const candidates = [obj.arguments, obj.params, obj.input];
  for (const entry of candidates) {
    if (isPlainRecord(entry)) {
      return entry;
    }
    if (typeof entry === "string") {
      const parsed = safeJsonParse(entry);
      if (isPlainRecord(parsed)) {
        return parsed;
      }
    }
  }
  return {};
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function parseToolCallFromText(text: string): ToolCallFromText | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }

  const stripped = stripPrefix(stripCodeFences(raw));
  if (!stripped) {
    return null;
  }

  const parsed = safeJsonParse(stripped);
  if (!isPlainRecord(parsed)) {
    return null;
  }

  // Avoid accidental triggers: only accept small, tool-ish objects.
  if (!hasOnlyAllowedKeys(parsed)) {
    return null;
  }

  const name = readToolName(parsed);
  if (!name) {
    return null;
  }

  return {
    name,
    params: readToolParams(parsed),
  };
}
