/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to 127.0.0.1 by default (use --host to override).
 * CORS origins are configurable via GITNEXUS_CORS_ORIGINS env var.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import rateLimit from 'express-rate-limit';
import { loadMeta, listRegisteredRepos, unregisterRepo, getStoragePaths } from '../storage/repo-manager.js';
import { isGitRepo } from '../storage/git.js';
import { executeQuery, closeKuzu, withKuzuDb } from '../core/kuzu/kuzu-adapter.js';
import { NODE_TABLES } from '../core/kuzu/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromKuzu } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { indexingQueue, type IndexJob } from './indexing-queue.js';
import { authMiddleware, checkRepoAccess, auditLog } from './auth/middleware.js';
import { authRoutes } from './auth/routes.js';
import { adminRoutes } from './auth/admin-routes.js';
import { isSetupComplete } from './auth/db.js';
import type { JwtPayload } from './auth/types.js';

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: row.content,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships };
};

const statusFromError = (err: any): number => {
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

/**
 * Parse allowed CORS origins from environment or use defaults.
 * Set GITNEXUS_CORS_ORIGINS to a comma-separated list of allowed origins.
 * Example: GITNEXUS_CORS_ORIGINS=https://my-app.com,https://staging.my-app.com
 */
const getAllowedOrigins = (): string[] => {
  const env = process.env.GITNEXUS_CORS_ORIGINS;
  if (env) {
    return env.split(',').map(o => o.trim()).filter(Boolean);
  }
  return [];
};

export interface ServerOptions {
  port: number;
  host?: string;
  corsOrigins?: string[];
  webhookSecret?: string;
}

const startedAt = Date.now();

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();

  // ── CORS: configurable origins ─────────────────────────────────────
  // Defaults: localhost + deployed site. Additional origins via
  // GITNEXUS_CORS_ORIGINS env var (comma-separated).
  const extraOrigins = getAllowedOrigins();
  app.use(cors({
    origin: (origin, callback) => {
      if (
        !origin  // Non-browser requests (curl, server-to-server)
        || origin.startsWith('http://localhost:')
        || origin.startsWith('http://127.0.0.1:')
        || origin === 'https://gitnexus.vercel.app'
        || extraOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json({ limit: '10mb' }));

  // ── Cross-Origin Isolation headers (required for SharedArrayBuffer / KuzuDB WASM)
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  // ── Rate limiting ──────────────────────────────────────────────────
  // General API: 200 requests per minute per IP
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use('/api/', apiLimiter);

  // Stricter limit for webhook endpoint: 10 per minute
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many webhook requests' },
  });

  // ── Auth routes (public — no middleware) ───────────────────────────
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);

  // ── Auth middleware — protects all API routes below this point ────
  // Skips enforcement when no admin exists (single-user mode)
  app.use('/api/', authMiddleware);

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find(r => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // ── Health endpoint ────────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      const uptimeMs = Date.now() - startedAt;
      const mem = process.memoryUsage();
      res.json({
        status: 'ok',
        uptime: {
          ms: uptimeMs,
          human: formatUptime(uptimeMs),
        },
        repos: {
          count: repos.length,
          names: repos.map(r => r.name),
        },
        memory: {
          rss: formatBytes(mem.rss),
          heapUsed: formatBytes(mem.heapUsed),
          heapTotal: formatBytes(mem.heapTotal),
        },
        indexing: {
          current: indexingQueue.current()?.repoPath ?? null,
          queued: indexingQueue.pending().length,
        },
        auth: {
          enabled: isSetupComplete(),
        },
        version: process.env.npm_package_version ?? 'unknown',
        node: process.version,
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // List all registered repos (filtered by user access)
  app.get('/api/repos', async (req, res) => {
    try {
      const user = (req as any).user as JwtPayload | undefined;
      const repos = await listRegisteredRepos();
      const filtered = repos.filter(r => checkRepoAccess(r.name, user));
      res.json(filtered.map(r => ({
        name: r.name, path: r.path, indexedAt: r.indexedAt,
        lastCommit: r.lastCommit, stats: r.stats,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list repos' });
    }
  });

  // Helper: check repo access for current user
  const ensureRepoAccess = (req: express.Request, res: express.Response, repoName: string): boolean => {
    const user = (req as any).user as JwtPayload | undefined;
    if (!checkRepoAccess(repoName, user)) {
      res.status(403).json({ error: 'You do not have access to this repository' });
      return false;
    }
    return true;
  };

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      if (!ensureRepoAccess(req, res, entry.name)) return;
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get repo info' });
    }
  });

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      if (!ensureRepoAccess(req, res, entry.name)) return;
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const graph = await withKuzuDb(kuzuPath, async () => buildGraph());
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const result = await withKuzuDb(kuzuPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search
  app.post('/api/search', async (req, res) => {
    try {
      const query = (req.body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;

      const results = await withKuzuDb(kuzuPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          return hybridSearch(query, limit, executeQuery, semanticSearch);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromKuzu(query, limit);
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryProcessDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query process detail' });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryClusterDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // ── Background indexing endpoints ──────────────────────────────────

  // Trigger re-index for a repo
  app.post('/api/index', async (req, res) => {
    try {
      const repoName = req.body.repo as string;
      if (!repoName) {
        res.status(400).json({ error: 'Missing "repo" in request body' });
        return;
      }
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: `Repository "${repoName}" not found in registry` });
        return;
      }
      const job = indexingQueue.enqueue(entry.path);
      res.status(202).json({ jobId: job.id, status: job.status, repoPath: job.repoPath });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to enqueue indexing job' });
    }
  });

  // Get indexing queue status
  app.get('/api/index/status', (_req, res) => {
    res.json({
      current: indexingQueue.current(),
      queued: indexingQueue.pending(),
      recent: indexingQueue.completed(),
    });
  });

  // Get a specific job status
  app.get('/api/index/job/:id', (req, res) => {
    const job = indexingQueue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  // ── Webhook endpoint for CI/CD ────────────────────────────────────
  app.post('/api/webhook', webhookLimiter, async (req, res) => {
    // Validate secret if configured
    const secret = process.env.GITNEXUS_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'] as string;
      if (provided !== secret) {
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }
    }

    try {
      // Accept repo name or path from payload
      const repoName = req.body.repo || req.body.repository?.name;
      if (!repoName) {
        res.status(400).json({ error: 'Missing "repo" in webhook payload' });
        return;
      }

      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: `Repository "${repoName}" not found in registry` });
        return;
      }

      const job = indexingQueue.enqueue(entry.path);
      res.status(202).json({
        message: 'Indexing job queued',
        jobId: job.id,
        repo: entry.name,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Webhook processing failed' });
    }
  });

  // ── Delete repo from registry ───────────────────────────────────
  app.delete('/api/repos/:repoName', async (req, res) => {
    try {
      const repoName = req.params.repoName;
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: `Repository "${repoName}" not found in registry` });
        return;
      }
      await unregisterRepo(entry.path);
      // Optionally delete the .gitnexus storage directory
      if (req.query.deleteData === 'true') {
        try { await fs.rm(entry.storagePath, { recursive: true, force: true }); } catch {}
      }
      await backend.refreshRepos();
      res.json({ message: `Repository "${repoName}" removed from registry` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete repo' });
    }
  });

  // ── Index a local folder by path ──────────────────────────────────
  // Server mode: client sends a folder path, server indexes it
  app.post('/api/index-path', async (req, res) => {
    try {
      const folderPath = req.body.path as string;
      if (!folderPath) {
        res.status(400).json({ error: 'Missing "path" in request body' });
        return;
      }

      // Validate the path exists and is a git repo
      const resolvedPath = path.resolve(folderPath);
      try {
        await fs.access(resolvedPath);
      } catch {
        res.status(404).json({ error: `Path not found: ${resolvedPath}` });
        return;
      }

      if (!isGitRepo(resolvedPath)) {
        res.status(400).json({ error: `Not a git repository: ${resolvedPath}` });
        return;
      }

      // Check if already indexed
      const { storagePath } = getStoragePaths(resolvedPath);
      try {
        const meta = await loadMeta(storagePath);
        if (meta) {
          // Already indexed — refresh backend and return graph directly
          await backend.refreshRepos();
          const repos = await listRegisteredRepos();
          const entry = repos.find(r => path.resolve(r.path) === resolvedPath);
          if (entry) {
            const kuzuPath = path.join(entry.storagePath, 'kuzu');
            const graph = await withKuzuDb(kuzuPath, async () => buildGraph());
            res.json({ ...graph, repoInfo: { name: entry.name, repoPath: entry.path, indexedAt: entry.indexedAt, stats: entry.stats } });
            return;
          }
        }
      } catch {}

      // Not indexed yet — enqueue for background indexing
      const job = indexingQueue.enqueue(resolvedPath);
      res.status(202).json({
        message: 'Indexing started',
        jobId: job.id,
        repoPath: resolvedPath,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to index path' });
    }
  });

  // ── Server-side report storage ──────────────────────────────────
  // Reports are stored as JSON files in <repo>/.gitnexus/reports/
  // Each report has a version number; re-generating creates a new version.

  interface StoredReport {
    id: string;
    type: string;
    title: string;
    content: string;
    repo: string;
    version: number;
    createdAt: string;
  }

  const getReportsDir = (storagePath: string) => path.join(storagePath, 'reports');

  const loadReportsForRepo = async (storagePath: string): Promise<StoredReport[]> => {
    const dir = getReportsDir(storagePath);
    try {
      const files = await fs.readdir(dir);
      const reports: StoredReport[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          reports.push(JSON.parse(raw));
        } catch { /* skip corrupted files */ }
      }
      return reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
      return [];
    }
  };

  // List reports for a repo (optionally filter by type)
  app.get('/api/reports', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }
      const reports = await loadReportsForRepo(entry.storagePath);
      const typeFilter = req.query.type as string | undefined;
      const filtered = typeFilter ? reports.filter(r => r.type === typeFilter) : reports;
      // Return without content for listing (lighter payload)
      res.json(filtered.map(({ content: _, ...r }) => r));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list reports' });
    }
  });

  // Get a single report (with content)
  app.get('/api/reports/:id', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }
      const reports = await loadReportsForRepo(entry.storagePath);
      const report = reports.find(r => r.id === req.params.id);
      if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get report' });
    }
  });

  // Save a new report (auto-versions if same type+title exists)
  app.post('/api/reports', async (req, res) => {
    try {
      const { type, title, content } = req.body;
      if (!type || !title || !content) {
        res.status(400).json({ error: 'Missing type, title, or content' });
        return;
      }
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }

      const dir = getReportsDir(entry.storagePath);
      await fs.mkdir(dir, { recursive: true });

      // Determine version: find highest version for same type+title
      const existing = await loadReportsForRepo(entry.storagePath);
      const sameTypeTitle = existing.filter(r => r.type === type && r.title === title);
      const version = sameTypeTitle.length > 0
        ? Math.max(...sameTypeTitle.map(r => r.version)) + 1
        : 1;

      const id = `${type}-${Date.now()}-v${version}`;
      const report: StoredReport = {
        id,
        type,
        title,
        content,
        repo: entry.name,
        version,
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(report, null, 2), 'utf-8');
      res.status(201).json({ id, version, createdAt: report.createdAt });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to save report' });
    }
  });

  // Delete a report
  app.delete('/api/reports/:id', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }

      const dir = getReportsDir(entry.storagePath);
      const filePath = path.join(dir, `${req.params.id}.json`);
      try {
        await fs.unlink(filePath);
        res.json({ message: 'Report deleted' });
      } catch (err: any) {
        if (err.code === 'ENOENT') { res.status(404).json({ error: 'Report not found' }); }
        else throw err;
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete report' });
    }
  });

  // Get version history for a report type+title
  app.get('/api/reports/versions/:type/:title', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }
      const reports = await loadReportsForRepo(entry.storagePath);
      const versions = reports
        .filter(r => r.type === req.params.type && r.title === decodeURIComponent(req.params.title))
        .sort((a, b) => a.version - b.version)
        .map(({ content: _, ...r }) => r);
      res.json(versions);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get versions' });
    }
  });

  // Export report as HTML
  app.get('/api/reports/:id/html', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) { res.status(404).json({ error: 'Repository not found' }); return; }
      const reports = await loadReportsForRepo(entry.storagePath);
      const report = reports.find(r => r.id === req.params.id);
      if (!report) { res.status(404).json({ error: 'Report not found' }); return; }

      const html = renderReportHTML(report);
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="${report.title.replace(/[^a-zA-Z0-9-_ ]/g, '')}.html"`);
      res.send(html);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to export report' });
    }
  });

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── HTTP server + WebSocket ────────────────────────────────────────
  const httpServer = createHttpServer(app);

  // WebSocket server for real-time indexing progress
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    // Send current state on connect
    const current = indexingQueue.current();
    if (current) {
      ws.send(JSON.stringify({ type: 'job:running', job: current }));
    }
  });

  // Broadcast indexing events to all connected WebSocket clients
  const broadcast = (type: string, job: IndexJob) => {
    const message = JSON.stringify({ type, job });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  indexingQueue.on('job:queued', (job: IndexJob) => broadcast('job:queued', job));
  indexingQueue.on('job:started', (job: IndexJob) => {
    broadcast('job:started', job);
    // Refresh backend when indexing starts so it picks up changes after completion
  });
  indexingQueue.on('job:progress', (job: IndexJob) => broadcast('job:progress', job));
  indexingQueue.on('job:done', (job: IndexJob) => {
    broadcast('job:done', job);
    // Refresh MCP backend so it picks up the new index
    backend.refreshRepos().catch(() => {});
  });
  indexingQueue.on('job:error', (job: IndexJob) => broadcast('job:error', job));

  httpServer.listen(port, host, () => {
    console.log(`GitNexus server running on http://${host}:${port}`);
    if (extraOrigins.length > 0) {
      console.log(`  Extra CORS origins: ${extraOrigins.join(', ')}`);
    }
  });

  // Graceful shutdown — close Express + WebSocket + KuzuDB + AuthDB cleanly
  const shutdown = async () => {
    wss.close();
    httpServer.close();
    await cleanupMcp();
    await closeKuzu();
    await backend.disconnect();
    const { closeAuthDb } = await import('./auth/db.js');
    closeAuthDb();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

// ── Helpers ──────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert Markdown report to a styled standalone HTML page */
function renderReportHTML(report: { title: string; content: string; type: string; createdAt: string; version: number; repo: string }): string {
  // Simple Markdown-to-HTML: headings, bold, italic, code blocks, lists, paragraphs
  let body = report.content
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^(?!<[huplo])(.*\S.*)$/gm, '<p>$1</p>')
    .replace(/\n{2,}/g, '\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${report.title} - GitNexus Report</title>
<style>
  :root { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #22d3ee; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; padding: 2rem; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin: 1.5rem 0 0.5rem; color: var(--accent); }
  h2 { font-size: 1.4rem; margin: 1.5rem 0 0.5rem; color: #e2e8f0; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
  h3 { font-size: 1.1rem; margin: 1.2rem 0 0.4rem; color: #cbd5e1; }
  h4 { font-size: 1rem; margin: 1rem 0 0.3rem; color: #94a3b8; }
  p { margin: 0.5rem 0; }
  ul { margin: 0.5rem 0 0.5rem 1.5rem; }
  li { margin: 0.2rem 0; }
  code { background: var(--surface); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; color: var(--accent); }
  pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow-x: auto; margin: 0.8rem 0; }
  pre code { background: none; padding: 0; color: var(--text); }
  strong { color: #f8fafc; }
  .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
  @media print { body { background: #fff; color: #1e293b; } h1 { color: #0891b2; } h2 { color: #1e293b; } code { color: #0891b2; } pre { border-color: #e2e8f0; } .meta { color: #64748b; } }
</style>
</head>
<body>
<div class="meta">
  <strong>${report.title}</strong> &middot; ${report.type} report &middot; v${report.version}<br>
  Repository: ${report.repo} &middot; Generated: ${new Date(report.createdAt).toLocaleString()}<br>
  <em>Exported from GitNexus</em>
</div>
${body}
</body>
</html>`;
}
