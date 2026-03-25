import * as fs from "fs";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { extractAgentIdFromSessionKey, type ClawVaultPluginConfig } from "./config.js";
import { resolveVaultPathForAgent } from "./clawvault-cli.js";
import type { MemoryLayer } from "./memory-types.js";
import {
  toSafeMemoryPath
} from "./memory-manager.js";

type MemoryWriteToolOptions = {
  pluginConfig: ClawVaultPluginConfig;
  workspaceDir?: string;
  defaultAgentId?: string;
};

type MemoryWriteResultBase = {
  ok: boolean;
  path: string;
  layer: MemoryLayer;
  category: string;
  bytes: number;
  created: boolean;
  provenance: {
    source: "clawvault";
    relPath: string;
    absolutePath: string;
  };
};

type MemoryWriteResult = MemoryWriteResultBase & {
  mode: "append" | "replace";
};

type MemoryWriteBootMode = "replace_section" | "upsert_section" | "append_under_section";

type SectionCitation = {
  section: string;
  startLine: number;
  endLine: number;
  citation: string;
  provenance: {
    source: "clawvault";
    relPath: string;
    absolutePath: string;
  };
};

type MemoryWriteBootResult = MemoryWriteResultBase & {
  mode: MemoryWriteBootMode;
  modifiedSections: string[];
  citations: SectionCitation[];
};

function toBootWriteMode(value: unknown): MemoryWriteBootMode {
  if (value === "replace_section" || value === "upsert_section" || value === "append_under_section") {
    return value;
  }
  throw new Error("mode must be one of: replace_section, upsert_section, append_under_section");
}

function resolveVaultPath(options: MemoryWriteToolOptions, sessionKey?: string): string | null {
  const derivedAgentId = sessionKey ? extractAgentIdFromSessionKey(sessionKey) : "";
  const agentId = derivedAgentId || options.defaultAgentId;
  return resolveVaultPathForAgent(options.pluginConfig, {
    agentId,
    cwd: options.workspaceDir
  });
}

function toSafeWritablePath(
  vaultPath: string,
  relPath: string,
  pluginConfig: ClawVaultPluginConfig,
  allowedLayers: MemoryLayer[]
): {
  absolutePath: string;
  relPath: string;
  layer: MemoryLayer;
  category: string;
} {
  const { absolutePath, metadata } = toSafeMemoryPath(vaultPath, relPath, pluginConfig);
  const { layer, category } = metadata;
  if (!allowedLayers.includes(layer)) {
    throw new Error(`memory_write path not allowed for layer ${layer}: ${metadata.relPath}`);
  }
  return { absolutePath, relPath: metadata.relPath, layer, category };
}

async function writeMemoryFile(
  options: MemoryWriteToolOptions,
  params: {
    relPath: string;
    content: string;
    mode?: "append" | "replace";
    startLine?: number;
    endLine?: number;
    sessionKey?: string;
    allowedLayers: MemoryLayer[];
  }
): Promise<MemoryWriteResult> {
  const vaultPath = resolveVaultPath(options, params.sessionKey);
  if (!vaultPath) {
    throw new Error("Vault not configured");
  }
  const resolved = toSafeWritablePath(vaultPath, params.relPath, options.pluginConfig, params.allowedLayers);
  const created = !fs.existsSync(resolved.absolutePath);
  fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });

  const hasLinePatch = Number.isFinite(params.startLine) || Number.isFinite(params.endLine);
  if (hasLinePatch) {
    const existing = created ? "" : fs.readFileSync(resolved.absolutePath, "utf-8");
    const lines = existing.split(/\r?\n/);
    const startLine = Number.isFinite(params.startLine) ? Math.max(1, Math.floor(Number(params.startLine))) : lines.length + 1;
    const endLine = Number.isFinite(params.endLine) ? Math.max(startLine, Math.floor(Number(params.endLine))) : startLine;
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length, endLine);
    lines.splice(startIndex, Math.max(0, endIndex - startIndex), ...params.content.split(/\r?\n/));
    const next = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
    fs.writeFileSync(resolved.absolutePath, next, "utf-8");
    return {
      ok: true,
      path: resolved.relPath,
      layer: resolved.layer,
      category: resolved.category,
      bytes: Buffer.byteLength(next, "utf-8"),
      mode: "replace",
      created,
      provenance: {
        source: "clawvault",
        relPath: resolved.relPath,
        absolutePath: resolved.absolutePath
      }
    };
  }

  const mode = params.mode === "replace" ? "replace" : "append";
  const payload = mode === "append"
    ? `${params.content}${params.content.endsWith("\n") ? "" : "\n"}`
    : params.content;
  if (mode === "append") {
    fs.appendFileSync(resolved.absolutePath, payload, "utf-8");
  } else {
    fs.writeFileSync(resolved.absolutePath, payload, "utf-8");
  }
  return {
    ok: true,
    path: resolved.relPath,
    layer: resolved.layer,
    category: resolved.category,
    bytes: Buffer.byteLength(payload, "utf-8"),
    mode,
    created,
    provenance: {
      source: "clawvault",
      relPath: resolved.relPath,
      absolutePath: resolved.absolutePath
    }
  };
}

function buildToolSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function buildWriteToolResultError(error: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

function parseSectionRanges(markdown: string): Array<{ name: string; level: number; startLine: number; endLine: number }> {
  const lines = markdown.split(/\r?\n/);
  const headings: Array<{ name: string; level: number; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!match) continue;
    headings.push({
      name: match[2].trim(),
      level: match[1].length,
      line: index + 1
    });
  }

  return headings.map((heading, idx) => {
    const next = headings.slice(idx + 1).find((candidate) => candidate.level <= heading.level);
    return {
      name: heading.name,
      level: heading.level,
      startLine: heading.line,
      endLine: next ? next.line - 1 : lines.length
    };
  });
}

function findSectionByName(markdown: string, sectionName: string): { name: string; level: number; startLine: number; endLine: number } | null {
  const target = sectionName.trim().toLowerCase();
  if (!target) return null;
  return parseSectionRanges(markdown).find((section) => section.name.trim().toLowerCase() === target) ?? null;
}

function normalizeSectionPayload(content: string): string {
  return content.replace(/^\n+/, "").replace(/\n+$/g, "");
}

function ensureMemoryBootTarget(
  vaultPath: string,
  pluginConfig: ClawVaultPluginConfig
): { absolutePath: string; relPath: string; layer: MemoryLayer; category: string } {
  const resolved = toSafeWritablePath(vaultPath, "MEMORY.md", pluginConfig, ["boot"]);
  const expected = path.resolve(vaultPath, "MEMORY.md");
  if (resolved.relPath !== "MEMORY.md" || resolved.absolutePath !== expected) {
    throw new Error("memory_write_boot can only target MEMORY.md at vault root");
  }
  return resolved;
}

