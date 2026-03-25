import * as fs from "fs";
import * as path from "path";
import { extractAgentIdFromSessionKey, type ClawVaultPluginConfig } from "./config.js";
import { resolveVaultPathForAgent } from "./clawvault-cli.js";
import type { MemoryLayer } from "./memory-types.js";
import {
  normalizeRelPath,
  toSafeMemoryPath
} from "./memory-manager.js";

type MemoryWriteToolOptions = {
  pluginConfig: ClawVaultPluginConfig;
  workspaceDir?: string;
  defaultAgentId?: string;
};

type MemoryWriteResult = {
  ok: boolean;
  path: string;
  layer: MemoryLayer;
  category: string;
  bytes: number;
  mode: "append" | "replace";
  created: boolean;
  provenance: {
    source: "clawvault";
    relPath: string;
    absolutePath: string;
  };
};

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
      mode: { type: "string", enum: ["append", "replace"] },
      sessionKey: { type: "string" }
    }, ["content"]);

    const execute = async (input: Record<string, unknown>) => {
      try {
        return await writeMemoryFile(options, {
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
