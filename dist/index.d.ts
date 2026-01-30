/**
 * ClawVault Types - The elephant's memory structure
 */
interface VaultConfig {
    /** Root path of the vault */
    path: string;
    /** Name of the vault */
    name: string;
    /** Categories to create on init */
    categories: string[];
    /** Custom templates path (optional) */
    templatesPath?: string;
}
interface VaultMeta {
    name: string;
    version: string;
    created: string;
    lastUpdated: string;
    categories: string[];
    documentCount: number;
}
interface Document {
    /** Unique ID (relative path without extension) */
    id: string;
    /** Full file path */
    path: string;
    /** Category (folder name) */
    category: string;
    /** Document title */
    title: string;
    /** Raw content */
    content: string;
    /** Frontmatter metadata */
    frontmatter: Record<string, unknown>;
    /** Extracted wiki-links [[like-this]] */
    links: string[];
    /** Tags extracted from content */
    tags: string[];
    /** Last modified timestamp */
    modified: Date;
}
interface SearchResult {
    /** Document that matched */
    document: Document;
    /** Relevance score (0-1) */
    score: number;
    /** Matching snippet */
    snippet: string;
    /** Which terms matched */
    matchedTerms: string[];
}
interface SearchOptions {
    /** Max results to return */
    limit?: number;
    /** Minimum score threshold (0-1) */
    minScore?: number;
    /** Filter by category */
    category?: string;
    /** Filter by tags */
    tags?: string[];
    /** Include full content in results */
    fullContent?: boolean;
}
interface StoreOptions {
    /** Category to store in */
    category: string;
    /** Document title (used for filename) */
    title: string;
    /** Content body */
    content: string;
    /** Frontmatter metadata */
    frontmatter?: Record<string, unknown>;
    /** Override existing file */
    overwrite?: boolean;
}
interface SyncOptions {
    /** Target directory to sync to */
    target: string;
    /** Delete files in target not in source */
    deleteOrphans?: boolean;
    /** Dry run - don't actually sync */
    dryRun?: boolean;
}
interface SyncResult {
    copied: string[];
    deleted: string[];
    unchanged: string[];
    errors: string[];
}
type Category = 'preferences' | 'decisions' | 'patterns' | 'people' | 'projects' | 'goals' | 'transcripts' | 'inbox' | 'templates' | string;
declare const DEFAULT_CATEGORIES: Category[];
declare const DEFAULT_CONFIG: Partial<VaultConfig>;

/**
 * ClawVault - The elephant's memory
 */

declare class ClawVault {
    private config;
    private search;
    private initialized;
    constructor(vaultPath: string);
    /**
     * Initialize a new vault
     */
    init(options?: Partial<VaultConfig>): Promise<void>;
    /**
     * Load an existing vault
     */
    load(): Promise<void>;
    /**
     * Reindex all documents
     */
    reindex(): Promise<number>;
    /**
     * Load a document from disk
     */
    private loadDocument;
    /**
     * Store a new document
     */
    store(options: StoreOptions): Promise<Document>;
    /**
     * Quick store to inbox
     */
    capture(note: string, title?: string): Promise<Document>;
    /**
     * Search the vault
     */
    find(query: string, options?: SearchOptions): Promise<SearchResult[]>;
    /**
     * Get a document by ID or path
     */
    get(idOrPath: string): Promise<Document | null>;
    /**
     * List documents in a category
     */
    list(category?: string): Promise<Document[]>;
    /**
     * Sync vault to another location (for Obsidian on Windows, etc.)
     */
    sync(options: SyncOptions): Promise<SyncResult>;
    /**
     * Get vault statistics
     */
    stats(): Promise<{
        documents: number;
        categories: {
            [key: string]: number;
        };
        links: number;
        tags: string[];
    }>;
    /**
     * Get all categories
     */
    getCategories(): Category[];
    /**
     * Check if vault is initialized
     */
    isInitialized(): boolean;
    /**
     * Get vault path
     */
    getPath(): string;
    /**
     * Get vault name
     */
    getName(): string;
    private slugify;
    private saveIndex;
    private createTemplates;
    private generateReadme;
    private getCategoryDescription;
}
/**
 * Find and open the nearest vault (walks up directory tree)
 */
declare function findVault(startPath?: string): Promise<ClawVault | null>;
/**
 * Create a new vault
 */
declare function createVault(vaultPath: string, options?: Partial<VaultConfig>): Promise<ClawVault>;

/**
 * ClawVault Search Engine
 * Simple but effective TF-IDF based semantic search
 */

/**
 * BM25 Search Engine - industry standard for text search
 */
declare class SearchEngine {
    private documents;
    private index;
    private idf;
    private avgDocLength;
    private k1;
    private b;
    /**
     * Add or update a document in the index
     */
    addDocument(doc: Document): void;
    /**
     * Remove a document from the index
     */
    removeDocument(id: string): void;
    /**
     * Rebuild IDF scores (call after bulk updates)
     */
    rebuildIDF(): void;
    /**
     * Search for documents matching query
     */
    search(query: string, options?: SearchOptions): SearchResult[];
    /**
     * Extract relevant snippet from content
     */
    private extractSnippet;
    /**
     * Get all documents
     */
    getAllDocuments(): Document[];
    /**
     * Get document count
     */
    get size(): number;
    /**
     * Clear the index
     */
    clear(): void;
    /**
     * Export index for persistence
     */
    export(): {
        documents: Document[];
    };
    /**
     * Import from persisted data
     */
    import(data: {
        documents: Document[];
    }): void;
}
/**
 * Find wiki-links in content
 */
declare function extractWikiLinks(content: string): string[];
/**
 * Find tags in content (#tag format)
 */
declare function extractTags(content: string): string[];

/**
 * ClawVault 🐘 — An Elephant Never Forgets
 *
 * Structured memory system for AI agents with Obsidian-compatible markdown
 * and embedded semantic search.
 *
 * @example
 * ```typescript
 * import { ClawVault, createVault, findVault } from 'clawvault';
 *
 * // Create a new vault
 * const vault = await createVault('./my-memory');
 *
 * // Store a memory
 * await vault.store({
 *   category: 'decisions',
 *   title: 'Use ClawVault',
 *   content: 'Decided to use ClawVault for memory management.'
 * });
 *
 * // Search memories
 * const results = await vault.find('memory management');
 * console.log(results);
 * ```
 */

declare const VERSION = "1.0.0";

export { type Category, ClawVault, DEFAULT_CATEGORIES, DEFAULT_CONFIG, type Document, SearchEngine, type SearchOptions, type SearchResult, type StoreOptions, type SyncOptions, type SyncResult, VERSION, type VaultConfig, type VaultMeta, createVault, extractTags, extractWikiLinks, findVault };