async function writeBootMemorySection(
  options: MemoryWriteToolOptions,
  params: {
    content: string;
    mode: MemoryWriteBootMode;
    section: string;
    sessionKey?: string;
  }
): Promise<MemoryWriteBootResult> {
  const vaultPath = resolveVaultPath(options, params.sessionKey);
  if (!vaultPath) {
    throw new Error("Vault not configured");
  }
  const resolved = ensureMemoryBootTarget(vaultPath, options.pluginConfig);
  const section = params.section.trim();
  if (!section) {
    throw new Error("section is required for memory_write_boot");
  }

  const created = !fs.existsSync(resolved.absolutePath);
  if (created) {
    fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
    fs.writeFileSync(resolved.absolutePath, "# Boot Memory\n", "utf-8");
  }

  const payload = normalizeSectionPayload(params.content);
  const existing = fs.readFileSync(resolved.absolutePath, "utf-8");
  const existingSection = findSectionByName(existing, section);
  const vault = new ClawVault(vaultPath);

  if (params.mode === "replace_section" || params.mode === "append_under_section") {
    if (!existingSection) {
      throw new Error(`Section not found: ${section}`);
    }
    if (params.mode === "append_under_section" && payload.length === 0) {
      throw new Error("append_under_section requires non-empty content");
    }
    await vault.patch({
      idOrPath: "MEMORY.md",
      mode: params.mode === "append_under_section" ? "append" : "content",
      section,
      append: params.mode === "append_under_section" ? payload : undefined,
      content: params.mode === "replace_section" ? payload : undefined
    });
  } else if (existingSection) {
    await vault.patch({
      idOrPath: "MEMORY.md",
      mode: "content",
      section,
      content: payload
    });
  } else {
    if (payload.length === 0) {
      throw new Error("upsert_section requires non-empty content");
    }
    const heading = `## ${section}`;
    const addition = `\n${heading}\n${payload}\n`;
    await vault.patch({
      idOrPath: "MEMORY.md",
      mode: "append",
      append: addition
    });
  }

  const updated = fs.readFileSync(resolved.absolutePath, "utf-8");
  const updatedSection = findSectionByName(updated, section);
  if (!updatedSection) {
    throw new Error(`Section not found after write: ${section}`);
  }

  return {
    ok: true,
    path: resolved.relPath,
    layer: resolved.layer,
    category: resolved.category,
    bytes: Buffer.byteLength(updated, "utf-8"),
    mode: params.mode,
    created,
    modifiedSections: [updatedSection.name],
    citations: [{
      section: updatedSection.name,
      startLine: updatedSection.startLine,
      endLine: updatedSection.endLine,
      citation: `${resolved.relPath}#L${updatedSection.startLine}-L${updatedSection.endLine}`,
      provenance: {
        source: "clawvault",
        relPath: resolved.relPath,
        absolutePath: resolved.absolutePath
      }
    }],
    provenance: {
      source: "clawvault",
      relPath: resolved.relPath,
      absolutePath: resolved.absolutePath
    }
  };
}

export function createMemoryWriteVaultToolFactory(options: MemoryWriteToolOptions): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await writeMemoryFile(options, {
          relPath: typeof input.relPath === "string" ? input.relPath : "",
          content: typeof input.content === "string" ? input.content : "",
          mode: input.mode === "replace" ? "replace" : "append",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
          allowedLayers: ["vault"]
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return { name: "memory_write_vault", inputSchema, input_schema: inputSchema, parameters: inputSchema, execute, run: execute, handler: execute };
  };
}

export function createMemoryWriteBootToolFactory(options: MemoryWriteToolOptions): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      content: { type: "string" },
      mode: { type: "string", enum: ["replace_section", "upsert_section", "append_under_section"] },
      section: { type: "string", minLength: 1 },
      sessionKey: { type: "string" }
    }, ["content", "mode", "section"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await writeBootMemorySection(options, {
          content: typeof input.content === "string" ? input.content : "",
          mode: toBootWriteMode(input.mode),
          section: typeof input.section === "string" ? input.section : "",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return { name: "memory_write_boot", inputSchema, input_schema: inputSchema, parameters: inputSchema, execute, run: execute, handler: execute };
  };
}

export function createMemoryCaptureSourceToolFactory(options: MemoryWriteToolOptions): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await writeMemoryFile(options, {
          relPath: typeof input.relPath === "string" ? input.relPath : "",
          content: typeof input.content === "string" ? input.content : "",
          mode: input.mode === "replace" ? "replace" : "append",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
          allowedLayers: ["source"]
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return { name: "memory_capture_source", inputSchema, input_schema: inputSchema, parameters: inputSchema, execute, run: execute, handler: execute };
  };
}

export function createMemoryUpdateToolFactory(
  options: MemoryWriteToolOptions,
  toolName: "memory_update" | "memory_patch" = "memory_update"
): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string" },
      content: { type: "string" },
      startLine: { type: "number", minimum: 1 },
      endLine: { type: "number", minimum: 1 },
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await writeMemoryFile(options, {
          relPath: typeof input.relPath === "string" ? input.relPath : "",
          content: typeof input.content === "string" ? input.content : "",
          startLine: Number.isFinite(Number(input.startLine)) ? Number(input.startLine) : undefined,
          endLine: Number.isFinite(Number(input.endLine)) ? Number(input.endLine) : undefined,
          mode: input.mode === "replace" ? "replace" : "append",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
          allowedLayers: ["vault", "source", "boot"]
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return { name: toolName, inputSchema, input_schema: inputSchema, parameters: inputSchema, execute, run: execute, handler: execute };
  };
}
