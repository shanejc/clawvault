import * as fs from "fs";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { hasQmd } from "../lib/search.js";
import type { SearchResult } from "../types.js";
import {
  extractAgentIdFromSessionKey,
  type ClawVaultPluginConfig
} from "./config.js";
import {
  resolveVaultPathForAgent,
  sanitizePromptForContext
} from "./clawvault-cli.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryLayer,
  MemoryProviderStatus,
  MemoryProvenance,
  MemorySearchManager,
  MemorySearchResult
} from "./memory-types.js";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.2;
const DEFAULT_DURABLE_CATEGORIES = ["people", "projects", "decisions", "lessons", "tasks", "backlog", "handoffs"] as const;
const DEFAULT_SOURCE_CATEGORIES = ["memory", "source", "sessions", "captures", "evidence", "chronology", "logs"] as const;

type MemoryPathMetadata = {
  relPath: string;
  layer: MemoryLayer;
  category: string;
  provenance: MemoryProvenance;
};

type MemoryWriteResult = {
  ok: boolean;
  path: string;
  layer: MemoryLayer;
  category: string;
  bytes: number;
  mode: "append" | "replace";
  created: boolean;
  provenance: MemoryProvenance;
};

type CategoryInventoryEntry = {
  category: string;
  layer: MemoryLayer;
  readEnabled: boolean;
  sources: string[];
};

export interface ClawVaultMemoryManagerOptions {
  pluginConfig: ClawVaultPluginConfig;
  workspaceDir?: string;
  defaultAgentId?: string;
  logger?: {
    debug?: (message: string) => void;
    warn: (message: string) => void;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function estimateLineRange(content: string, snippet: string): { startLine: number; endLine: number } {
  const cleanedSnippet = snippet.replace(/\s+/g, " ").trim();
  if (!cleanedSnippet) {
    return { startLine: 1, endLine: 1 };
  }
  const normalizedContent = content.replace(/\s+/g, " ");
  const index = normalizedContent.toLowerCase().indexOf(cleanedSnippet.toLowerCase());
  if (index < 0) {
    return { startLine: 1, endLine: Math.max(1, cleanedSnippet.split(/\r?\n/).length) };
  }

  const upToIndex = normalizedContent.slice(0, index);
  const startLine = upToIndex.split(/\r?\n/).length;
  const endLine = startLine + Math.max(1, cleanedSnippet.split(/\r?\n/).length) - 1;
  return { startLine, endLine };
}

function inferLayerAndCategory(relPath: string): { layer: MemoryLayer; category: string } {
  if (relPath === "MEMORY.md") {
    return { layer: "boot", category: "boot" };
  }

  const category = relPath.split("/")[0] ?? "unknown";
  if ((DEFAULT_SOURCE_CATEGORIES as readonly string[]).includes(category)) {
    return { layer: "source", category };
  }

  return { layer: "vault", category };
}

function mapSearchResult(vaultPath: string, result: SearchResult): MemorySearchResult {
  const relPath = normalizeRelPath(path.relative(vaultPath, result.document.path));
  const { startLine, endLine } = estimateLineRange(result.document.content, result.snippet);
  const { layer, category } = inferLayerAndCategory(relPath || path.basename(result.document.path));
  const normalizedRelPath = relPath || path.basename(result.document.path);

  return {
    path: normalizedRelPath,
    startLine,
    endLine,
    score: result.score,
    snippet: result.snippet,
    layer,
    category,
    provenance: {
      source: "clawvault",
      relPath: normalizedRelPath,
      absolutePath: result.document.path
    },
    citation: `${normalizedRelPath}#L${startLine}-L${endLine}`
  };
}

function countMarkdownFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;

  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count;
}

function isSafeCategoryName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function collectCategoryInventory(vaultPath: string, pluginConfig: ClawVaultPluginConfig): CategoryInventoryEntry[] {
  const categorySources = new Map<string, Set<string>>();
  const addCategory = (rawName: string, source: string) => {
    const category = normalizeRelPath(rawName).split("/")[0] ?? "";
    if (!isSafeCategoryName(category)) return;
    const existing = categorySources.get(category) ?? new Set<string>();
    existing.add(source);
    categorySources.set(category, existing);
  };

  categorySources.set("boot", new Set(["builtin"]));

  for (const category of DEFAULT_DURABLE_CATEGORIES) {
    addCategory(category, "builtin");
  }
  for (const category of DEFAULT_SOURCE_CATEGORIES) {
    addCategory(category, "builtin");
  }

  if (Array.isArray((pluginConfig as { memoryOverlayFolders?: unknown }).memoryOverlayFolders)) {
    const configured = (pluginConfig as { memoryOverlayFolders?: unknown[] }).memoryOverlayFolders ?? [];
    for (const value of configured) {
      if (typeof value !== "string") continue;
      addCategory(value, "plugin");
    }
  }

  const configPath = path.join(vaultPath, ".clawvault.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const configuredArrays = [
        parsed.categories,
        parsed.overlayCategories,
        parsed.customCategories,
        parsed.memoryReadRoots
      ];
      for (const candidate of configuredArrays) {
        if (!Array.isArray(candidate)) continue;
        for (const item of candidate) {
          if (typeof item !== "string") continue;
          addCategory(item, ".clawvault.json");
        }
      }
    } catch {
      // Ignore invalid JSON and keep default safe categories.
    }
  }

  return [...categorySources.entries()]
    .map(([category, sources]) => {
      const layer = category === "boot"
        ? "boot"
        : inferLayerAndCategory(`${category}/_`).layer;
      return {
        category,
        layer,
        readEnabled: category === "boot" || categorySources.has(category),
        sources: [...sources].sort()
      } satisfies CategoryInventoryEntry;
    })
    .sort((a, b) => a.category.localeCompare(b.category));
}

