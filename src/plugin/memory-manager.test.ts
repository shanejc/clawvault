import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import {
  ClawVaultMemoryManager,
  createMemoryCategoriesToolFactory,
  createMemoryClassifyToolFactory
} from "./memory-manager.js";
import {
  createMemoryCaptureSourceToolFactory,
  createMemoryUpdateToolFactory,
  createMemoryWriteBootToolFactory,
  createMemoryWriteVaultToolFactory
} from "./memory-write-tools.js";

const tempDirs: string[] = [];

function makeTempVaultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-memory-manager-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ClawVaultMemoryManager", () => {
  it("searches and reads memory files", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");
    fs.writeFileSync(
      path.join(vaultPath, "memory", "deployment-plan.md"),
      "# Deployment Plan\n\nWe decided to ship canary releases before global rollout.\n",
      "utf-8"
    );

    const loadSpy = vi.spyOn(ClawVault.prototype, "load").mockResolvedValue(undefined);
    const findSpy = vi.spyOn(ClawVault.prototype, "find").mockResolvedValue([
      {
        document: {
          id: "memory/deployment-plan",
          path: path.join(vaultPath, "memory", "deployment-plan.md"),
          category: "memory",
          title: "deployment-plan",
          content: "We decided to ship canary releases before global rollout.",
          frontmatter: {},
          links: [],
          tags: [],
          modified: new Date()
        },
        score: 0.92,
        snippet: "We decided to ship canary releases before global rollout.",
        matchedTerms: ["canary", "releases"]
      }
    ]);

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const results = await manager.search("canary releases", { maxResults: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toContain("canary");
    expect(results[0].layer).toBe("source");
    expect(results[0].category).toBe("memory");
    expect(results[0].provenance.source).toBe("clawvault");
    expect(loadSpy).toHaveBeenCalled();
    expect(findSpy).toHaveBeenCalled();

    const fileRead = await manager.readFile({
      relPath: "memory/deployment-plan.md"
    });
    expect(fileRead.text.toLowerCase()).toContain("global rollout");
    expect(fileRead.layer).toBe("source");
    expect(fileRead.category).toBe("memory");

    const missing = await manager.readFile({
      relPath: "memory/missing.md"
    });
    expect(missing.text).toBe("");
  });

  it("allows durable category reads and configured custom overlays", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "people"), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, "playbooks"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["people", "playbooks"] }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(path.join(vaultPath, "people", "alice.md"), "# Alice\nOwner of API platform.\n", "utf-8");
    fs.writeFileSync(path.join(vaultPath, "playbooks", "incident.md"), "# Incident Playbook\n", "utf-8");

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const person = await manager.readFile({ relPath: "people/alice.md" });
    expect(person.text).toContain("Owner of API platform");
    expect(person.layer).toBe("vault");
    expect(person.category).toBe("people");

    const playbook = await manager.readFile({ relPath: "playbooks/incident.md" });
    expect(playbook.text).toContain("Incident Playbook");
    expect(playbook.category).toBe("playbooks");
  });

  it("blocks memory_get paths outside safe roots", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    await expect(manager.readFile({ relPath: "tmp/secrets.md" })).rejects.toThrow("memory_get path not allowed");
    await expect(manager.readFile({ relPath: "../outside.md" })).rejects.toThrow("Invalid memory path");
  });

  it("reports provider status and probes availability", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const status = manager.status();
    expect(status.provider).toBe("clawvault");
    expect(status.backend).toBe("builtin");

    const embeddingProbe = await manager.probeEmbeddingAvailability();
    expect(embeddingProbe.ok).toBe(true);

    const vectorProbe = await manager.probeVectorAvailability();
    expect(typeof vectorProbe).toBe("boolean");
  });

  it("returns category inventory including plugin overlay categories", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["playbooks"] }, null, 2),
      "utf-8"
    );

    const tool = createMemoryCategoriesToolFactory({
      pluginConfig: {
        vaultPath,
        memoryOverlayFolders: ["incidents", "sessions/raw"]
      },
      defaultAgentId: "main"
    })();

    const result = await (tool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({});
    const categories = result.categories as Array<{ category: string; layer: string; readEnabled: boolean; sources: string[] }>;
    const byCategory = new Map(categories.map((entry) => [entry.category, entry]));

    expect(byCategory.get("boot")?.layer).toBe("boot");
    expect(byCategory.get("playbooks")?.sources).toContain(".clawvault.json");
    expect(byCategory.get("incidents")?.sources).toContain("plugin");
    expect(byCategory.get("sessions")?.layer).toBe("source");
    expect(byCategory.get("incidents")?.readEnabled).toBe(true);
  });

  it("classifies relPath and category hints with retrieval-identical layer semantics", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ categories: ["projects"] }), "utf-8");

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });
    const classifyTool = createMemoryClassifyToolFactory({
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    })();

    const bootClassified = await (classifyTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      relPath: "MEMORY.md"
    });
    expect(bootClassified.ok).toBe(true);
    expect((bootClassified.resolved as { layer: string }).layer).toBe("boot");

    const sourceClassified = await (classifyTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      relPath: "memory/2026-03-24.md"
    });
    expect((sourceClassified.resolved as { layer: string; category: string }).layer).toBe("source");
    expect((sourceClassified.resolved as { layer: string; category: string }).category).toBe("memory");

    const vaultClassified = await (classifyTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      relPath: "projects/roadmap.md"
    });
    expect((vaultClassified.resolved as { layer: string; category: string }).layer).toBe("vault");
    expect((vaultClassified.resolved as { layer: string; category: string }).category).toBe("projects");

    const retrieval = await manager.readFile({ relPath: "projects/roadmap.md" });
    expect(retrieval.layer).toBe((vaultClassified.resolved as { layer: string }).layer);

    const hintClassified = await (classifyTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      category: "projects"
    });
    expect(hintClassified.ok).toBe(true);
    expect((hintClassified.resolved as { readEnabled: boolean }).readEnabled).toBe(true);
  });

  it("orders retrieval results with durable notes as first-class objects and metadata intact", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ categories: ["projects"] }), "utf-8");
    fs.writeFileSync(path.join(vaultPath, "projects", "roadmap.md"), "# Roadmap\nDurable plan\n", "utf-8");
    fs.writeFileSync(path.join(vaultPath, "memory", "timeline.md"), "# Timeline\nCaptured source\n", "utf-8");

    vi.spyOn(ClawVault.prototype, "load").mockResolvedValue(undefined);
    vi.spyOn(ClawVault.prototype, "find").mockResolvedValue([
      {
        document: {
          id: "memory/timeline",
          path: path.join(vaultPath, "memory", "timeline.md"),
          category: "memory",
          title: "timeline",
          content: "Captured source",
          frontmatter: {},
          links: [],
          tags: [],
          modified: new Date()
        },
        score: 0.85,
        snippet: "Captured source",
        matchedTerms: ["captured"]
      },
      {
        document: {
          id: "projects/roadmap",
          path: path.join(vaultPath, "projects", "roadmap.md"),
          category: "projects",
          title: "roadmap",
          content: "Durable plan",
          frontmatter: {},
          links: [],
          tags: [],
          modified: new Date()
        },
        score: 0.85,
        snippet: "Durable plan",
        matchedTerms: ["plan"]
      }
    ]);

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const results = await manager.search("plan", { maxResults: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("projects/roadmap.md");
    expect(results[0]?.layer).toBe("vault");
    expect(results[0]?.category).toBe("projects");
    expect(results[0]?.provenance).toMatchObject({
      source: "clawvault",
      relPath: "projects/roadmap.md"
    });
    expect(results[1]?.path).toBe("memory/timeline.md");
    expect(results[1]?.layer).toBe("source");
  });

  it("does not promote source-only capture defaults into durable categories", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["projects"] }, null, 2),
      "utf-8"
    );

    const captureTool = createMemoryCaptureSourceToolFactory({
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    })();
    const execute = captureTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const missingTarget = await execute({
      payload: "captured by default",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture-default",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(missingTarget.ok).toBe(false);
    expect(String(missingTarget.error)).toContain("category must be a safe top-level folder name");

    const explicitSourceWrite = await execute({
      category: "captures",
      slug: "session-defaults",
      payload: "captured explicitly",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture-default-explicit",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(explicitSourceWrite.ok).toBe(true);
    expect(explicitSourceWrite.layer).toBe("source");
    expect(String(explicitSourceWrite.path)).toBe("captures/session-defaults.md");

    const forcedDurableCategory = await execute({
      category: "projects",
      payload: "should fail",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture-forced-durable",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(forcedDurableCategory.ok).toBe(false);
    expect(String(forcedDurableCategory.error)).toContain("memory_write path not allowed for layer vault");
  });

  it("resolves durable categories from overlay config safely", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({
        categories: ["runbooks", "../unsafe", "projects"],
        overlayCategories: ["people/team", "captures/raw"]
      }, null, 2),
      "utf-8"
    );

    const categoriesTool = createMemoryCategoriesToolFactory({
      pluginConfig: {
        vaultPath,
        memoryOverlayFolders: ["playbooks", "projects/2026", "../drop", "memory/raw"]
      },
      defaultAgentId: "main"
    })();
    const classifyTool = createMemoryClassifyToolFactory({
      pluginConfig: {
        vaultPath,
        memoryOverlayFolders: ["playbooks"]
      },
      defaultAgentId: "main"
    })();
    const categoryResult = await (categoriesTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({});
    const categories = categoryResult.categories as Array<{ category: string; layer: string }>;
    const byCategory = new Map(categories.map((entry) => [entry.category, entry.layer]));

    expect(byCategory.get("playbooks")).toBe("vault");
    expect(byCategory.get("runbooks")).toBe("vault");
    expect(byCategory.get("projects")).toBe("vault");
    expect(byCategory.get("people")).toBe("vault");
    expect(byCategory.get("memory")).toBe("source");
    expect(byCategory.has("unsafe")).toBe(false);
    expect(byCategory.has("drop")).toBe(false);

    const classified = await (classifyTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      category: "playbooks"
    });
    expect(classified.ok).toBe(true);
    expect((classified.resolved as { layer: string; category: string; readEnabled: boolean }).layer).toBe("vault");
    expect((classified.resolved as { layer: string; category: string; readEnabled: boolean }).category).toBe("playbooks");
    expect((classified.resolved as { layer: string; category: string; readEnabled: boolean }).readEnabled).toBe(true);
  });

  it("rejects malformed default category overrides by default while allowing additive custom categories", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({
        categories: ["playbooks", "projects"],
        overlayCategories: ["memory/raw", "people/team", "../escape"]
      }, null, 2),
      "utf-8"
    );

    const categoriesTool = createMemoryCategoriesToolFactory({
      pluginConfig: {
        vaultPath,
        memoryOverlayFolders: ["captures/raw", "incidents"]
      },
      defaultAgentId: "main"
    })();
    const categoryResult = await (categoriesTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({});
    const categories = categoryResult.categories as Array<{ category: string; layer: string; sources: string[] }>;
    const byCategory = new Map(categories.map((entry) => [entry.category, entry]));

    expect(byCategory.get("playbooks")?.layer).toBe("vault");
    expect(byCategory.get("incidents")?.sources).toContain("plugin");
    expect(byCategory.get("memory")?.sources).not.toContain(".clawvault.json");
    expect(byCategory.get("people")?.sources).not.toContain(".clawvault.json");
    expect(byCategory.get("captures")?.sources).not.toContain("plugin");
  });

  it("allows explicit default category override provenance flag", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({
        allowDefaultCategoryOverride: true,
        overlayCategories: ["people/team", "memory/raw"]
      }, null, 2),
      "utf-8"
    );

    const categoriesTool = createMemoryCategoriesToolFactory({
      pluginConfig: {
        vaultPath,
        memoryOverlayFolders: ["captures/raw"],
        allowDefaultCategoryOverride: true
      },
      defaultAgentId: "main"
    })();
    const categoryResult = await (categoriesTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({});
    const categories = categoryResult.categories as Array<{ category: string; layer: string; sources: string[] }>;
    const byCategory = new Map(categories.map((entry) => [entry.category, entry]));

    expect(byCategory.get("memory")?.layer).toBe("source");
    expect(byCategory.get("people")?.layer).toBe("vault");
    expect(byCategory.get("memory")?.sources).toContain(".clawvault.json");
    expect(byCategory.get("captures")?.sources).toContain("plugin");
  });

  it("writes vault, boot, source, and update tools with compatible handler fields", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["projects"] }, null, 2),
      "utf-8"
    );
    const writeOptions = {
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    };
    const writeVaultTool = createMemoryWriteVaultToolFactory(writeOptions)();
    const writeBootTool = createMemoryWriteBootToolFactory(writeOptions)();
    const captureTool = createMemoryCaptureSourceToolFactory(writeOptions)();
    const updateTool = createMemoryUpdateToolFactory(writeOptions, "memory_patch")();

    for (const tool of [writeVaultTool, writeBootTool, captureTool, updateTool]) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.input_schema).toBe(tool.inputSchema);
      expect(tool.parameters).toBe(tool.inputSchema);
      expect(tool.execute).toBe(tool.run);
      expect(tool.execute).toBe(tool.handler);
    }

    const writeVaultResult = await (writeVaultTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      category: "projects",
      slug: "roadmap",
      body: "# Roadmap",
      provenance: {
        sourceType: "conversation",
        originRef: "test://session",
        sessionKey: "agent/main/session"
      }
    });
    expect(writeVaultResult.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8")).toContain("# Roadmap");
    expect(fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8")).toContain("provenance:");

    const writeBootResult = await (writeBootTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      mode: "upsert_section",
      section: "Session Summary",
      content: "# Boot Memory"
    });
    expect(writeBootResult.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8")).toContain("# Boot Memory");

    const captureResult = await (captureTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      category: "captures",
      slug: "session-1",
      payload: "Captured evidence",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(captureResult.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultPath, "captures", "session-1.md"), "utf-8")).toContain("Captured evidence");

    const patchResult = await (updateTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      id: "projects/roadmap",
      content: "## Updated",
      mode: "replace"
    });
    expect(patchResult.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8")).toContain("## Updated");

    const appendResult = await (writeVaultTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      relPath: "projects/roadmap.md",
      body: "\nAppended line",
      mode: "append",
      provenance: {
        sourceType: "conversation",
        originRef: "test://session-append",
        sessionKey: "agent/main/session"
      }
    });
    expect(appendResult.ok).toBe(true);
    const afterAppend = fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8");
    expect((afterAppend.match(/^---$/gm) ?? []).length).toBe(2);
  });

  it("memory_write_vault rejects missing provenance and non-vault targets", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["projects"] }, null, 2),
      "utf-8"
    );

    const writeVaultTool = createMemoryWriteVaultToolFactory({
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    })();
    const execute = writeVaultTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const missingProvenance = await execute({
      category: "projects",
      slug: "missing-provenance",
      body: "content without provenance"
    });
    expect(missingProvenance.ok).toBe(false);
    expect(String(missingProvenance.error)).toContain("provenance is required");

    const bootTarget = await execute({
      relPath: "MEMORY.md",
      body: "should fail",
      provenance: {
        sourceType: "conversation",
        originRef: "test://boot",
        sessionKey: "agent/main/session"
      }
    });
    expect(bootTarget.ok).toBe(false);
    expect(String(bootTarget.error)).toContain("memory_write path not allowed for layer boot");

    const sourceTarget = await execute({
      relPath: "memory/source-only.md",
      body: "should fail",
      provenance: {
        sourceType: "conversation",
        originRef: "test://source",
        sessionKey: "agent/main/session"
      }
    });
    expect(sourceTarget.ok).toBe(false);
    expect(String(sourceTarget.error)).toContain("memory_write path not allowed for layer source");
  });

  it("memory_capture_source writes only to source layer", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");
    const captureTool = createMemoryCaptureSourceToolFactory({
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    })();
    const execute = captureTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const sourceWrite = await execute({
      relPath: "memory/chronology.md",
      payload: "source capture",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(sourceWrite.ok).toBe(true);
    expect(sourceWrite.layer).toBe("source");
    expect(fs.readFileSync(path.join(vaultPath, "memory", "chronology.md"), "utf-8")).toContain("source capture");

    const vaultTarget = await execute({
      relPath: "projects/roadmap.md",
      payload: "should fail",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture-vault",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(vaultTarget.ok).toBe(false);
    expect(String(vaultTarget.error)).toContain("memory_write path not allowed for layer vault");

    const bootTarget = await execute({
      relPath: "MEMORY.md",
      payload: "should fail",
      provenance: {
        sourceType: "timeline",
        originRef: "test://capture-boot",
        timestamp: "2026-03-25T00:00:00.000Z"
      }
    });
    expect(bootTarget.ok).toBe(false);
    expect(String(bootTarget.error)).toContain("memory_write path not allowed for layer boot");
  });

  it("memory_write_boot performs section-aware updates on MEMORY.md", async () => {
    const vaultPath = makeTempVaultPath();
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");
    fs.writeFileSync(
      path.join(vaultPath, "MEMORY.md"),
      "# Boot Memory\n\n## Session Summary\nOld summary\n\n## Next Steps\n- keep existing\n",
      "utf-8"
    );
    const writeBootTool = createMemoryWriteBootToolFactory({
      pluginConfig: { vaultPath },
      defaultAgentId: "main"
    })();
    const execute = writeBootTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const replaced = await execute({
      mode: "replace_section",
      section: "Session Summary",
      content: "Updated summary"
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.modifiedSections).toEqual(["Session Summary"]);

    const appended = await execute({
      mode: "append_under_section",
      section: "Next Steps",
      content: "- follow-up action"
    });
    expect(appended.ok).toBe(true);

    const upserted = await execute({
      mode: "upsert_section",
      section: "Decisions",
      content: "- chose section-aware writes"
    });
    expect(upserted.ok).toBe(true);

    const updatedMemory = fs.readFileSync(path.join(vaultPath, "MEMORY.md"), "utf-8");
    expect(updatedMemory).toContain("## Session Summary\nUpdated summary");
    expect(updatedMemory).toContain("## Next Steps\n- keep existing\n- follow-up action");
    expect(updatedMemory).toContain("## Decisions\n- chose section-aware writes");
  });

  it("memory_update and memory_patch modify docs, no-op empty patches, and fail safely on invalid patches", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, ".clawvault.json"),
      JSON.stringify({ categories: ["projects"] }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(vaultPath, "projects", "roadmap.md"),
      "# Roadmap\n\n## Details\nInitial details\n",
      "utf-8"
    );

    const options = { pluginConfig: { vaultPath }, defaultAgentId: "main" };
    const updateTool = createMemoryUpdateToolFactory(options, "memory_update")();
    const patchTool = createMemoryUpdateToolFactory(options, "memory_patch")();
    const runUpdate = updateTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const runPatch = patchTool.execute as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const replaced = await runUpdate({
      id: "projects/roadmap",
      content: "Replaced document",
      mode: "replace"
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.noOp).toBe(false);
    expect(fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8")).toContain("Replaced document");

    const appended = await runPatch({
      id: "projects/roadmap",
      content: "Appended patch line",
      mode: "append"
    });
    expect(appended.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultPath, "projects", "roadmap.md"), "utf-8")).toContain("Appended patch line");

    const emptyNoOp = await runUpdate({
      id: "projects/roadmap",
      content: "   ",
      mode: "replace"
    });
    expect(emptyNoOp.ok).toBe(true);
    expect(emptyNoOp.noOp).toBe(true);
    expect(emptyNoOp.reason).toBe("empty patch content");

    const invalidSectionPatch = await runPatch({
      id: "projects/roadmap",
      content: "won't apply",
      mode: "replace",
      section: "Missing Section"
    });
    expect(invalidSectionPatch.ok).toBe(false);
    expect(String(invalidSectionPatch.error)).toContain("Section not found: Missing Section");
  });
});
