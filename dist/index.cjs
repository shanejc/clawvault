"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ClawVault: () => ClawVault,
  DEFAULT_CATEGORIES: () => DEFAULT_CATEGORIES,
  DEFAULT_CONFIG: () => DEFAULT_CONFIG,
  SearchEngine: () => SearchEngine,
  VERSION: () => VERSION,
  createVault: () => createVault,
  extractTags: () => extractTags,
  extractWikiLinks: () => extractWikiLinks,
  findVault: () => findVault
});
module.exports = __toCommonJS(index_exports);

// src/lib/vault.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var import_gray_matter = __toESM(require("gray-matter"), 1);
var import_glob = require("glob");

// src/types.ts
var DEFAULT_CATEGORIES = [
  "preferences",
  "decisions",
  "patterns",
  "people",
  "projects",
  "goals",
  "transcripts",
  "inbox",
  "templates"
];
var DEFAULT_CONFIG = {
  categories: DEFAULT_CATEGORIES
};

// src/lib/search.ts
function stem(word) {
  word = word.toLowerCase();
  const suffixes = [
    "ingly",
    "edly",
    "tion",
    "sion",
    "ness",
    "ment",
    "able",
    "ible",
    "ally",
    "ful",
    "less",
    "ous",
    "ive",
    "ing",
    "ed",
    "ly",
    "s"
  ];
  for (const suffix of suffixes) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}