function getConfiguredCategoryFolders(vaultPath: string, pluginConfig: ClawVaultPluginConfig): Set<string> {
  const folders = new Set<string>();
  for (const entry of collectCategoryInventory(vaultPath, pluginConfig)) {
    if (entry.category === "boot") continue;
    if (entry.readEnabled) {
      folders.add(entry.category);
    }
  }

  return folders;
}

function classifyMemoryTarget(
  vaultPath: string,
  pluginConfig: ClawVaultPluginConfig,
  params: { relPath?: string; category?: string }
): {
  ok: boolean;
  input: { relPath?: string; category?: string };
  resolved?: {
    relPath?: string;
    layer: MemoryLayer;
    category: string;
    readEnabled: boolean;
    provenance: MemoryProvenance;
  };
  error?: string;
} {
  const normalizedRelPath = typeof params.relPath === "string" ? normalizeRelPath(params.relPath) : "";
  if (normalizedRelPath) {
    try {
      const resolved = toSafeMemoryPath(vaultPath, normalizedRelPath, pluginConfig);
      return {
        ok: true,
        input: { relPath: normalizedRelPath },
        resolved: {
          relPath: resolved.metadata.relPath,
          layer: resolved.metadata.layer,
          category: resolved.metadata.category,
          readEnabled: true,
          provenance: resolved.metadata.provenance
        }
      };
    } catch (error) {
      return {
        ok: false,
        input: { relPath: normalizedRelPath },
        error: error instanceof Error ? error.message : "Invalid memory path"
      };
    }
  }

  const normalizedCategory = typeof params.category === "string"
    ? normalizeRelPath(params.category).split("/")[0] ?? ""
    : "";
  if (!normalizedCategory || !isSafeCategoryName(normalizedCategory)) {
    return {
      ok: false,
      input: { category: normalizedCategory || undefined },
      error: "category must be a safe top-level folder name"
    };
  }

  const safeRoots = getConfiguredCategoryFolders(vaultPath, pluginConfig);
  const readEnabled = safeRoots.has(normalizedCategory);
  const inferred = inferLayerAndCategory(`${normalizedCategory}/_`);
  return {
    ok: true,
    input: { category: normalizedCategory },
    resolved: {
      layer: inferred.layer,
      category: inferred.category,
      readEnabled,
      provenance: {
        source: "clawvault",
        relPath: normalizedCategory
      }
    }
  };
}

