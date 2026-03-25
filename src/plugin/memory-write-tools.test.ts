import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWriteBootToolFactory } from "./memory-write-tools.js";

function createVaultFixture(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-memory-write-tools-"));
  fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ name: "test" }), "utf-8");
  fs.writeFileSync(
    path.join(vaultPath, "MEMORY.md"),
    "# Boot Memory\n\n## Goals\n- Keep focus\n\n## Scratchpad\n- existing note\n",
    "utf-8"
  );
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
    const vaultPath = createVaultFixture();
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
        citation: expect.stringMatching(/^MEMORY\.md#L\d+-L\d+$/)
      })
    ]);
    const updated = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    expect(updated).toContain("## Scratchpad\n- existing note");
    expect(updated).toContain("## Working Set\n- Add focused context");
  });

  it("replaces only the target section body and preserves unrelated sections verbatim", async () => {
    const vaultPath = createVaultFixture();
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
    const vaultPath = createVaultFixture();
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
});
