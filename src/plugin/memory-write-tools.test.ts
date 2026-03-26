import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWriteBootToolFactory } from "./memory-write-tools.js";

function createVaultFixture(memoryContent?: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-memory-write-tools-"));
  fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ name: "test" }), "utf-8");
  if (typeof memoryContent === "string") {
    fs.writeFileSync(path.join(vaultPath, "MEMORY.md"), memoryContent, "utf-8");
  }
  return vaultPath;
}

describe("memory_write_boot tool", () => {
  const vaults: string[] = [];

  afterEach(() => {
    for (const vaultPath of vaults.splice(0)) {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it("upserts a missing section and returns citations + modified section metadata", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n## Goals\n- Keep focus\n\n## Scratchpad\n- existing note\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const result = await tool.execute({
      mode: "upsert_section",
      section: "Working Set",
      content: "- Add focused context"
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("MEMORY.md");
    expect(result.modifiedSections).toEqual(["Working Set"]);
    expect(result.citations).toEqual([
      expect.objectContaining({
        section: "Working Set",
        citation: expect.stringMatching(/^MEMORY\.md#L\d+-L\d+$/),
        provenance: expect.objectContaining({
          source: "clawvault",
          relPath: "MEMORY.md"
        })
      })
    ]);
    const updated = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    expect(updated).toContain("## Scratchpad\n- existing note");
    expect(updated).toContain("## Working Set\n- Add focused context");
  });

  it("replaces only the target section body and preserves unrelated sections verbatim", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n## Goals\n- Keep focus\n\n## Scratchpad\n- existing note\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const before = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    const result = await tool.execute({
      mode: "replace_section",
      section: "Goals",
      content: "- Replace this section"
    });
    const after = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");

    expect(result.ok).toBe(true);
    expect(after).toContain("## Goals\n- Replace this section");
    expect(after).toContain("## Scratchpad\n- existing note");
    expect(before.includes("## Scratchpad\n- existing note")).toBe(true);
  });

  it("rejects blind append when section is missing", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n## Goals\n- Keep focus\n\n## Scratchpad\n- existing note\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const result = await tool.execute({
      mode: "append_under_section",
      content: "- should fail"
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("section is required");
  });

  it("rejects unknown write modes instead of defaulting implicitly", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n## Goals\n- Keep focus\n\n## Scratchpad\n- existing note\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const result = await tool.execute({
      mode: "append",
      section: "Goals",
      content: "- should fail"
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("mode must be one of");
  });

  it("creates default schema when MEMORY.md is absent and updates requested section", async () => {
    const vaultPath = createVaultFixture();
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const result = await tool.execute({
      mode: "upsert_section",
      section: "Identity",
      content: "Agent X"
    });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    expect(updated).toContain("## Identity\nAgent X");
    expect(updated).toContain("## Key Decisions");
    expect(updated).toContain("## Current Focus");
    expect(updated).toContain("## Constraints/Preferences");
    expect(updated).toContain("## Quick Links");
  });

  it("auto-bootstraps default schema for minimally structured files while preserving comments and custom sections", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n<!-- keep me -->\n\n## Notes\n- ad hoc\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const result = await tool.execute({
      mode: "upsert_section",
      section: "Current Focus",
      content: "- Ship idempotent updates"
    });

    expect(result.ok).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    expect(updated).toContain("<!-- keep me -->");
    expect(updated).toContain("## Notes\n- ad hoc");
    expect(updated).toContain("## Identity");
    expect(updated).toContain("## Current Focus\n- Ship idempotent updates");
    expect(updated).toContain("## Quick Links");
  });

  it("is idempotent for repeated upsert/replace writes and does not duplicate content", async () => {
    const vaultPath = createVaultFixture("# Boot Memory\n\n## Identity\nAgent X\n\n## Scratchpad\n- untouched\n");
    vaults.push(vaultPath);
    const tool = createMemoryWriteBootToolFactory({ pluginConfig: { vaultPath } })() as {
      execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const upsertFirst = await tool.execute({
      mode: "upsert_section",
      section: "Identity",
      content: "Agent X"
    });
    const afterFirst = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    const upsertSecond = await tool.execute({
      mode: "upsert_section",
      section: "Identity",
      content: "Agent X"
    });
    const afterSecond = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    const replaceThird = await tool.execute({
      mode: "replace_section",
      section: "Identity",
      content: "Agent X"
    });
    const afterThird = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");

    expect(upsertFirst.ok).toBe(true);
    expect(upsertSecond.ok).toBe(true);
    expect(replaceThird.ok).toBe(true);
    expect(afterSecond).toBe(afterFirst);
    expect(afterThird).toBe(afterSecond);
    expect(afterThird.match(/## Identity/g)).toHaveLength(1);
    expect(afterThird).toContain("## Scratchpad\n- untouched");
  });
});