function toSafeMemoryPath(
  vaultPath: string,
  relPath: string,
  pluginConfig: ClawVaultPluginConfig
): { absolutePath: string; metadata: MemoryPathMetadata } {
  const normalized = normalizeRelPath(relPath);
  const mapped = normalized.startsWith("qmd/")
    ? normalized.split("/").slice(2).join("/")
    : normalized;

  if (!mapped || mapped.includes("..") || path.isAbsolute(mapped)) {
    throw new Error("Invalid memory path");
  }

  const safeRoots = getConfiguredCategoryFolders(vaultPath, pluginConfig);
  const topLevel = mapped.split("/")[0] ?? "";
  const allowByCategory = topLevel.length > 0 && safeRoots.has(topLevel);
  if (mapped !== "MEMORY.md" && !allowByCategory) {
    throw new Error(`memory_get path not allowed: ${mapped}`);
  }

  const absolute = path.resolve(vaultPath, mapped);
  const vaultRootWithSep = vaultPath.endsWith(path.sep) ? vaultPath : `${vaultPath}${path.sep}`;
  if (absolute !== vaultPath && !absolute.startsWith(vaultRootWithSep)) {
    throw new Error("Path escapes vault root");
  }

  const { layer, category } = inferLayerAndCategory(mapped);
  return {
    absolutePath: absolute,
    metadata: {
      relPath: mapped,
      layer,
      category,
      provenance: {
        source: "clawvault",
        relPath: mapped,
        absolutePath: absolute
      }
    }
  };
}

function toSafeWritablePath(
  vaultPath: string,
  relPath: string,
  pluginConfig: ClawVaultPluginConfig,
  allowedLayers: MemoryLayer[]
): { absolutePath: string; metadata: MemoryPathMetadata } {
  const resolved = toSafeMemoryPath(vaultPath, relPath, pluginConfig);
  if (!allowedLayers.includes(resolved.metadata.layer)) {
    throw new Error(`memory_write path not allowed for layer ${resolved.metadata.layer}: ${resolved.metadata.relPath}`);
  }
  return resolved;
}

function resolveManagerVaultPath(
  options: ClawVaultMemoryManagerOptions,
  sessionKey?: string
): string | null {
  const derivedAgentId = sessionKey ? extractAgentIdFromSessionKey(sessionKey) : "";
  const agentId = derivedAgentId || options.defaultAgentId;
  return resolveVaultPathForAgent(options.pluginConfig, {
    agentId,
    cwd: options.workspaceDir
  });
}

export class ClawVaultMemoryManager implements MemorySearchManager {
  private readonly options: ClawVaultMemoryManagerOptions;

  constructor(options: ClawVaultMemoryManagerOptions) {
    this.options = options;
  }