function tokenize(text) {
  return text.toLowerCase().replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/[^\w\s-]/g, " ").split(/\s+/).filter((t) => t.length > 2).map(stem);
}
function calculateTF(tokens) {
  const tf = {};
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  const len = tokens.length || 1;
  for (const term in tf) {
    tf[term] = tf[term] / len;
  }
  return tf;
}
var SearchEngine = class {
  documents = /* @__PURE__ */ new Map();
  index = /* @__PURE__ */ new Map();
  idf = /* @__PURE__ */ new Map();
  avgDocLength = 0;
  // BM25 parameters
  k1 = 1.5;
  b = 0.75;
  /**
   * Add or update a document in the index
   */
  addDocument(doc) {
    this.documents.set(doc.id, doc);
    const text = `${doc.title} ${doc.title} ${doc.content}`;
    const tokens = tokenize(text);
    this.index.set(doc.id, {
      id: doc.id,
      terms: calculateTF(tokens),
      termCount: tokens.length
    });
    this.rebuildIDF();
  }
  /**
   * Remove a document from the index
   */
  removeDocument(id) {
    this.documents.delete(id);
    this.index.delete(id);
    this.rebuildIDF();
  }
  /**
   * Rebuild IDF scores (call after bulk updates)
   */
  rebuildIDF() {
    const docCount = this.index.size || 1;
    const termDocCounts = /* @__PURE__ */ new Map();
    let totalLength = 0;
    for (const [, idx] of this.index) {
      totalLength += idx.termCount;
      for (const term in idx.terms) {
        termDocCounts.set(term, (termDocCounts.get(term) || 0) + 1);
      }
    }
    this.avgDocLength = totalLength / docCount;
    this.idf.clear();
    for (const [term, count] of termDocCounts) {
      this.idf.set(term, Math.log((docCount - count + 0.5) / (count + 0.5) + 1));
    }
  }
  /**
   * Search for documents matching query
   */
  search(query, options = {}) {
    const {
      limit = 10,
      minScore = 0.01,
      category,
      tags,
      fullContent = false
    } = options;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const scores = /* @__PURE__ */ new Map();
    const matchedTerms = /* @__PURE__ */ new Map();
    for (const [docId, idx] of this.index) {
      const doc = this.documents.get(docId);
      if (!doc) continue;
      if (category && doc.category !== category) continue;
      if (tags && tags.length > 0) {
        const docTags = new Set(doc.tags);
        if (!tags.some((t) => docTags.has(t))) continue;
      }
      let score = 0;
      const matched = /* @__PURE__ */ new Set();
      for (const term of queryTokens) {
        const tf = idx.terms[term] || 0;
        if (tf === 0) continue;
        const idf = this.idf.get(term) || 0;
        const docLen = idx.termCount;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
        score += idf * (numerator / denominator);
        matched.add(term);
      }
      if (score > 0) {
        scores.set(docId, score);
        matchedTerms.set(docId, matched);
      }
    }
    const sortedIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const maxScore = sortedIds[0]?.[1] || 1;
    const results = [];
    for (const [docId, score] of sortedIds) {
      const normalizedScore = score / maxScore;
      if (normalizedScore < minScore) continue;
      const doc = this.documents.get(docId);
      const matched = matchedTerms.get(docId) || /* @__PURE__ */ new Set();
      results.push({
        document: fullContent ? doc : {
          ...doc,
          content: ""
          // Omit content unless requested
        },
        score: normalizedScore,
        snippet: this.extractSnippet(doc.content, queryTokens),
        matchedTerms: [...matched]
      });
    }
    return results;
  }
  /**
   * Extract relevant snippet from content
   */
  extractSnippet(content, queryTokens) {
    const lines = content.split("\n");
    const querySet = new Set(queryTokens);
    let bestLine = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineTokens = tokenize(lines[i]);
      const matches = lineTokens.filter((t) => querySet.has(t)).length;
      if (matches > bestScore) {
        bestScore = matches;
        bestLine = i;
      }
    }
    const start = Math.max(0, bestLine - 1);
    const end = Math.min(lines.length, bestLine + 3);
    const snippet = lines.slice(start, end).join("\n").trim();
    if (snippet.length > 300) {
      return snippet.slice(0, 297) + "...";
    }
    return snippet || lines.slice(0, 3).join("\n").trim();
  }
  /**
   * Get all documents
   */
  getAllDocuments() {
    return [...this.documents.values()];
  }
  /**
   * Get document count
   */
  get size() {
    return this.documents.size;
  }
  /**
   * Clear the index
   */
  clear() {
    this.documents.clear();
    this.index.clear();
    this.idf.clear();
    this.avgDocLength = 0;
  }
  /**
   * Export index for persistence
   */
  export() {
    return {
      documents: [...this.documents.values()]
    };
  }
  /**
   * Import from persisted data
   */
  import(data) {
    this.clear();
    for (const doc of data.documents) {
      this.addDocument(doc);
    }
  }
};
function extractWikiLinks(content) {
  const matches = content.match(/\[\[([^\]]+)\]\]/g) || [];
  return matches.map((m) => m.slice(2, -2).toLowerCase());
}
function extractTags(content) {
  const matches = content.match(/#[\w-]+/g) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}

// src/lib/vault.ts
var CONFIG_FILE = ".clawvault.json";
var INDEX_FILE = ".clawvault-index.json";
var ClawVault = class {
  config;
  search;
  initialized = false;
  constructor(vaultPath) {
    this.config = {
      path: path.resolve(vaultPath),
      name: path.basename(vaultPath),
      categories: DEFAULT_CATEGORIES
    };
    this.search = new SearchEngine();
  }
  /**
   * Initialize a new vault
   */
  async init(options = {}) {
    const vaultPath = this.config.path;
    this.config = { ...this.config, ...options };
    if (!fs.existsSync(vaultPath)) {
      fs.mkdirSync(vaultPath, { recursive: true });
    }
    for (const category of this.config.categories) {
      const catPath = path.join(vaultPath, category);
      if (!fs.existsSync(catPath)) {
        fs.mkdirSync(catPath, { recursive: true });
      }
    }
    await this.createTemplates();
    const readmePath = path.join(vaultPath, "README.md");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, this.generateReadme());
    }
    const configPath = path.join(vaultPath, CONFIG_FILE);
    const meta = {
      name: this.config.name,
      version: "1.0.0",
      created: (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      categories: this.config.categories,
      documentCount: 0
    };
    fs.writeFileSync(configPath, JSON.stringify(meta, null, 2));
    this.initialized = true;
  }
  /**
   * Load an existing vault
   */
  async load() {
    const vaultPath = this.config.path;
    const configPath = path.join(vaultPath, CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Not a ClawVault: ${vaultPath} (missing ${CONFIG_FILE})`);
    }
    const meta = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    this.config.name = meta.name;
    this.config.categories = meta.categories;
    await this.reindex();
    this.initialized = true;
  }
  /**
   * Reindex all documents
   */
  async reindex() {
    this.search.clear();
    const files = await (0, import_glob.glob)("**/*.md", {
      cwd: this.config.path,
      ignore: ["**/node_modules/**", "**/.*"]
    });
    for (const file of files) {
      const doc = await this.loadDocument(file);
      if (doc) {
        this.search.addDocument(doc);
      }
    }
    await this.saveIndex();
    return this.search.size;
  }
  /**
   * Load a document from disk
   */
  async loadDocument(relativePath) {
    try {
      const fullPath = path.join(this.config.path, relativePath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const { data: frontmatter, content: body } = (0, import_gray_matter.default)(content);
      const stats = fs.statSync(fullPath);
      const parts = relativePath.split(path.sep);
      const category = parts.length > 1 ? parts[0] : "root";
      const filename = path.basename(relativePath, ".md");
      return {
        id: relativePath.replace(/\.md$/, ""),
        path: fullPath,
        category,
        title: frontmatter.title || filename,
        content: body,
        frontmatter,
        links: extractWikiLinks(body),
        tags: extractTags(body),
        modified: stats.mtime
      };
    } catch (err) {
      console.error(`Error loading ${relativePath}:`, err);
      return null;
    }
  }
  /**
   * Store a new document
   */
  async store(options) {
    const { category, title, content, frontmatter = {}, overwrite = false } = options;
    const filename = this.slugify(title) + ".md";
    const relativePath = path.join(category, filename);
    const fullPath = path.join(this.config.path, relativePath);
    if (fs.existsSync(fullPath) && !overwrite) {
      throw new Error(`Document already exists: ${relativePath}. Use overwrite: true to replace.`);
    }
    const categoryPath = path.join(this.config.path, category);
    if (!fs.existsSync(categoryPath)) {
      fs.mkdirSync(categoryPath, { recursive: true });
    }
    const fm = {
      title,
      date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
      ...frontmatter
    };
    const fileContent = import_gray_matter.default.stringify(content, fm);
    fs.writeFileSync(fullPath, fileContent);
    const doc = await this.loadDocument(relativePath);
    if (doc) {
      this.search.addDocument(doc);
      await this.saveIndex();
    }
    return doc;
  }
  /**
   * Quick store to inbox
   */
  async capture(note, title) {
    const autoTitle = title || `note-${Date.now()}`;
    return this.store({
      category: "inbox",
      title: autoTitle,
      content: note
    });
  }
  /**
   * Search the vault
   */
  async find(query, options = {}) {
    return this.search.search(query, options);
  }
  /**
   * Get a document by ID or path
   */
  async get(idOrPath) {
    const normalized = idOrPath.replace(/\.md$/, "");
    const docs = this.search.getAllDocuments();
    return docs.find((d) => d.id === normalized) || null;
  }
  /**
   * List documents in a category
   */
  async list(category) {
    const docs = this.search.getAllDocuments();
    if (category) {
      return docs.filter((d) => d.category === category);
    }
    return docs;
  }
  /**
   * Sync vault to another location (for Obsidian on Windows, etc.)
   */
  async sync(options) {
    const { target, deleteOrphans = false, dryRun = false } = options;
    const result = {
      copied: [],
      deleted: [],
      unchanged: [],
      errors: []
    };
    const sourceFiles = await (0, import_glob.glob)("**/*.md", {
      cwd: this.config.path,
      ignore: ["**/node_modules/**"]
    });
    if (!dryRun && !fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    for (const file of sourceFiles) {
      const sourcePath = path.join(this.config.path, file);
      const targetPath = path.join(target, file);
      try {
        const sourceStats = fs.statSync(sourcePath);
        let shouldCopy = true;
        if (fs.existsSync(targetPath)) {
          const targetStats = fs.statSync(targetPath);
          if (sourceStats.mtime <= targetStats.mtime) {
            result.unchanged.push(file);
            shouldCopy = false;
          }
        }
        if (shouldCopy) {
          if (!dryRun) {
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.copyFileSync(sourcePath, targetPath);
          }
          result.copied.push(file);
        }
      } catch (err) {
        result.errors.push(`${file}: ${err}`);
      }
    }
    if (deleteOrphans) {
      const targetFiles = await (0, import_glob.glob)("**/*.md", { cwd: target });
      const sourceSet = new Set(sourceFiles);
      for (const file of targetFiles) {
        if (!sourceSet.has(file)) {
          if (!dryRun) {
            fs.unlinkSync(path.join(target, file));
          }
          result.deleted.push(file);
        }
      }
    }
    return result;
  }
  /**
   * Get vault statistics
   */
  async stats() {
    const docs = this.search.getAllDocuments();
    const categories = {};
    const allTags = /* @__PURE__ */ new Set();
    let totalLinks = 0;
    for (const doc of docs) {
      categories[doc.category] = (categories[doc.category] || 0) + 1;
      totalLinks += doc.links.length;
      doc.tags.forEach((t) => allTags.add(t));
    }
    return {
      documents: docs.length,
      categories,
      links: totalLinks,
      tags: [...allTags].sort()
    };
  }
  /**
   * Get all categories
   */
  getCategories() {
    return this.config.categories;
  }
  /**
   * Check if vault is initialized
   */
  isInitialized() {
    return this.initialized;
  }
  /**
   * Get vault path
   */
  getPath() {
    return this.config.path;
  }
  /**
   * Get vault name
   */
  getName() {
    return this.config.name;
  }
  // === Private helpers ===
  slugify(text) {
    return text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
  }
  async saveIndex() {
    const indexPath = path.join(this.config.path, INDEX_FILE);
    const data = this.search.export();
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2));
    const configPath = path.join(this.config.path, CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const meta = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      meta.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
      meta.documentCount = this.search.size;
      fs.writeFileSync(configPath, JSON.stringify(meta, null, 2));
    }
  }
  async createTemplates() {
    const templatesPath = path.join(this.config.path, "templates");
    const templates = {
      "decision.md": `---
title: "Decision: {{title}}"
date: {{date}}
status: pending
---

# Decision: {{title}}

## Context
What situation led to this decision?

## Options Considered
1. **Option A** \u2014 pros/cons
2. **Option B** \u2014 pros/cons

## Decision
What was decided?

## Reasoning
Why this choice?

## Outcome
[Fill in later] What happened as a result?

## Related
- [[people/]]
- [[projects/]]

#decision`,
      "pattern.md": `---
title: "Pattern: {{title}}"
date: {{date}}
confidence: medium
frequency: situational
---

# Pattern: {{title}}

## Description
What is the pattern?

## Evidence
- {{date}}: Example 1
- {{date}}: Example 2

## Implications
How should I act on this pattern?

## Related
- [[people/]]
- [[patterns/]]

#pattern`,
      "person.md": `---
title: "{{name}}"
date: {{date}}
role: ""
---

# {{name}}

**Role:** 
**First Mentioned:** {{date}}

## Context
How do we know this person?

## Key Facts
- 

## Interactions
- {{date}}: 

## Related
- [[people/]]
- [[projects/]]

#person`,
      "project.md": `---
title: "{{title}}"
date: {{date}}
status: active
---

# {{title}}

## Overview
What is this project?

## Goals
- 

## Progress
- {{date}}: Started

## People
- [[people/]]

## Decisions
- [[decisions/]]

#project`,
      "preference.md": `---
title: "Preference: {{title}}"
date: {{date}}
category: general
---

# Preference: {{title}}

## What
Description of the preference

## Why
Reasoning behind it

## Examples
- Example 1
- Example 2

#preference`
    };
    for (const [filename, content] of Object.entries(templates)) {
      const filePath = path.join(templatesPath, filename);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content);
      }
    }
  }
  generateReadme() {
    return `# ${this.config.name} \u{1F418}

An elephant never forgets.

## Structure

${this.config.categories.map((c) => `- \`/${c}/\` \u2014 ${this.getCategoryDescription(c)}`).join("\n")}

