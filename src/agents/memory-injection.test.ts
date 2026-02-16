import { describe, expect, it } from "vitest";
import { buildPromptWithMemoryInjection, formatMemoryInjection } from "./memory-injection.js";

describe("memory-injection", () => {
  it("prepends memory injection and current request marker", () => {
    const merged = buildPromptWithMemoryInjection({
      prompt: "Nowe pytanie",
      injection: "Relevant memory snippets (ZigMem):\n- Fakt A",
    });

    expect(merged).toContain("Relevant memory snippets (ZigMem):");
    expect(merged).toContain("Current user request:");
    expect(merged).toContain("Nowe pytanie");
  });

  it("formats snippets within budget and truncates overflow", () => {
    const out = formatMemoryInjection(
      [{ snippet: "Pierwszy bardzo dlugi fragment pamieci do skracania" }, { snippet: "Drugi" }],
      50,
      "Mem:",
    );

    expect(out).toBeDefined();
    expect(out).toContain("Mem:");
    expect(out).toContain("- ");
    expect(out).toContain("…");
  });
});