  async search(
    query: string,
    opts: { maxResults?: number; minScore?: number; sessionKey?: string } = {}
  ): Promise<MemorySearchResult[]> {
    const normalizedQuery = sanitizePromptForContext(query);
    if (!normalizedQuery) return [];

    const vaultPath = resolveManagerVaultPath(this.options, opts.sessionKey);
    if (!vaultPath) return [];

    const maxResults = Number.isFinite(opts.maxResults)
      ? clamp(Math.floor(Number(opts.maxResults)), 1, 20)
      : DEFAULT_MAX_RESULTS;
    const minScore = Number.isFinite(opts.minScore)
      ? clamp(Number(opts.minScore), 0, 1)
      : DEFAULT_MIN_SCORE;

    try {
      const vault = new ClawVault(vaultPath);
      await vault.load();
      const results = await vault.find(normalizedQuery, {
        limit: maxResults,
        minScore,
        temporalBoost: true
      });
      return results.map((result) => mapSearchResult(vaultPath, result));
    } catch (error) {
      this.options.logger?.warn(
        `[clawvault] memory_search fallback error: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{
    text: string;
    path: string;
    layer?: MemoryLayer;
    category?: string;
    provenance?: MemoryProvenance;
    citation?: string;
  }> {
    const vaultPath = resolveManagerVaultPath(this.options);
    const normalizedPath = normalizeRelPath(params.relPath);
    if (!vaultPath) {
      return { text: "", path: normalizedPath };
    }

    let resolvedPath: { absolutePath: string; metadata: MemoryPathMetadata };
    try {
      resolvedPath = toSafeMemoryPath(vaultPath, normalizedPath, this.options.pluginConfig);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid memory path");
    }

    const { absolutePath, metadata } = resolvedPath;
    if (!fs.existsSync(absolutePath)) {
      return {
        text: "",
        path: metadata.relPath,
        layer: metadata.layer,
        category: metadata.category,
        provenance: metadata.provenance
      };
    }

    const raw = fs.readFileSync(absolutePath, "utf-8");
    if (!Number.isFinite(params.from) && !Number.isFinite(params.lines)) {
      return {
        text: raw,
        path: metadata.relPath,
        layer: metadata.layer,
        category: metadata.category,
        provenance: metadata.provenance
      };
    }

    const from = Number.isFinite(params.from) ? Math.max(1, Math.floor(Number(params.from))) : 1;
    const lines = Number.isFinite(params.lines) ? Math.max(1, Math.floor(Number(params.lines))) : 120;
    const chunks = raw.split(/\r?\n/);
    const startIndex = from - 1;
    const sliced = chunks.slice(startIndex, startIndex + lines);
    const endLine = from + Math.max(0, sliced.length - 1);
    return {
      text: sliced.join("\n"),
      path: metadata.relPath,
      layer: metadata.layer,
      category: metadata.category,
      provenance: metadata.provenance,
      citation: `${metadata.relPath}#L${from}-L${endLine}`
    };
  }

  async writeFile(params: {
    relPath: string;
    content: string;
    mode?: "append" | "replace";
    sessionKey?: string;
    allowedLayers?: MemoryLayer[];
  }): Promise<MemoryWriteResult> {
    const vaultPath = resolveManagerVaultPath(this.options, params.sessionKey);
    const normalizedPath = normalizeRelPath(params.relPath);
    if (!vaultPath) {
      throw new Error("Vault not configured");
    }

    const mode = params.mode === "replace" ? "replace" : "append";
    const allowedLayers = params.allowedLayers ?? ["vault", "source", "boot"];
    const resolvedPath = toSafeWritablePath(
      vaultPath,
      normalizedPath,
      this.options.pluginConfig,
      allowedLayers
    );
    const { absolutePath, metadata } = resolvedPath;
    const created = !fs.existsSync(absolutePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    const payload = mode === "append"
      ? `${params.content}${params.content.endsWith("\n") ? "" : "\n"}`
      : params.content;
    if (mode === "append") {
      fs.appendFileSync(absolutePath, payload, "utf-8");
    } else {
      fs.writeFileSync(absolutePath, payload, "utf-8");
    }

    return {
      ok: true,
      path: metadata.relPath,
      layer: metadata.layer,
      category: metadata.category,
      bytes: Buffer.byteLength(payload, "utf-8"),
      mode,
      created,
      provenance: metadata.provenance
    };
  }

  async updateFile(params: {
    relPath: string;
    content: string;
    startLine?: number;
    endLine?: number;
    mode?: "append" | "replace";
    sessionKey?: string;
    allowedLayers?: MemoryLayer[];
  }): Promise<MemoryWriteResult> {
    const hasLinePatch = Number.isFinite(params.startLine) || Number.isFinite(params.endLine);
    if (!hasLinePatch) {
      return this.writeFile({
        relPath: params.relPath,
        content: params.content,
        mode: params.mode,
        sessionKey: params.sessionKey,
        allowedLayers: params.allowedLayers
      });
    }

    const vaultPath = resolveManagerVaultPath(this.options, params.sessionKey);
    if (!vaultPath) {
      throw new Error("Vault not configured");
    }
    const resolvedPath = toSafeWritablePath(
      vaultPath,
      normalizeRelPath(params.relPath),
      this.options.pluginConfig,
      params.allowedLayers ?? ["vault", "source", "boot"]
    );
    const { absolutePath, metadata } = resolvedPath;
    const created = !fs.existsSync(absolutePath);
    const existing = created ? "" : fs.readFileSync(absolutePath, "utf-8");
    const lines = existing.split(/\r?\n/);
    const startLine = Number.isFinite(params.startLine) ? Math.max(1, Math.floor(Number(params.startLine))) : lines.length + 1;
    const endLine = Number.isFinite(params.endLine) ? Math.max(startLine, Math.floor(Number(params.endLine))) : startLine;
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length, endLine);
    const replacement = params.content.split(/\r?\n/);
    lines.splice(startIndex, Math.max(0, endIndex - startIndex), ...replacement);
    const next = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, next, "utf-8");

    return {
      ok: true,
      path: metadata.relPath,
      layer: metadata.layer,
      category: metadata.category,
      bytes: Buffer.byteLength(next, "utf-8"),
      mode: "replace",
      created,
      provenance: metadata.provenance
    };
  }

