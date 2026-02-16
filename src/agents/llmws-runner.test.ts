import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { OpenClawConfig } from "../config/config.js";
import { rawDataToString } from "../infra/ws.js";
import { runLlmwsAgent } from "./llmws-runner.js";

type InferencePayload = {
  type?: string;
  prompt?: {
    system?: string;
    user?: string;
  };
  config?: Record<string, unknown>;
};

function extractPort(address: string): number {
  const url = new URL(address);
  return Number(url.port);
}

async function createLlmwsTestServer(params: {
  onInference: (
    payload: InferencePayload,
    send: (message: Record<string, unknown>) => void,
  ) => void;
  onHello?: (payload: Record<string, unknown>) => void;
  welcomeSessionId?: string | null;
}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const address = await new Promise<string>((resolve, reject) => {
    server.once("listening", () => {
      const info = server.address();
      if (!info || typeof info === "string") {
        reject(new Error("failed to resolve test server address"));
        return;
      }
      resolve(`ws://127.0.0.1:${info.port}`);
    });
    server.once("error", reject);
  });

  server.on("connection", (socket) => {
    let welcomed = false;
    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") {
        return;
      }
      const parsed = payload as InferencePayload & Record<string, unknown>;
      if (!welcomed) {
        welcomed = true;
        params.onHello?.(parsed);
        socket.send(
          JSON.stringify({
            type: "welcome",
            model: "test-model",
            ...(params.welcomeSessionId === null
              ? {}
              : params.welcomeSessionId !== undefined
                ? { session_id: params.welcomeSessionId }
                : { session_id: "llmws-session-test" }),
          }),
        );
        socket.send(
          JSON.stringify({
            uuid: "init-1",
            kind: "init",
            content: { type: "welcome" },
          }),
        );
        return;
      }
      if (parsed.type !== "inference") {
        return;
      }
      params.onInference(parsed, (message) => {
        socket.send(JSON.stringify(message));
      });
    });
  });

  return {
    address,
    port: extractPort(address),
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

describe("runLlmwsAgent", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-llmws-runner-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("falls through endpoint list and succeeds on a reachable server", async () => {
    const server = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        send({ type: "start", tokens_in: 10, max_tokens: 100 });
        send({ type: "token", data: "hello " });
        send({ type: "token", data: "world" });
        send({ type: "done", total_tokens: 2 });
      },
    });
    const sessionFile = path.join(tempDir, "session.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: ["ws://127.0.0.1:9", server.address],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-1",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "Say hello",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-1",
      });

      expect(result.payloads?.[0]?.text).toBe("hello world");
      expect(result.meta.agentMeta?.sessionId).toBe("llmws-session-test");
      expect(result.meta.agentMeta?.usage).toMatchObject({
        input: 10,
        output: 2,
        total: 12,
      });

      const transcript = await fs.readFile(sessionFile, "utf-8");
      expect(transcript).toContain('"type":"session"');
      expect(transcript).toContain("Say hello");
      expect(transcript).toContain("hello world");
    } finally {
      await server.close();
    }
  });

  it("accepts ws:\\\\host endpoint notation and normalizes it to ws://", async () => {
    const server = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        send({ type: "start", tokens_in: 7, max_tokens: 100 });
        send({ type: "token", data: "normalized" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-backslash-endpoint.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [`ws:\\\\127.0.0.1:${server.port}`],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-backslash-endpoint",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "Say normalized",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-backslash-endpoint",
      });

      expect(result.payloads?.[0]?.text).toBe("normalized");
    } finally {
      await server.close();
    }
  });

  it("continues when welcome has no session_id", async () => {
    const server = await createLlmwsTestServer({
      welcomeSessionId: null,
      onInference: (_payload, send) => {
        send({ type: "start", tokens_in: 5, max_tokens: 100 });
        send({ type: "token", data: "hello" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-no-welcome-id.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-no-id",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "Say hello",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-no-id",
      });

      expect(result.payloads?.[0]?.text).toBe("hello");
      expect(result.meta.agentMeta?.sessionId).toBeTruthy();
      expect(result.meta.agentMeta?.sessionId).not.toBe("session-no-id");
    } finally {
      await server.close();
    }
  });

  it("injects recent transcript history into the next prompt", async () => {
    const server = await createLlmwsTestServer({
      onInference: (payload, send) => {
        expect(payload.prompt?.user).toContain("Conversation history:");
        expect(payload.prompt?.user).toContain("old user");
        expect(payload.prompt?.user).toContain("old assistant");
        expect(payload.prompt?.user).toContain("Current user request:");
        send({ type: "start", tokens_in: 4, max_tokens: 100 });
        send({ type: "token", data: "ok" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-history.jsonl");
    const oldSessionLines = [
      JSON.stringify({
        type: "session",
        version: 7,
        id: "session-2",
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "old user" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
      }),
      "",
    ].join("\n");
    await fs.writeFile(sessionFile, oldSessionLines, "utf-8");

    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: true,
            historyTurns: 8,
            historyChars: 8_000,
          },
        },
      },
    } as OpenClawConfig;

    try {
      await runLlmwsAgent({
        sessionId: "session-2",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "new prompt",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-2",
      });
    } finally {
      await server.close();
    }
  });

  it("strips <think> reasoning tags from the final output", async () => {
    const server = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        send({ type: "start", tokens_in: 5, max_tokens: 100 });
        send({ type: "token", data: "<think>hidden</think>\n\nvisible" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-think-tags.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-think-1",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "ping",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-think-1",
      });

      expect(result.payloads?.[0]?.text).toBe("visible");
    } finally {
      await server.close();
    }
  });

  it("converts quota errors into FailoverError(rate_limit)", async () => {
    const server = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        send({ type: "error", message: "quota exceeded for this API key" });
      },
    });
    const sessionFile = path.join(tempDir, "session-quota.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      await expect(
        runLlmwsAgent({
          sessionId: "session-3",
          sessionFile,
          workspaceDir: tempDir,
          config: cfg,
          prompt: "ping",
          provider: "llmws",
          model: "qwen-8b",
          timeoutMs: 5_000,
          runId: "run-3",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        reason: "rate_limit",
      });
    } finally {
      await server.close();
    }
  });

  it("retries with a larger max_new_tokens when the server reports max_tokens <= tokens_in", async () => {
    let inferenceCount = 0;
    const server = await createLlmwsTestServer({
      onInference: (payload, send) => {
        inferenceCount += 1;

        if (inferenceCount === 1) {
          // Simulate the llmws_server.py bug: max_tokens (remaining budget) smaller than tokens_in.
          expect(payload.config?.max_new_tokens).toBe(32);
          send({ type: "start", tokens_in: 100, max_tokens: 10 });
          // No token/done emitted: the real server would hang here.
          return;
        }

        // Second attempt should fix budget: 2*tokens_in + desiredNewTokens
        expect(payload.config?.max_new_tokens).toBe(232);
        send({ type: "start", tokens_in: 100, max_tokens: 200 });
        send({ type: "token", data: "ok" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-retry-budget.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: false,
            config: {
              maxNewTokens: 32,
            },
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-retry-budget",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "ping",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-retry-budget",
      });

      expect(result.payloads?.[0]?.text).toBe("ok");
      expect(inferenceCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("sends remote session id in the initial hello payload when provided", async () => {
    let helloPayload: Record<string, unknown> | undefined;
    const server = await createLlmwsTestServer({
      onHello: (payload) => {
        helloPayload = payload;
      },
      onInference: (_payload, send) => {
        send({ type: "start", tokens_in: 3, max_tokens: 100 });
        send({ type: "token", data: "hello" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-remote-id.jsonl");
    const cfg = {
      agents: {
        defaults: {
          llmws: {
            servers: [server.address],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-remote-id",
        remoteSessionId: "remote-session-123",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "ping",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-remote-id",
      });

      expect(result.payloads?.[0]?.text).toBe("hello");
      expect(helloPayload?.session_id).toBe("remote-session-123");
    } finally {
      await server.close();
    }
  });

  it("prefers llmws server targets matching model serverCapabilities", async () => {
    let fastServerCalls = 0;
    let visionServerCalls = 0;
    const fastServer = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        fastServerCalls += 1;
        send({ type: "error", message: "wrong-target" });
      },
    });
    const visionServer = await createLlmwsTestServer({
      onInference: (_payload, send) => {
        visionServerCalls += 1;
        send({ type: "start", tokens_in: 6, max_tokens: 100 });
        send({ type: "token", data: "vision-first" });
        send({ type: "done", total_tokens: 1 });
      },
    });
    const sessionFile = path.join(tempDir, "session-cap-targets.jsonl");
    const cfg = {
      agents: {
        defaults: {
          models: {
            "llmws/qwen-8b": {
              params: {
                serverCapabilities: ["vision"],
              },
            },
          },
          llmws: {
            servers: [
              { url: fastServer.address, capabilities: ["fast"] },
              { url: visionServer.address, capabilities: ["vision"] },
            ],
            includeHistory: false,
          },
        },
      },
    } as OpenClawConfig;

    try {
      const result = await runLlmwsAgent({
        sessionId: "session-cap-targets",
        sessionFile,
        workspaceDir: tempDir,
        config: cfg,
        prompt: "analyze image",
        provider: "llmws",
        model: "qwen-8b",
        timeoutMs: 5_000,
        runId: "run-cap-targets",
      });

      expect(result.payloads?.[0]?.text).toBe("vision-first");
      expect(visionServerCalls).toBe(1);
      expect(fastServerCalls).toBe(0);
    } finally {
      await Promise.all([fastServer.close(), visionServer.close()]);
    }
  });
});
