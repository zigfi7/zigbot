#!/usr/bin/env node

import { WebSocket } from "ws";

function normalizeWsUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const slashFixed = trimmed.replace(/\\/g, "/");
  if (/^[a-z]+:\/\//i.test(slashFixed)) {
    return slashFixed;
  }
  const oneSlash = /^([a-z]+):\/(.+)$/i.exec(slashFixed);
  if (oneSlash) {
    const [, scheme, rest] = oneSlash;
    return `${scheme.toLowerCase()}://${rest.replace(/^\/+/, "")}`;
  }
  return `ws://${slashFixed.replace(/^\/+/, "")}`;
}

function parseArgs(argv) {
  const opts = {
    timeoutMs: 5_000,
    json: false,
    endpoints: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      const raw = Number(argv[i + 1]);
      if (Number.isFinite(raw) && raw > 0) {
        opts.timeoutMs = Math.floor(raw);
      }
      i += 1;
      continue;
    }
    opts.endpoints.push(arg);
  }

  if (opts.endpoints.length === 0) {
    const fromEnv = [
      ...(process.env.OPENCLAW_LLMWS_SERVERS?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? []),
      ...(process.env.OPENCLAW_LLMWS_SERVER?.trim() ? [process.env.OPENCLAW_LLMWS_SERVER] : []),
    ];
    opts.endpoints = fromEnv;
  }

  opts.endpoints = opts.endpoints.map(normalizeWsUrl).filter(Boolean);
  return opts;
}

async function connectAndScan(url, timeoutMs) {
  return await new Promise((resolve) => {
    const result = {
      url,
      reachable: false,
      sessionId: undefined,
      welcomeModel: undefined,
      welcomeCapabilities: undefined,
      resourcesModel: undefined,
      availableModelsCount: undefined,
      availableModelsSample: [],
      error: undefined,
      timingsMs: {},
    };

    const started = Date.now();
    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      maxPayload: 25 * 1024 * 1024,
    });
    let state = "connecting";
    let done = false;

    const finish = (err) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(deadline);
      if (err) {
        result.error = err.message || String(err);
      }
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const deadline = setTimeout(() => finish(new Error("timeout")), timeoutMs + 2_000);

    const sendJson = async (payload) => {
      await new Promise((res, rej) => {
        ws.send(JSON.stringify(payload), (err) => {
          if (err) {
            rej(err);
            return;
          }
          res(undefined);
        });
      });
    };

    ws.on("open", async () => {
      result.timingsMs.open = Date.now() - started;
      try {
        await sendJson({});
        state = "await_welcome";
      } catch (err) {
        finish(err);
      }
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") {
        return;
      }
      const type = typeof msg.type === "string" ? msg.type : undefined;

      if (state === "await_welcome" && type === "welcome") {
        result.reachable = true;
        result.sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
        result.welcomeModel = typeof msg.model === "string" ? msg.model : undefined;
        result.welcomeCapabilities =
          msg.capabilities && typeof msg.capabilities === "object" ? msg.capabilities : undefined;
        result.timingsMs.welcome = Date.now() - started;
        try {
          await sendJson({ type: "get_resources" });
          state = "await_resources";
        } catch (err) {
          finish(err);
        }
        return;
      }

      if (state === "await_resources" && type === "resources") {
        const model = msg.model && typeof msg.model === "object" ? msg.model : undefined;
        if (model) {
          result.resourcesModel = {
            name: typeof model.name === "string" ? model.name : undefined,
            path: typeof model.path === "string" ? model.path : undefined,
            vision: typeof model.vision === "boolean" ? model.vision : undefined,
          };
        }
        const available = Array.isArray(msg.available_models) ? msg.available_models : [];
        result.availableModelsCount = available.length;
        result.availableModelsSample = available.slice(0, 8).map((entry) => ({
          name: typeof entry?.name === "string" ? entry.name : undefined,
          path: typeof entry?.path === "string" ? entry.path : undefined,
          source: typeof entry?.source === "string" ? entry.source : undefined,
        }));
        result.timingsMs.resources = Date.now() - started;
        finish();
        return;
      }

      if (type === "error") {
        finish(new Error(typeof msg.message === "string" ? msg.message : "server error"));
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => {
      if (!done && !result.reachable) {
        finish(new Error("closed"));
      }
    });
  });
}

function printTable(results) {
  const rows = results.map((entry) => {
    const caps = entry.welcomeCapabilities
      ? Object.entries(entry.welcomeCapabilities)
          .map(
            ([key, value]) =>
              `${key}=${Array.isArray(value) ? `[${value.join(",")}]` : String(value)}`,
          )
          .join(", ")
      : "-";
    const model = entry.resourcesModel?.name ?? entry.welcomeModel ?? "-";
    const available =
      typeof entry.availableModelsCount === "number" ? String(entry.availableModelsCount) : "-";
    const status = entry.reachable ? "ok" : `fail: ${entry.error ?? "unknown"}`;
    return {
      Endpoint: entry.url,
      Status: status,
      Model: model,
      Available: available,
      Capabilities: caps,
    };
  });

  const cols = ["Endpoint", "Status", "Model", "Available", "Capabilities"];
  const widths = Object.fromEntries(
    cols.map((col) => [col, Math.max(col.length, ...rows.map((row) => String(row[col]).length))]),
  );

  const line = cols.map((col) => String(col).padEnd(widths[col])).join(" | ");
  const sep = cols.map((col) => "-".repeat(widths[col])).join("-+-");
  console.log(line);
  console.log(sep);
  for (const row of rows) {
    console.log(cols.map((col) => String(row[col]).padEnd(widths[col])).join(" | "));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.endpoints.length === 0) {
    console.error(
      "Usage: node scripts/llmws-autoscan.mjs [--timeout 5000] [--json] ws://host:port ...",
    );
    process.exitCode = 1;
    return;
  }

  const scans = [];
  for (const endpoint of opts.endpoints) {
    scans.push(await connectAndScan(endpoint, opts.timeoutMs));
  }

  const report = {
    scannedAt: new Date().toISOString(),
    endpoints: scans,
  };

  if (!opts.json) {
    printTable(scans);
    console.log("");
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