  status(): MemoryProviderStatus {
    const vaultPath = resolveManagerVaultPath(this.options);
    const markdownFiles = vaultPath ? countMarkdownFiles(path.join(vaultPath, "memory")) : 0;
    return {
      backend: "builtin",
      provider: "clawvault",
      workspaceDir: vaultPath ?? this.options.workspaceDir,
      files: markdownFiles,
      sources: ["boot", "vault", "source"],
      vector: {
        enabled: true,
        available: hasQmd()
      }
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void> {
    params?.progress?.({ completed: 0, total: 1, label: "syncing" });
    const vaultPath = resolveManagerVaultPath(this.options);
    if (vaultPath) {
      const vault = new ClawVault(vaultPath);
      await vault.load();
    }
    params?.progress?.({ completed: 1, total: 1, label: "done" });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const sample = await this.search("health probe", { maxResults: 1, minScore: 0 });
      if (sample.length >= 0) {
        return { ok: true };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    return hasQmd();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function buildToolSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

export function createMemorySearchToolFactory(memoryManager: MemorySearchManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      query: {
        type: "string",
        description: "Natural-language query for memory recall."
      },
      maxResults: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of snippets to return."
      },
      minScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Minimum score threshold."
      },
      sessionKey: {
        type: "string",
        description: "Optional OpenClaw session key for scoped recall."
      }
    }, ["query"]);

    const execute = async (input: Record<string, unknown>) => {
      const query = typeof input.query === "string" ? input.query : "";
      if (!query.trim()) {
        return { query, count: 0, results: [] };
      }
      const results = await memoryManager.search(query, {
        maxResults: Number.isFinite(Number(input.maxResults)) ? Number(input.maxResults) : undefined,
        minScore: Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : undefined,
        sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined
      });
      return {
        query,
        count: results.length,
        results
      };
    };

    return {
      name: "memory_search",
      description: "Search ClawVault memory for relevant snippets before answering.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryGetToolFactory(memoryManager: MemorySearchManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: {
        type: "string",
        description: "Relative path from memory_search result (e.g. memory/2026-01-01.md)."
      },
      from: {
        type: "number",
        minimum: 1,
        description: "Optional start line (1-indexed)."
      },
      lines: {
        type: "number",
        minimum: 1,
        maximum: 400,
        description: "Optional number of lines to read."
      }
    }, ["relPath"]);

    const execute = async (input: Record<string, unknown>) => {
      const relPath = typeof input.relPath === "string" ? input.relPath : "";
      if (!relPath.trim()) {
        return { path: relPath, text: "" };
      }
      return memoryManager.readFile({
        relPath,
        from: Number.isFinite(Number(input.from)) ? Number(input.from) : undefined,
        lines: Number.isFinite(Number(input.lines)) ? Number(input.lines) : undefined
      });
    };

    return {
      name: "memory_get",
      description: "Read a specific memory file or line range from ClawVault.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryCategoriesToolFactory(
  options: Pick<ClawVaultMemoryManagerOptions, "pluginConfig" | "workspaceDir" | "defaultAgentId">
): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      sessionKey: {
        type: "string",
        description: "Optional OpenClaw session key for agent-scoped vault resolution."
      }
    });

    const execute = async (input: Record<string, unknown>) => {
      const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : undefined;
      const vaultPath = resolveManagerVaultPath(options, sessionKey);
      if (!vaultPath) {
        return {
          boot: { category: "boot", layer: "boot", readEnabled: false, sources: ["builtin"] },
          categories: [] as CategoryInventoryEntry[]
        };
      }
      const categories = collectCategoryInventory(vaultPath, options.pluginConfig);
      return {
        boot: categories.find((entry) => entry.category === "boot"),
        categories
      };
    };

    return {
      name: "memory_categories",
      description: "Return normalized memory category inventory with layer and read access metadata.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryClassifyToolFactory(
  options: Pick<ClawVaultMemoryManagerOptions, "pluginConfig" | "workspaceDir" | "defaultAgentId">
): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: {
        type: "string",
        description: "Relative memory path to classify using retrieval-safe path rules."
      },
      category: {
        type: "string",
        description: "Top-level category hint when no specific path is available."
      },
      sessionKey: {
        type: "string",
        description: "Optional OpenClaw session key for agent-scoped vault resolution."
      }
    });

    const execute = async (input: Record<string, unknown>) => {
      const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : undefined;
      const vaultPath = resolveManagerVaultPath(options, sessionKey);
      const relPath = typeof input.relPath === "string" ? input.relPath : undefined;
      const category = typeof input.category === "string" ? input.category : undefined;

      if (!vaultPath) {
        return {
          ok: false,
          input: { relPath, category },
          error: "Vault not configured"
        };
      }
      return classifyMemoryTarget(vaultPath, options.pluginConfig, { relPath, category });
    };

    return {
      name: "memory_classify",
      description: "Classify a memory path/category into boot/vault/source using retrieval-identical semantics.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

function buildWriteToolResultError(error: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

export function createMemoryWriteVaultToolFactory(memoryManager: ClawVaultMemoryManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string", description: "Vault-relative target path under a durable category (e.g. projects/roadmap.md)." },
      content: { type: "string", description: "Markdown content to write." },
      mode: { type: "string", enum: ["append", "replace"], description: "Write mode; defaults to append." },
      sessionKey: { type: "string", description: "Optional OpenClaw session key for agent-scoped vault resolution." }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await memoryManager.writeFile({
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

    return {
      name: "memory_write_vault",
      description: "Write or append durable memory notes in configured vault categories.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryWriteBootToolFactory(memoryManager: ClawVaultMemoryManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      content: { type: "string", description: "Updated MEMORY.md contents or section content." },
      mode: { type: "string", enum: ["append", "replace"], description: "Write mode for MEMORY.md." },
      sessionKey: { type: "string", description: "Optional OpenClaw session key for agent-scoped vault resolution." }
    }, ["content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await memoryManager.writeFile({
          relPath: "MEMORY.md",
          content: typeof input.content === "string" ? input.content : "",
          mode: input.mode === "append" ? "append" : "replace",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
          allowedLayers: ["boot"]
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return {
      name: "memory_write_boot",
      description: "Write curated boot memory in MEMORY.md.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryCaptureSourceToolFactory(memoryManager: ClawVaultMemoryManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string", description: "Vault-relative path in source layers (e.g. captures/incident-2026-03-25.md)." },
      content: { type: "string", description: "Captured source text to append/write." },
      mode: { type: "string", enum: ["append", "replace"], description: "Write mode; defaults to append." },
      sessionKey: { type: "string", description: "Optional OpenClaw session key for agent-scoped vault resolution." }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await memoryManager.writeFile({
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

    return {
      name: "memory_capture_source",
      description: "Capture raw source observations in source-layer categories.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryUpdateToolFactory(
  memoryManager: ClawVaultMemoryManager,
  toolName: "memory_update" | "memory_patch" = "memory_update"
): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: { type: "string", description: "Vault-relative path to update." },
      content: { type: "string", description: "Replacement content or appended text." },
      startLine: { type: "number", minimum: 1, description: "Optional 1-indexed start line for line patch replacement." },
      endLine: { type: "number", minimum: 1, description: "Optional 1-indexed end line for line patch replacement." },
      mode: { type: "string", enum: ["append", "replace"], description: "Fallback mode when no line range is provided." },
      sessionKey: { type: "string", description: "Optional OpenClaw session key for agent-scoped vault resolution." }
    }, ["relPath", "content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await memoryManager.updateFile({
          relPath: typeof input.relPath === "string" ? input.relPath : "",
          content: typeof input.content === "string" ? input.content : "",
          startLine: Number.isFinite(Number(input.startLine)) ? Number(input.startLine) : undefined,
          endLine: Number.isFinite(Number(input.endLine)) ? Number(input.endLine) : undefined,
          mode: input.mode === "replace" ? "replace" : "append",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined
        });
      } catch (error) {
        return buildWriteToolResultError(error);
      }
    };

    return {
      name: toolName,
      description: "Apply append/replace or line-range patch updates to an existing memory file.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}
