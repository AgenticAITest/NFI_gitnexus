console.log(`[WORKER] ⏱ Module top — ${performance.now().toFixed(0)}ms`);
import * as Comlink from 'comlink';
// ── ONLY lightweight / type-only static imports ──────────────────────────
// Everything heavy (LangChain, transformers.js, tree-sitter parsers, kuzu-wasm)
// is loaded lazily on first use so the worker can process Comlink messages immediately.
import { createKnowledgeGraph } from '../core/graph/graph';
import type { GraphNode, GraphRelationship } from '../core/graph/types';
import type { PipelineProgress, SerializablePipelineResult } from '../types/pipeline';
import type { PipelineResult } from '../types/pipeline';
import type { FileEntry } from '../services/zip';
import type { EmbeddingProgress, SemanticSearchResult } from '../core/embeddings/types';
import type { ProviderConfig, AgentStreamChunk } from '../core/llm/types';
import type { AgentMessage } from '../core/llm/agent';
import type { ClusterMemberInfo, ClusterEnrichment } from '../core/ingestion/cluster-enricher';
import type { CommunityNode } from '../core/ingestion/community-processor';
import type { CodebaseContext } from '../core/llm/context-builder';
import type { HybridSearchResult } from '../core/search';
type EmbeddingProgressCallback = import('../core/embeddings/embedding-pipeline').EmbeddingProgressCallback;

// ── Lazy module loaders ──────────────────────────────────────────────────
let _pipeline: typeof import('../core/ingestion/pipeline') | null = null;
const getPipeline = async () => {
  if (!_pipeline) _pipeline = await import('../core/ingestion/pipeline');
  return _pipeline;
};

let _agent: typeof import('../core/llm/agent') | null = null;
const getAgent = async () => {
  if (!_agent) _agent = await import('../core/llm/agent');
  return _agent;
};

let _langchain: typeof import('@langchain/core/messages') | null = null;
const getLangchain = async () => {
  if (!_langchain) _langchain = await import('@langchain/core/messages');
  return _langchain;
};

let _enricher: typeof import('../core/ingestion/cluster-enricher') | null = null;
const getEnricher = async () => {
  if (!_enricher) _enricher = await import('../core/ingestion/cluster-enricher');
  return _enricher;
};

let _contextBuilder: typeof import('../core/llm/context-builder') | null = null;
const getContextBuilder = async () => {
  if (!_contextBuilder) _contextBuilder = await import('../core/llm/context-builder');
  return _contextBuilder;
};

let _search: typeof import('../core/search') | null = null;
const getSearch = async () => {
  if (!_search) _search = await import('../core/search');
  return _search;
};

let _pipelineTypes: typeof import('../types/pipeline') | null = null;
const getPipelineTypes = async () => {
  if (!_pipelineTypes) _pipelineTypes = await import('../types/pipeline');
  return _pipelineTypes;
};

let embeddingModule: typeof import('../core/embeddings/embedding-pipeline') | null = null;
let embedderModule: typeof import('../core/embeddings/embedder') | null = null;
const getEmbeddingModule = async () => {
  if (!embeddingModule) embeddingModule = await import('../core/embeddings/embedding-pipeline');
  return embeddingModule;
};
const getEmbedderModule = async () => {
  if (!embedderModule) embedderModule = await import('../core/embeddings/embedder');
  return embedderModule;
};

let kuzuAdapter: typeof import('../core/kuzu/kuzu-adapter') | null = null;
const getKuzuAdapter = async () => {
  if (!kuzuAdapter) kuzuAdapter = await import('../core/kuzu/kuzu-adapter');
  return kuzuAdapter;
};

// Embedding state
let embeddingProgress: EmbeddingProgress | null = null;
let isEmbeddingComplete = false;

// File contents state - stores full file contents for grep/read tools
let storedFileContents: Map<string, string> = new Map();

// Agent state
let currentAgent: any | null = null;
let currentProviderConfig: ProviderConfig | null = null;
let currentGraphResult: PipelineResult | null = null;

// Pending enrichment config (for background processing)
let pendingEnrichmentConfig: ProviderConfig | null = null;
let enrichmentCancelled = false;

// Chat cancellation flag
let chatCancelled = false;

