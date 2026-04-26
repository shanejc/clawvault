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
export const DEFAULT_DURABLE_CATEGORIES = ["people", "projects", "decisions", "lessons", "tasks", "backlog", "handoffs"] as const;
export const DEFAULT_SOURCE_CATEGORIES = ["memory", "source", "sessions", "captures", "evidence", "chronology", "logs"] as const;

type MemoryPathMetadata = {
  relPath: string;
  layer: MemoryLayer;
  category: string;
  provenance: MemoryProvenance;
};

type CategoryInventoryEntry = {
  category: string;
  layer: MemoryLayer;
  readEnabled: boolean;
  sources: string[];
};

type CategoryRegistryClass = "default" | "custom";
type CategoryRegistryMode = "durable" | "source";
type CategoryRegistrySource = "builtin" | "plugin" | ".clawvault.json";

type CategoryRegistryEntry = {
  category: string;
  layer: MemoryLayer;
  class: CategoryRegistryClass;
  mode: CategoryRegistryMode;
  protectedDefault: boolean;
  sources: Set<string>;
};

type CategoryRegistry = {
  entries: Map<string, CategoryRegistryEntry>;
  allowDefaultOverride: boolean;
};

const MEMORY_LAYER_PRIORITY: Record<MemoryLayer, number> = {
  boot: 0,
  vault: 1,
  source: 2
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

export function normalizeRelPath(relPath: string): string {
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

export function inferLayerAndCategory(
  relPath: string,
  sourceCategories: ReadonlySet<string> = new Set(DEFAULT_SOURCE_CATEGORIES as readonly string[])
): { layer: MemoryLayer; category: string } {
  if (relPath === "MEMORY.md") {
    return { layer: "boot", category: "boot" };
  }

  const category = relPath.split("/")[0] ?? "unknown";
  if (sourceCategories.has(category)) {
    return { layer: "source", category };
  }

  return { layer: "vault", category };
}

function mapSearchResult(
  vaultPath: string,
  result: SearchResult,
  sourceCategories: ReadonlySet<string>
): MemorySearchResult {
  const relPath = normalizeRelPath(path.relative(vaultPath, result.document.path));
  const { startLine, endLine } = estimateLineRange(result.document.content, result.snippet);
  const { layer, category } = inferLayerAndCategory(relPath || path.basename(result.document.path), sourceCategories);
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

function sortSearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
  return [...results].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const layerDelta = MEMORY_LAYER_PRIORITY[left.layer] - MEMORY_LAYER_PRIORITY[right.layer];
    if (layerDelta !== 0) {
      return layerDelta;
    }
    return left.path.localeCompare(right.path);
  });
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

function isDefaultCategory(category: string): boolean {
  return category === "boot"
    || (DEFAULT_DURABLE_CATEGORIES as readonly string[]).includes(category)
    || (DEFAULT_SOURCE_CATEGORIES as readonly string[]).includes(category);
}

function isDefaultSourceCategory(category: string): boolean {
  return (DEFAULT_SOURCE_CATEGORIES as readonly string[]).includes(category);
}

function readCategoryRegistryConfig(vaultPath: string): Record<string, unknown> {
  const configPath = path.join(vaultPath, ".clawvault.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isDefaultOverrideEnabled(pluginConfig: ClawVaultPluginConfig, config: Record<string, unknown>): boolean {
  if (pluginConfig.allowDefaultCategoryOverride === true) return true;
  return config.allowDefaultCategoryOverride === true;
}

function buildCategoryRegistry(vaultPath: string, pluginConfig: ClawVaultPluginConfig): CategoryRegistry {
  const entries = new Map<string, CategoryRegistryEntry>();
  const fileConfig = readCategoryRegistryConfig(vaultPath);
  const allowDefaultOverride = isDefaultOverrideEnabled(pluginConfig, fileConfig);

  const addDefault = (category: string, source: CategoryRegistrySource, mode: CategoryRegistryMode) => {
    const layer = category === "boot" ? "boot" : mode === "source" ? "source" : "vault";
    const existing = entries.get(category);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    entries.set(category, {
      category,
      layer,
      class: "default",
      mode,
      protectedDefault: true,
      sources: new Set([source])
    });
  };

  const addCustom = (rawName: string, source: CategoryRegistrySource, mode: CategoryRegistryMode) => {
    const category = normalizeRelPath(rawName).split("/")[0] ?? "";
    if (!isSafeCategoryName(category)) return;
    if (isDefaultCategory(category)) {
      // Overlay, don't overthrow: ignore custom attempts to redefine default semantics unless explicitly enabled.
      if (!allowDefaultOverride) return;
      addDefault(category, source, isDefaultSourceCategory(category) ? "source" : "durable");
      return;
    }
    const existing = entries.get(category);
    if (existing) {
      if (existing.mode !== mode) {
        throw new Error(`Category "${category}" is configured as both durable and source`);
      }
      existing.sources.add(source);
      return;
    }
    entries.set(category, {
      category,
      layer: mode === "source" ? "source" : "vault",
      class: "custom",
      mode,
      protectedDefault: false,
      sources: new Set([source])
    });
  };

  addDefault("boot", "builtin", "durable");
  for (const category of DEFAULT_DURABLE_CATEGORIES) {
    addDefault(category, "builtin", "durable");
  }
  for (const category of DEFAULT_SOURCE_CATEGORIES) {
    addDefault(category, "builtin", "source");
  }

  if (Array.isArray((pluginConfig as { memoryOverlayFolders?: unknown }).memoryOverlayFolders)) {
    const configured = (pluginConfig as { memoryOverlayFolders?: unknown[] }).memoryOverlayFolders ?? [];
    for (const value of configured) {
      if (typeof value !== "string") continue;
      addCustom(value, "plugin", "durable");
    }
  }

  if (Array.isArray((pluginConfig as { memorySourceOverlayFolders?: unknown }).memorySourceOverlayFolders)) {
    const configured = (pluginConfig as { memorySourceOverlayFolders?: unknown[] }).memorySourceOverlayFolders ?? [];
    for (const value of configured) {
      if (typeof value !== "string") continue;
      addCustom(value, "plugin", "source");
    }
  }

  const durableCandidates = [
    fileConfig.categories,
    fileConfig.overlayCategories,
    fileConfig.customCategories
  ];
  for (const candidate of durableCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (typeof item !== "string") continue;
      addCustom(item, ".clawvault.json", "durable");
    }
  }

  if (Array.isArray(fileConfig.memoryReadRoots)) {
    for (const item of fileConfig.memoryReadRoots) {
      if (typeof item !== "string") continue;
      addCustom(item, ".clawvault.json", "source");
    }
  }

  return { entries, allowDefaultOverride };
}

function getRegistrySourceCategories(registry: CategoryRegistry): ReadonlySet<string> {
  const sourceCategories = new Set<string>();
  for (const entry of registry.entries.values()) {
    if (entry.layer === "source") {
      sourceCategories.add(entry.category);
    }
  }
  return sourceCategories;
}

function collectCategoryInventory(vaultPath: string, pluginConfig: ClawVaultPluginConfig): CategoryInventoryEntry[] {
  const registry = buildCategoryRegistry(vaultPath, pluginConfig);
  return [...registry.entries.entries()]
    .map(([category, entry]) => {
      return {
        category,
        layer: entry.layer,
        readEnabled: category === "boot" || entry.sources.size > 0,
        sources: [...entry.sources].sort()
      } satisfies CategoryInventoryEntry;
    })
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function getConfiguredCategoryFolders(vaultPath: string, pluginConfig: ClawVaultPluginConfig): Set<string> {
  const folders = new Set<string>();
  for (const entry of collectCategoryInventory(vaultPath, pluginConfig)) {
    if (entry.category === "boot") continue;
    if (entry.readEnabled) {
      folders.add(entry.category);
    }
  }

  return folders;
}

export function classifyMemoryTarget(
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

  const registry = buildCategoryRegistry(vaultPath, pluginConfig);
  const safeRoots = getConfiguredCategoryFolders(vaultPath, pluginConfig);
  const sourceCategories = getRegistrySourceCategories(registry);
  const readEnabled = safeRoots.has(normalizedCategory);
  const inferred = inferLayerAndCategory(`${normalizedCategory}/_`, sourceCategories);
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

export function toSafeMemoryPath(
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

  const registry = buildCategoryRegistry(vaultPath, pluginConfig);
  const safeRoots = getConfiguredCategoryFolders(vaultPath, pluginConfig);
  const sourceCategories = getRegistrySourceCategories(registry);
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

  const { layer, category } = inferLayerAndCategory(mapped, sourceCategories);
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
      this.options.logger?.debug?(
        `[clawvault] memory_search creating ClawVault instance for ${vaultPath}`
        );
      const vault = new ClawVault(vaultPath);
      this.options.logger?.debug?(
        `[clawvault] memory_search loading vault...`
        );
      await vault.load();
      const registry = buildCategoryRegistry(vaultPath, this.options.pluginConfig);
      const sourceCategories = getRegistrySourceCategories(registry);
      this.options.logger?.debug?(
        `[clawvault] memory_search calling find on vault with ${normalizedQuery}`
        );
      const results = await vault.find(normalizedQuery, {
        limit: maxResults,
        minScore,
        temporalBoost: true
      });
      return sortSearchResults(results.map((result) => mapSearchResult(vaultPath, result, sourceCategories)));
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
