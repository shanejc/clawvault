import * as fs from "fs";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { extractAgentIdFromSessionKey, type ClawVaultPluginConfig } from "./config.js";
import { resolveVaultPathForAgent } from "./clawvault-cli.js";
import type { MemoryLayer } from "./memory-types.js";
import {
  classifyMemoryTarget,
  inferLayerAndCategory,
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

type MemoryWriteProvenanceInput = {
  sourceType: string;
  originRef: string;
  timestamp?: string;
  sessionKey?: string;
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

const DEFAULT_BOOT_MEMORY_SECTIONS = [
  "Identity",
  "Key Decisions",
  "Current Focus",
  "Constraints/Preferences",
  "Quick Links"
] as const;

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

function toWritablePathByTarget(
  vaultPath: string,
  pluginConfig: ClawVaultPluginConfig,
  params: { relPath?: string; category?: string; slug?: string },
  allowedLayers: MemoryLayer[]
): {
  absolutePath: string;
  relPath: string;
  layer: MemoryLayer;
  category: string;
} {
  if (typeof params.relPath === "string" && params.relPath.trim()) {
    return toSafeWritablePath(vaultPath, params.relPath, pluginConfig, allowedLayers);
  }

  const classified = classifyMemoryTarget(vaultPath, pluginConfig, {
    category: params.category
  });
  if (!classified.ok || !classified.resolved) {
    throw new Error(classified.error ?? "Invalid memory target");
  }
  if (!allowedLayers.includes(classified.resolved.layer)) {
    throw new Error(`memory_write path not allowed for layer ${classified.resolved.layer}: ${classified.resolved.category}`);
  }
  const basename = (params.slug ?? `note-${Date.now()}`).trim();
  const safeSlug = basename
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || `note-${Date.now()}`;
  return toSafeWritablePath(
    vaultPath,
    `${classified.resolved.category}/${safeSlug}.md`,
    pluginConfig,
    allowedLayers
  );
}

function parseProvenance(input: unknown): MemoryWriteProvenanceInput {
  if (!input || typeof input !== "object") {
    throw new Error("provenance is required");
  }
  const sourceType = typeof (input as { sourceType?: unknown }).sourceType === "string"
    ? (input as { sourceType: string }).sourceType.trim()
    : "";
  const originRef = typeof (input as { originRef?: unknown }).originRef === "string"
    ? (input as { originRef: string }).originRef.trim()
    : "";
  const timestamp = typeof (input as { timestamp?: unknown }).timestamp === "string"
    ? (input as { timestamp: string }).timestamp.trim()
    : undefined;
  const sessionKey = typeof (input as { sessionKey?: unknown }).sessionKey === "string"
    ? (input as { sessionKey: string }).sessionKey.trim()
    : undefined;

  if (!sourceType) {
    throw new Error("provenance.sourceType is required");
  }
  if (!originRef) {
    throw new Error("provenance.originRef is required");
  }
  if (!timestamp && !sessionKey) {
    throw new Error("provenance.timestamp or provenance.sessionKey is required");
  }
  return { sourceType, originRef, timestamp, sessionKey };
}

function buildFrontmatter(params: {
  title?: string;
  tags?: string[];
  provenance: MemoryWriteProvenanceInput;
  extras?: Record<string, unknown>;
}): string {
  const entries: Array<[string, unknown]> = [];
  if (params.title) entries.push(["title", params.title]);
  if (params.tags && params.tags.length > 0) entries.push(["tags", params.tags]);
  entries.push(["provenance", {
    sourceType: params.provenance.sourceType,
    originRef: params.provenance.originRef,
    timestamp: params.provenance.timestamp ?? null,
    sessionKey: params.provenance.sessionKey ?? null
  }]);
  if (params.extras) {
    for (const [key, value] of Object.entries(params.extras)) {
      entries.push([key, value]);
    }
  }

  const lines: string[] = ["---"];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
      continue;
    }
    if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${nestedKey}: ${JSON.stringify(nestedValue)}`);
      }
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}`;
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

function getSectionBody(markdown: string, section: { startLine: number; endLine: number }): string {
  const lines = markdown.split(/\r?\n/);
  return lines.slice(section.startLine, section.endLine).join("\n");
}

function detectLineEnding(markdown: string): "\n" | "\r\n" {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function buildDefaultBootMemoryTemplate(lineEnding: "\n" | "\r\n" = "\n"): string {
  const lines = ["# Boot Memory", ""];
  for (const section of DEFAULT_BOOT_MEMORY_SECTIONS) {
    lines.push(`## ${section}`, "");
  }
  return `${lines.join(lineEnding).replace(/(?:\r?\n)+$/g, "")}${lineEnding}`;
}

function appendMissingBootSections(markdown: string): string {
  const lineEnding = detectLineEnding(markdown);
  if (!markdown.trim()) {
    return buildDefaultBootMemoryTemplate(lineEnding);
  }

  const headings = parseSectionRanges(markdown);
  const existing = new Set(headings.map((section) => section.name.trim().toLowerCase()));
  const missing = DEFAULT_BOOT_MEMORY_SECTIONS
    .filter((section) => !existing.has(section.toLowerCase()));
  if (missing.length === 0) {
    return markdown;
  }

  const prefix = markdown.replace(/(?:\r?\n)+$/g, "");
  const lines = [prefix];
  for (const section of missing) {
    lines.push("", `## ${section}`, "");
  }
  return `${lines.join(lineEnding).replace(/(?:\r?\n)+$/g, "")}${lineEnding}`;
}

function isMinimallyStructuredBootMemory(markdown: string): boolean {
  const sections = parseSectionRanges(markdown);
  const levelTwoCount = sections.filter((section) => section.level === 2).length;
  return levelTwoCount === 0;
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
    fs.writeFileSync(resolved.absolutePath, buildDefaultBootMemoryTemplate(), "utf-8");
  }

  const payload = normalizeSectionPayload(params.content);
  let existing = fs.readFileSync(resolved.absolutePath, "utf-8");
  if (isMinimallyStructuredBootMemory(existing)) {
    const withDefaults = appendMissingBootSections(existing);
    if (withDefaults !== existing) {
      fs.writeFileSync(resolved.absolutePath, withDefaults, "utf-8");
      existing = withDefaults;
    }
  }
  const existingSection = findSectionByName(existing, section);
  const vault = new ClawVault(vaultPath);

  if (params.mode === "replace_section" || params.mode === "append_under_section") {
    if (!existingSection) {
      throw new Error(`Section not found: ${section}`);
    }
    if (params.mode === "append_under_section" && payload.length === 0) {
      throw new Error("append_under_section requires non-empty content");
    }
    if (params.mode === "replace_section") {
      const currentBody = normalizeSectionPayload(getSectionBody(existing, existingSection));
      if (currentBody !== payload) {
        await vault.patch({
          idOrPath: "MEMORY.md",
          mode: "content",
          section,
          content: payload
        });
      }
    } else {
      await vault.patch({
        idOrPath: "MEMORY.md",
        mode: "append",
        section,
        append: payload
      });
    }
  } else if (existingSection) {
    const currentBody = normalizeSectionPayload(getSectionBody(existing, existingSection));
    if (currentBody !== payload) {
      await vault.patch({
        idOrPath: "MEMORY.md",
        mode: "content",
        section,
        content: payload
      });
    }
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

async function patchDurableMemory(
  options: MemoryWriteToolOptions,
  params: {
    id?: string;
    relPath?: string;
    content: string;
    mode?: "append" | "replace";
    section?: string;
    sessionKey?: string;
  }
): Promise<Record<string, unknown>> {
  const vaultPath = resolveVaultPath(options, params.sessionKey);
  if (!vaultPath) {
    throw new Error("Vault not configured");
  }

  const idOrPath = typeof params.id === "string" && params.id.trim()
    ? params.id
    : (params.relPath ?? "");
  if (!idOrPath.trim()) {
    throw new Error("id or relPath is required");
  }

  const idCandidates = [idOrPath];
  if (!idOrPath.toLowerCase().endsWith(".md")) {
    idCandidates.push(`${idOrPath}.md`);
  }
  let resolved: { absolutePath: string; relPath: string; layer: MemoryLayer; category: string } | null = null;
  let lastError: unknown = null;
  for (const candidate of idCandidates) {
    try {
      const maybeResolved = toSafeWritablePath(vaultPath, candidate, options.pluginConfig, ["vault"]);
      if (fs.existsSync(maybeResolved.absolutePath)) {
        resolved = maybeResolved;
        break;
      }
      if (!resolved) {
        resolved = maybeResolved;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!resolved) {
    throw new Error(lastError instanceof Error ? lastError.message : "Invalid memory path");
  }
  if (!fs.existsSync(resolved.absolutePath)) {
    throw new Error(`Document not found: ${resolved.relPath}`);
  }

  if (!params.content.trim()) {
    return {
      ok: true,
      noOp: true,
      reason: "empty patch content",
      path: resolved.relPath,
      layer: resolved.layer,
      category: resolved.category,
      provenance: {
        source: "clawvault",
        relPath: resolved.relPath,
        absolutePath: resolved.absolutePath
      }
    };
  }

  const vault = new ClawVault(vaultPath);
  await vault.patch({
    idOrPath: resolved.relPath,
    mode: params.mode === "append" ? "append" : "content",
    append: params.mode === "append" ? params.content : undefined,
    content: params.mode === "append" ? undefined : params.content,
    section: params.section?.trim() || undefined
  });
  const raw = fs.readFileSync(resolved.absolutePath, "utf-8");
  return {
    ok: true,
    noOp: false,
    path: resolved.relPath,
    layer: resolved.layer,
    category: resolved.category,
    bytes: Buffer.byteLength(raw, "utf-8"),
    mode: params.mode === "append" ? "append" : "replace",
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
      relPath: { type: "string", description: "Optional classified durable target path." },
      category: { type: "string", description: "Durable category when relPath is omitted." },
      slug: { type: "string", description: "Optional filename slug when targeting category only." },
      body: { type: "string", description: "Durable memory body content." },
      content: { type: "string", description: "Deprecated alias for body." },
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      frontmatter: { type: "object", additionalProperties: true },
      provenance: {
        type: "object",
        properties: {
          sourceType: { type: "string" },
          originRef: { type: "string" },
          timestamp: { type: "string" },
          sessionKey: { type: "string" }
        },
        required: ["sourceType", "originRef"],
        additionalProperties: false
      },
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["body", "provenance"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        const provenance = parseProvenance(input.provenance);
        const body = typeof input.body === "string"
          ? input.body
          : (typeof input.content === "string" ? input.content : "");
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0) : [];
        const frontmatterExtras = input.frontmatter && typeof input.frontmatter === "object"
          ? input.frontmatter as Record<string, unknown>
          : undefined;
        const targetSession = typeof input.sessionKey === "string" ? input.sessionKey : undefined;
        const vaultPath = resolveVaultPath(options, targetSession);
        if (!vaultPath) {
          throw new Error("Vault not configured");
        }
        const resolved = toWritablePathByTarget(
          vaultPath,
          options.pluginConfig,
          {
            relPath: typeof input.relPath === "string" ? input.relPath : undefined,
            category: typeof input.category === "string" ? input.category : undefined,
            slug: typeof input.slug === "string" ? input.slug : (title || undefined)
          },
          ["vault"]
        );
        const inferred = inferLayerAndCategory(resolved.relPath);
        if (inferred.layer !== "vault") {
          throw new Error(`memory_write_vault requires a durable category target: ${resolved.relPath}`);
        }
        const writeMode = input.mode === "replace" ? "replace" : "append";
        const fileExists = fs.existsSync(resolved.absolutePath);
        const shouldPrependFrontmatter = writeMode === "replace" || !fileExists;
        const contentWithFrontmatter = shouldPrependFrontmatter
          ? `${buildFrontmatter({
            title: title || undefined,
            tags,
            provenance,
            extras: frontmatterExtras
          })}${body}${body.endsWith("\n") ? "" : "\n"}`
          : `${body}${body.endsWith("\n") ? "" : "\n"}`;
        return await writeMemoryFile(options, {
          relPath: resolved.relPath,
          content: contentWithFrontmatter,
          mode: writeMode,
          sessionKey: targetSession,
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
      relPath: { type: "string", description: "Optional source-layer target path." },
      category: { type: "string", description: "Source-layer category (memory/source/captures/chronology/etc)." },
      slug: { type: "string" },
      payload: { type: "string", description: "Raw chronology/evidence payload." },
      provenance: {
        type: "object",
        properties: {
          sourceType: { type: "string" },
          originRef: { type: "string" },
          timestamp: { type: "string" },
          sessionKey: { type: "string" }
        },
        required: ["sourceType", "originRef"],
        additionalProperties: false
      },
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["payload", "provenance"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        parseProvenance(input.provenance);
        const payload = typeof input.payload === "string" ? input.payload : "";
        const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : undefined;
        const vaultPath = resolveVaultPath(options, sessionKey);
        if (!vaultPath) {
          throw new Error("Vault not configured");
        }
        const resolved = toWritablePathByTarget(vaultPath, options.pluginConfig, {
          relPath: typeof input.relPath === "string" ? input.relPath : undefined,
          category: typeof input.category === "string" ? input.category : undefined,
          slug: typeof input.slug === "string" ? input.slug : undefined
        }, ["source"]);
        return await writeMemoryFile(options, {
          relPath: resolved.relPath,
          content: payload,
          mode: input.mode === "replace" ? "replace" : "append",
          sessionKey,
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
      id: { type: "string", description: "Document id/path to patch." },
      relPath: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: ["append", "replace"] },
      section: { type: "string" },
      sessionKey: { type: "string" }
    }, ["content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await patchDurableMemory(options, {
          id: typeof input.id === "string" ? input.id : undefined,
          relPath: typeof input.relPath === "string" ? input.relPath : undefined,
          content: typeof input.content === "string" ? input.content : "",
          mode: input.mode === "replace" ? "replace" : "append",
          section: typeof input.section === "string" ? input.section : undefined,
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return { name: toolName, inputSchema, input_schema: inputSchema, parameters: inputSchema, execute, run: execute, handler: execute };
  };
}