## Quick Search

\`\`\`bash
clawvault search "query"
\`\`\`

## Quick Capture

\`\`\`bash
clawvault store --category inbox --title "note" --content "..."
\`\`\`

---

*Managed by [ClawVault](https://github.com/Versatly/clawvault)*
`;
  }
  getCategoryDescription(category) {
    const descriptions = {
      preferences: "Likes, dislikes, and preferences",
      decisions: "Choices with context and reasoning",
      patterns: "Recurring behaviors observed",
      people: "One file per person mentioned",
      projects: "Active projects and ventures",
      goals: "Long-term and short-term goals",
      transcripts: "Session summaries",
      inbox: "Quick capture \u2192 process later",
      templates: "Templates for each document type"
    };
    return descriptions[category] || category;
  }
};
async function findVault(startPath = process.cwd()) {
  let current = path.resolve(startPath);
  while (current !== path.dirname(current)) {
    const configPath = path.join(current, CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const vault = new ClawVault(current);
      await vault.load();
      return vault;
    }
    current = path.dirname(current);
  }
  return null;
}
async function createVault(vaultPath, options = {}) {
  const vault = new ClawVault(vaultPath);
  await vault.init(options);
  return vault;
}

// src/index.ts
var VERSION = "1.0.0";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ClawVault,
  DEFAULT_CATEGORIES,
  DEFAULT_CONFIG,
  SearchEngine,
  VERSION,
  createVault,
  extractTags,
  extractWikiLinks,
  findVault
});