// ============================================================
// HTTP helpers for backend mode
// ============================================================

const httpFetch = async (
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  return fetch(url, init);
};

const createHttpExecuteQuery = (backendUrl: string, repo: string, authToken?: string) => {
  return async (cypher: string): Promise<any[]> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const response = await httpFetch(`${backendUrl}/api/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cypher, repo }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Backend query failed: ${response.status}`);
    }
    const body = await response.json();
    return (body.result ?? body) as any[];
  };
};

/**
 * Create a search function that calls the backend's /api/search endpoint,
 * which runs full hybrid search (BM25 + semantic + RRF) on the server.
 * Results are flattened from the process-grouped response into the flat
 * array format expected by createGraphRAGTools.
 */
const createHttpHybridSearch = (backendUrl: string, repo: string, authToken?: string) => {
  return async (query: string, k: number = 15): Promise<any[]> => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await httpFetch(`${backendUrl}/api/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, limit: k, repo }),
      });
      if (!response.ok) {
        return [];
      }
      const body = await response.json();
      const data = body.results ?? body;

      // Flatten process_symbols + definitions into a single ranked list
      const symbols: any[] = (data.process_symbols ?? []).map((s: any, i: number) => ({
        nodeId: s.id,
        id: s.id,
        name: s.name,
        label: s.type,
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        content: s.content ?? '',
        sources: ['bm25', 'semantic'],
        score: 1 - (i * 0.02),
      }));

      const defs: any[] = (data.definitions ?? []).map((d: any, i: number) => ({
        id: d.name,
        name: d.name,
        label: d.type || 'File',
        filePath: d.filePath,
        content: '',
        sources: ['bm25'],
        score: 0.5 - (i * 0.02),
      }));

      return [...symbols, ...defs].slice(0, k);
    } catch {
      return [];
    }
  };
};

/**
 * Worker API exposed via Comlink
 * 
 * Note: The onProgress callback is passed as a Comlink.proxy() from the main thread,
 * allowing it to be called from the worker and have it execute on the main thread.
 */
const workerApi = {
  /** Simple ping to check if worker is responsive */
  ping(): string {
    console.log(`[WORKER] ping() called at ${performance.now().toFixed(0)}ms`);
    return 'pong';
  },

  /**
   * Run the ingestion pipeline in the worker thread
   * @param file - The ZIP file to process
   * @param onProgress - Proxied callback for progress updates (runs on main thread)
   * @returns Serializable result (nodes, relationships, fileContents as object)
   */
  async runPipeline(
    file: File,
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<SerializablePipelineResult> {
    // Debug logging
    console.log('🔧 runPipeline called with clusteringConfig:', !!clusteringConfig);
    // Run the actual pipeline
    const pipeline = await getPipeline();
    const result = await pipeline.runIngestionPipeline(file, onProgress);
    currentGraphResult = result;

    // Store file contents for grep/read tools (full content, not truncated)
    storedFileContents = result.fileContents;

    // Build BM25 index for keyword search (instant, ~100ms)
    const search = await getSearch();
    const bm25DocCount = search.buildBM25Index(storedFileContents);
    if (import.meta.env.DEV) {
      console.log(`🔍 BM25 index built: ${bm25DocCount} documents`);
    }
    
    // Load graph into KuzuDB for querying (optional - gracefully degrades)
    try {
      onProgress({
        phase: 'complete',
        percent: 98,
        message: 'Loading into KuzuDB...',
        stats: {
          filesProcessed: result.graph.nodeCount,
          totalFiles: result.graph.nodeCount,
          nodesCreated: result.graph.nodeCount,
        },
      });
      
      const kuzu = await getKuzuAdapter();
      await kuzu.loadGraphToKuzu(result.graph, result.fileContents);
      
      if (import.meta.env.DEV) {
        const stats = await kuzu.getKuzuStats();
        console.log('KuzuDB loaded:', stats);
        console.log('📁 Stored', storedFileContents.size, 'files for grep/read tools');
      }
    } catch {
      // KuzuDB is optional - silently continue without it
    }
    
    // Store clustering config for background enrichment (runs after graph loads)
    if (clusteringConfig) {
      pendingEnrichmentConfig = clusteringConfig;
      console.log('📋 Clustering config saved for background enrichment');
    }
    
    // Convert to serializable format for transfer back to main thread
    const ptypes = await getPipelineTypes();
    return ptypes.serializePipelineResult(result);
  },

  /**
   * Load a pre-built graph (from server) into the browser-side KuzuDB.
   * This enables AI chat tools (Cypher, search) in server mode.
   */
  async loadServerGraph(
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    fileContents: Record<string, string>
  ): Promise<void> {
    console.log(`[WORKER] >>> loadServerGraph ENTER — ${nodes.length} nodes, ${relationships.length} rels, ${Object.keys(fileContents).length} files`);
    const kuzu = await getKuzuAdapter();
    console.log(`[WORKER] loadServerGraph — kuzu adapter loaded`);
    const graph = createKnowledgeGraph();
    for (const node of nodes) graph.addNode(node);
    for (const rel of relationships) graph.addRelationship(rel);

    const fileMap = new Map<string, string>();
    for (const [p, c] of Object.entries(fileContents)) fileMap.set(p, c);

    // Store file contents for grep/read tools
    storedFileContents = fileMap;

    // Reset KuzuDB so old repo data is cleared (initKuzu early-returns if already open)
    console.log(`[WORKER] loadServerGraph — closing old KuzuDB...`);
    await kuzu.closeKuzu();

    // Load into KuzuDB
    console.log(`[WORKER] loadServerGraph — loading graph into KuzuDB...`);
    await kuzu.loadGraphToKuzu(graph, fileMap);
    console.log(`[WORKER] loadServerGraph — building BM25 index...`);

    // Build BM25 search index
    const search = await getSearch();
    search.buildBM25Index(fileMap);
    console.log(`[WORKER] <<< loadServerGraph EXIT`);
  },

  /**
   * Execute a Cypher query against the KuzuDB database
   * @param cypher - The Cypher query string
   * @returns Query results as an array of objects
   */
  async runQuery(cypher: string): Promise<any[]> {
    const kuzu = await getKuzuAdapter();
    if (!kuzu.isKuzuReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    return kuzu.executeQuery(cypher);
  },

  /**
   * Check if the database is ready for queries
   */
  async isReady(): Promise<boolean> {
    console.log(`[WORKER] >>> isReady ENTER`);
    try {
      const kuzu = await getKuzuAdapter();
      const ready = kuzu.isKuzuReady();
      console.log(`[WORKER] <<< isReady EXIT — ${ready}`);
      return ready;
    } catch {
      console.log(`[WORKER] <<< isReady EXIT — false (error)`);
      return false;
    }
  },

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ nodes: number; edges: number }> {
    try {
      const kuzu = await getKuzuAdapter();
      return kuzu.getKuzuStats();
    } catch {
      return { nodes: 0, edges: 0 };
    }
  },

  /**
   * Run the ingestion pipeline from pre-extracted files (e.g., from git clone)
   * @param files - Array of file entries with path and content
   * @param onProgress - Proxied callback for progress updates
   * @returns Serializable result
   */
  async runPipelineFromFiles(
    files: FileEntry[],
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<SerializablePipelineResult> {
    // Skip extraction phase, start from 15%
    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Files ready',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: 0 },
    });

    // Run the pipeline
    const pl = await getPipeline();
    const result = await pl.runPipelineFromFiles(files, onProgress);
    currentGraphResult = result;

    // Store file contents for grep/read tools (full content, not truncated)
    storedFileContents = result.fileContents;

    // Build BM25 index for keyword search (instant, ~100ms)
    const search = await getSearch();
    const bm25DocCount = search.buildBM25Index(storedFileContents);
    if (import.meta.env.DEV) {
      console.log(`🔍 BM25 index built: ${bm25DocCount} documents`);
    }
    
    // Load graph into KuzuDB for querying (optional - gracefully degrades)
    try {
      onProgress({
        phase: 'complete',
        percent: 98,
        message: 'Loading into KuzuDB...',
        stats: {
          filesProcessed: result.graph.nodeCount,
          totalFiles: result.graph.nodeCount,
          nodesCreated: result.graph.nodeCount,
        },
      });
      
      const kuzu = await getKuzuAdapter();
      await kuzu.loadGraphToKuzu(result.graph, result.fileContents);
      
      if (import.meta.env.DEV) {
        const stats = await kuzu.getKuzuStats();
        console.log('KuzuDB loaded:', stats);
        console.log('📁 Stored', storedFileContents.size, 'files for grep/read tools');
      }
    } catch {
      // KuzuDB is optional - silently continue without it
    }
    
    // Store clustering config for background enrichment (runs after graph loads)
    if (clusteringConfig) {
      pendingEnrichmentConfig = clusteringConfig;
      console.log('📋 Clustering config saved for background enrichment');
    }
    
    // Convert to serializable format for transfer back to main thread
    const ptypes = await getPipelineTypes();
    return ptypes.serializePipelineResult(result);
  },

  // ============================================================
  // Embedding Pipeline Methods
  // ============================================================

  /**
   * Start the embedding pipeline in the background
   * Generates embeddings for all embeddable nodes and creates vector index
   * @param onProgress - Proxied callback for embedding progress updates
   * @param forceDevice - Force a specific device ('webgpu' or 'wasm')
   */
  async startEmbeddingPipeline(
    onProgress: (progress: EmbeddingProgress) => void,
    forceDevice?: 'webgpu' | 'wasm'
  ): Promise<void> {
    console.log(`[WORKER] >>> startEmbeddingPipeline ENTER — device=${forceDevice || 'auto'}`);
    const kuzu = await getKuzuAdapter();
    if (!kuzu.isKuzuReady()) {
      console.log(`[WORKER] <<< startEmbeddingPipeline EXIT — DB not ready, throwing`);
      throw new Error('Database not ready. Please load a repository first.');
    }

    // Reset state
    embeddingProgress = null;
    isEmbeddingComplete = false;

    const progressCallback: EmbeddingProgressCallback = (progress) => {
      embeddingProgress = progress;
      if (progress.phase === 'ready') {
        isEmbeddingComplete = true;
      }
      onProgress(progress);
    };

    const emb = await getEmbeddingModule();
    await emb.runEmbeddingPipeline(
      kuzu.executeQuery,
      kuzu.executeWithReusedStatement,
      progressCallback,
      forceDevice ? { device: forceDevice } : {}
    );
  },

  /**
   * Start background cluster enrichment (if pending)
   * Called after graph loads, runs in background like embeddings
   * @param onProgress - Progress callback
   */
  async startBackgroundEnrichment(
    onProgress?: (current: number, total: number) => void
  ): Promise<{ enriched: number; skipped: boolean }> {
    if (!pendingEnrichmentConfig) {
      console.log('⏭️ No pending enrichment config, skipping');
      return { enriched: 0, skipped: true };
    }
    
    console.log('✨ Starting background LLM enrichment...');
    try {
      await workerApi.enrichCommunities(
        pendingEnrichmentConfig,
        onProgress ?? (() => {})
      );
      pendingEnrichmentConfig = null; // Clear after running
      console.log('✅ Background enrichment completed');
      return { enriched: 1, skipped: false };
    } catch (err) {
      console.error('❌ Background enrichment failed:', err);
      pendingEnrichmentConfig = null;
      return { enriched: 0, skipped: false };
    }
  },

  /**
   * Cancel the current enrichment operation
   */
  async cancelEnrichment(): Promise<void> {
    enrichmentCancelled = true;
    pendingEnrichmentConfig = null;
    console.log('⏸️ Enrichment cancelled by user');
  },

  /**
   * Perform semantic search on the codebase
   * @param query - Natural language search query
   * @param k - Number of results to return (default: 10)
   * @param maxDistance - Maximum distance threshold (default: 0.5)
   * @returns Array of search results ordered by relevance
   */
  async semanticSearch(
    query: string,
    k: number = 10,
    maxDistance: number = 0.5
  ): Promise<SemanticSearchResult[]> {
    const kuzu = await getKuzuAdapter();
    if (!kuzu.isKuzuReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    if (!isEmbeddingComplete) {
      throw new Error('Embeddings not ready. Please wait for embedding pipeline to complete.');
    }

    const emb = await getEmbeddingModule();
    return emb.semanticSearch(kuzu.executeQuery, query, k, maxDistance);
  },

  /**
   * Perform semantic search with graph expansion
   * Finds similar nodes AND their connections
   * @param query - Natural language search query
   * @param k - Number of initial results (default: 5)
   * @param hops - Number of graph hops to expand (default: 2)
   * @returns Search results with connected nodes
   */
  async semanticSearchWithContext(
    query: string,
    k: number = 5,
    hops: number = 2
  ): Promise<any[]> {
    const kuzu = await getKuzuAdapter();
    if (!kuzu.isKuzuReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    if (!isEmbeddingComplete) {
      throw new Error('Embeddings not ready. Please wait for embedding pipeline to complete.');
    }

    const emb = await getEmbeddingModule();
    return emb.semanticSearchWithContext(kuzu.executeQuery, query, k, hops);
  },

  /**
   * Perform hybrid search combining BM25 (keyword) and semantic (embedding) search
   * Uses Reciprocal Rank Fusion (RRF) to merge results
   * 
   * @param query - Search query
   * @param k - Number of results to return (default: 10)
   * @returns Hybrid search results with RRF scores
   */
  async hybridSearch(
    query: string,
    k: number = 10
  ): Promise<HybridSearchResult[]> {
    const search = await getSearch();
    if (!search.isBM25Ready()) {
      throw new Error('Search index not ready. Please load a repository first.');
    }

    // Get BM25 results (always available after ingestion)
    const bm25Results = search.searchBM25(query, k * 3);

    // Get semantic results if embeddings are ready
    let semanticResults: SemanticSearchResult[] = [];
    if (isEmbeddingComplete) {
      try {
        const kuzu = await getKuzuAdapter();
        if (kuzu.isKuzuReady()) {
          const emb = await getEmbeddingModule();
          semanticResults = await emb.semanticSearch(kuzu.executeQuery, query, k * 3, 0.5);
        }
      } catch {
        // Semantic search failed, continue with BM25 only
      }
    }

    // Merge with RRF
    return search.mergeWithRRF(bm25Results, semanticResults, k);
  },

  /**
   * Check if BM25 search index is ready
   */
  async isBM25Ready(): Promise<boolean> {
    const search = await getSearch();
    return search.isBM25Ready();
  },

  /**
   * Get BM25 index statistics
   */
  async getBM25Stats(): Promise<{ documentCount: number; termCount: number }> {
    const search = await getSearch();
    return search.getBM25Stats();
  },

  /**
   * Check if the embedding model is loaded and ready
   */
  async isEmbeddingModelReady(): Promise<boolean> {
    try {
      const mod = await getEmbedderModule();
      return mod.isEmbedderReady();
    } catch { return false; }
  },

  /**
   * Check if embeddings are fully generated and indexed
   */
  isEmbeddingComplete(): boolean {
    return isEmbeddingComplete;
  },

  /**
   * Get current embedding progress
   */
  getEmbeddingProgress(): EmbeddingProgress | null {
    return embeddingProgress;
  },

  /**
   * Cleanup embedding model resources
   */
  async disposeEmbeddingModel(): Promise<void> {
    const mod = await getEmbedderModule();
    await mod.disposeEmbedder();
    isEmbeddingComplete = false;
    embeddingProgress = null;
  },

  /**
   * Test if KuzuDB supports array parameters in prepared statements
   * This is a diagnostic function
   */
  async testArrayParams(): Promise<{ success: boolean; error?: string }> {
    const kuzu = await getKuzuAdapter();
    if (!kuzu.isKuzuReady()) {
      return { success: false, error: 'Database not ready' };
    }
    return kuzu.testArrayParams();
  },

  // ============================================================
  // Graph RAG Agent Methods
  // ============================================================

  /**
   * Initialize the Graph RAG agent with a provider configuration
   * Must be called before using chat methods
   * @param config - Provider configuration (Azure OpenAI or Gemini)
   * @param projectName - Name of the loaded project/repository
   */
  async initializeAgent(config: ProviderConfig, projectName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const kuzu = await getKuzuAdapter();
      if (!kuzu.isKuzuReady()) {
        return { success: false, error: 'Database not ready. Please load a repository first.' };
      }

      // Create semantic search wrappers that handle embedding state
      const semanticSearchWrapper = async (query: string, k?: number, maxDistance?: number) => {
        if (!isEmbeddingComplete) {
          throw new Error('Embeddings not ready');
        }
        const emb = await getEmbeddingModule();
    return emb.semanticSearch(kuzu.executeQuery, query, k, maxDistance);
      };

      const semanticSearchWithContextWrapper = async (query: string, k?: number, hops?: number) => {
        if (!isEmbeddingComplete) {
          throw new Error('Embeddings not ready');
        }
        const emb = await getEmbeddingModule();
    return emb.semanticSearchWithContext(kuzu.executeQuery, query, k, hops);
      };

      // Hybrid search wrapper - combines BM25 + semantic
      const hybridSearchWrapper = async (query: string, k?: number) => {
        const search = await getSearch();
        const bm25Results = search.searchBM25(query, (k ?? 10) * 3);

        let semanticResults: any[] = [];
        if (isEmbeddingComplete) {
          try {
            const emb = await getEmbeddingModule();
            semanticResults = await emb.semanticSearch(kuzu.executeQuery, query, (k ?? 10) * 3, 0.5);
          } catch {
            // Semantic search failed, continue with BM25 only
          }
        }

        return search.mergeWithRRF(bm25Results, semanticResults, k ?? 10);
      };

      // Use provided projectName, or fallback to 'project' if not provided
      const resolvedProjectName = projectName || 'project';
      if (import.meta.env.DEV) {
        console.log('📛 Project name received:', { provided: projectName, resolved: resolvedProjectName });
      }
      
      let codebaseContext;
      try {
        const ctxBuilder = await getContextBuilder();
        codebaseContext = await ctxBuilder.buildCodebaseContext(kuzu.executeQuery, resolvedProjectName);
        if (import.meta.env.DEV) {
          console.log('📊 Codebase context built:', {
            files: codebaseContext.stats.fileCount,
            functions: codebaseContext.stats.functionCount,
            hotspots: codebaseContext.hotspots.length,
          });
        }
      } catch (err) {
        console.warn('Failed to build codebase context, proceeding without:', err);
      }

      const agentMod = await getAgent();
      const search = await getSearch();
      currentAgent = agentMod.createGraphRAGAgent(
        config,
        kuzu.executeQuery,
        semanticSearchWrapper,
        semanticSearchWithContextWrapper,
        hybridSearchWrapper,
        () => isEmbeddingComplete,
        () => search.isBM25Ready(),
        storedFileContents,
        codebaseContext
      );
      currentProviderConfig = config;

      if (import.meta.env.DEV) {
        console.log('🤖 Graph RAG Agent initialized with provider:', config.provider);
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (import.meta.env.DEV) {
        console.error('❌ Agent initialization failed:', error);
      }
      return { success: false, error: message };
    }
  },

  /**
   * Initialize the Graph RAG agent in backend mode (HTTP-backed tools).
   * Uses HTTP wrappers instead of local KuzuDB for all tool queries.
   * @param config - Provider configuration for the LLM
   * @param backendUrl - Base URL of the gitnexus serve backend
   * @param repoName - Repository name on the backend
   * @param fileContentsEntries - File contents as [path, content][] (Comlink can't transfer Maps)
   * @param projectName - Display name for the project
   */
  async initializeBackendAgent(
    config: ProviderConfig,
    backendUrl: string,
    repoName: string,
    fileContentsEntries: [string, string][],
    projectName?: string,
    authToken?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[initializeBackendAgent] START — ${fileContentsEntries.length} files, backend=${backendUrl}, repo=${repoName}`);
      const t0 = performance.now();

      // Rebuild Map from serializable entries (Comlink can't transfer Maps)
      const contents = new Map<string, string>(fileContentsEntries);
      storedFileContents = contents;
      console.log(`[initializeBackendAgent] Map rebuilt in ${(performance.now() - t0).toFixed(0)}ms`);

      // Create HTTP-based tool wrappers (pass auth token for authenticated servers)
      const executeQuery = createHttpExecuteQuery(backendUrl, repoName, authToken);
      const hybridSearch = createHttpHybridSearch(backendUrl, repoName, authToken);

      // Build codebase context (uses Cypher queries via HTTP).
      // Non-fatal — agent works without context.
      let codebaseContext: CodebaseContext | undefined;
      try {
        console.log(`[initializeBackendAgent] Loading context-builder module...`);
        const ctxBuilder = await getContextBuilder();
        console.log(`[initializeBackendAgent] Context-builder loaded, building context via HTTP...`);
        codebaseContext = await ctxBuilder.buildCodebaseContext(executeQuery, projectName || repoName);
      } catch (ctxErr) {
        // Non-fatal — agent works without context
        console.warn(`[initializeBackendAgent] Context build failed (non-fatal):`, ctxErr);
      }
      console.log(`[initializeBackendAgent] Context done in ${(performance.now() - t0).toFixed(0)}ms`);

      // Create agent with HTTP-backed tools.
      console.log(`[initializeBackendAgent] Loading agent module...`);
      const agentMod = await getAgent();
      console.log(`[initializeBackendAgent] Agent module loaded, creating agent...`);
      currentAgent = agentMod.createGraphRAGAgent(
        config,
        executeQuery,          // Cypher via HTTP
        hybridSearch,          // semanticSearch → server hybrid search
        hybridSearch,          // semanticSearchWithContext → same
        hybridSearch,          // hybridSearch → server hybrid search
        () => false,           // isEmbeddingReady → no local embedder
        () => true,            // isBM25Ready → available via server
        contents,              // fileContents Map
        codebaseContext,
      );

      currentProviderConfig = config;
      console.log(`[initializeBackendAgent] DONE in ${(performance.now() - t0).toFixed(0)}ms`);

      return { success: true };
    } catch (err: any) {
      if (import.meta.env.DEV) {
        console.error('❌ Backend agent initialization failed:', err);
      }
      return { success: false, error: err.message || 'Failed to initialize backend agent' };
    }
  },

  /**
   * Check if the agent is initialized
   */
  isAgentReady(): boolean {
    console.log(`[WORKER] >>> isAgentReady ENTER — agent=${currentAgent !== null}`);
    return currentAgent !== null;
  },

  /**
   * Get current provider info
   */
  getAgentProvider(): { provider: string; model: string } | null {
    if (!currentProviderConfig) return null;
    return {
      provider: currentProviderConfig.provider,
      model: currentProviderConfig.model,
    };
  },

  /**
   * Chat with the Graph RAG agent (streaming)
   * Sends response chunks via the onChunk callback
   * @param messages - Conversation history
   * @param onChunk - Proxied callback for streaming chunks (runs on main thread)
   */
  async chatStream(
    messages: AgentMessage[],
    onChunk: (chunk: AgentStreamChunk) => void
  ): Promise<void> {
    if (!currentAgent) {
      onChunk({ type: 'error', error: 'Agent not initialized. Please configure an LLM provider first.' });
      return;
    }

    chatCancelled = false;

    try {
      const agentMod = await getAgent();
      for await (const chunk of agentMod.streamAgentResponse(currentAgent, messages)) {
        if (chatCancelled) {
          await onChunk({ type: 'done' });
          break;
        }
        // Await the Comlink proxy call to maintain back-pressure and catch
        // serialization/disconnection errors instead of losing them silently.
        try {
          await onChunk(chunk);
        } catch (proxyErr) {
          console.error('[chatStream] onChunk proxy error — main thread callback may have disconnected:', proxyErr);
          break;
        }
      }
    } catch (error) {
      if (chatCancelled) {
        // Swallow errors from cancellation
        try { await onChunk({ type: 'done' }); } catch { /* proxy may be gone */ }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[chatStream] Stream error:', message, error);
      try { await onChunk({ type: 'error', error: message }); } catch { /* proxy may be gone */ }
    }
  },

  /**
   * Stop the current chat stream
   */
  stopChat(): void {
    chatCancelled = true;
  },

  /**
   * Dispose of the current agent
   */
  disposeAgent(): void {
    currentAgent = null;
    currentProviderConfig = null;
  },

  /**
   * Enrich community clusters using LLM
   */
  async enrichCommunities(
    providerConfig: ProviderConfig,
    onProgress: (current: number, total: number) => void
  ): Promise<{ enrichments: Record<string, ClusterEnrichment>, tokensUsed: number }> {
    if (!currentGraphResult) {
      throw new Error('No graph loaded. Please ingest a repository first.');
    }

    const { graph } = currentGraphResult;
    
    // Filter for community nodes
    const communityNodes = graph.nodes
      .filter(n => n.label === 'Community')
      .map(n => ({
        id: n.id,
        label: 'Community',
        heuristicLabel: n.properties.heuristicLabel,
        cohesion: n.properties.cohesion,
        symbolCount: n.properties.symbolCount
      } as CommunityNode));

    if (communityNodes.length === 0) {
      return { enrichments: {}, tokensUsed: 0 };
    }

    // Build member map: CommunityID -> Member Info
    const memberMap = new Map<string, ClusterMemberInfo[]>();
    
    // Initialize map
    communityNodes.forEach(c => memberMap.set(c.id, []));
    
    // Find all MEMBER_OF edges
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        const communityId = rel.targetId;
        const memberId = rel.sourceId; // MEMBER_OF goes Member -> Community
        
        if (memberMap.has(communityId)) {
          // Find member node details
          const memberNode = graph.nodes.find(n => n.id === memberId);
          if (memberNode) {
            memberMap.get(communityId)?.push({
              name: memberNode.properties.name,
              filePath: memberNode.properties.filePath,
              type: memberNode.label
            });
          }
        }
      }
    });

    // Create LLM client adapter for LangChain model
    const agentMod = await getAgent();
    const lc = await getLangchain();
    const chatModel = agentMod.createChatModel(providerConfig);
    const llmClient = {
      generate: async (prompt: string): Promise<string> => {
        const response = await chatModel.invoke([
          new lc.SystemMessage('You are a helpful code analysis assistant.'),
          { role: 'user', content: prompt }
        ]);
        return response.content as string;
      }
    };

    // Run enrichment
    const enricherMod = await getEnricher();
    const { enrichments, tokensUsed } = await enricherMod.enrichClustersBatch(
      communityNodes,
      memberMap,
      llmClient,
      5, // Batch size
      onProgress
    );

    if (import.meta.env.DEV) {
      console.log(`✨ Enriched ${enrichments.size} clusters using ~${Math.round(tokensUsed)} tokens`);
    }

    // Update graph nodes with enrichment data
    graph.nodes.forEach(node => {
      if (node.label === 'Community' && enrichments.has(node.id)) {
        const enrichment = enrichments.get(node.id)!;
        node.properties.name = enrichment.name; // Update display label
        node.properties.keywords = enrichment.keywords;
        node.properties.description = enrichment.description;
        node.properties.enrichedBy = 'llm';
      }
    });

    // Update KuzuDB with new data
    try {
      const kuzu = await getKuzuAdapter();
        
      onProgress(enrichments.size, enrichments.size); // Done
      
      // Update one by one via Cypher (simplest for now)
      for (const [id, enrichment] of enrichments.entries()) {
         // Escape strings for Cypher - replace backslash first, then quotes
         const escapeCypher = (str: string) => str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
         
         const keywordsStr = JSON.stringify(enrichment.keywords);
         const descStr = escapeCypher(enrichment.description);
         const nameStr = escapeCypher(enrichment.name);
         const escapedId = escapeCypher(id);
         
         const query = `
           MATCH (c:Community {id: "${escapedId}"})
           SET c.label = "${nameStr}", 
               c.keywords = ${keywordsStr}, 
               c.description = "${descStr}",
               c.enrichedBy = "llm"
         `;
         
         await kuzu.executeQuery(query);
      }
      
    } catch (err) {
      console.error('Failed to update KuzuDB with enrichment:', err);
    }
    
    // Convert Map to Record for serialization
    const enrichmentsRecord: Record<string, ClusterEnrichment> = {};
    for (const [id, val] of enrichments.entries()) {
      enrichmentsRecord[id] = val;
    }
     
    return { enrichments: enrichmentsRecord, tokensUsed };
  
  },
};

// Expose the worker API to the main thread
console.log(`[WORKER] ⏱ About to Comlink.expose — ${performance.now().toFixed(0)}ms`);
Comlink.expose(workerApi);
console.log(`[WORKER] ⏱ Comlink.expose done — ${performance.now().toFixed(0)}ms`);

// TypeScript type for the exposed API (used by the hook)
export type IngestionWorkerApi = typeof workerApi;

