import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { ClawVaultMemoryManager } from "./memory-manager.js";

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
});
