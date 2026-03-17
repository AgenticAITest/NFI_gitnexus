/**
 * Stateless HTTP client for the local GitNexus backend server.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackendRepo {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
}

// ── Configuration ──────────────────────────────────────────────────────────

let backendUrl = 'http://localhost:4747';

export const setBackendUrl = (url: string): void => {
  backendUrl = url.replace(/\/$/, '');
};

export const getBackendUrl = (): string => backendUrl;

// ── Helpers ────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Perform a fetch. Throws a cleaner error message on network failures.
 * For probes, pass an AbortSignal via init.signal.
 */
const backendFetch = async (
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request to ${url} was aborted`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Network error reaching GitNexus backend at ${backendUrl}: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Assert the response is OK, otherwise throw with the server's error message if available.
 */
const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let message = `Backend returned ${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // Response body was not JSON — use the status text
  }
  throw new Error(message);
};

// ── API functions ──────────────────────────────────────────────────────────

/**
 * Probe the backend to check if it is reachable.
 * Uses a short 2-second timeout. Returns true if reachable, false otherwise.
 */
export const probeBackend = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await backendFetch(
        `${backendUrl}/api/repos`,
        { signal: controller.signal },
      );
      return response.status === 200;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

/**
 * Fetch the list of indexed repositories.
 */
export const fetchRepos = async (): Promise<BackendRepo[]> => {
  const response = await backendFetch(`${backendUrl}/api/repos`);
  await assertOk(response);
  return response.json() as Promise<BackendRepo[]>;
};

/**
 * Fetch the full graph (nodes + relationships) for a repository.
 */
export const fetchGraph = async (
  repo: string,
): Promise<{ nodes: unknown[]; relationships: unknown[] }> => {
  const response = await backendFetch(
    `${backendUrl}/api/graph?repo=${encodeURIComponent(repo)}`,
  );
  await assertOk(response);
  return response.json() as Promise<{ nodes: unknown[]; relationships: unknown[] }>;
};

/**
 * Execute a raw Cypher query against the repository's graph.
 * Unwraps the `{ result }` wrapper returned by the server.
 */
export const runCypherQuery = async (
  repo: string,
  cypher: string,
): Promise<unknown[]> => {
  const response = await backendFetch(`${backendUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher, repo }),
  });
  await assertOk(response);

  const body = await response.json();
  if (body && typeof body.error === 'string') {
    throw new Error(body.error);
  }
  return (body.result ?? body) as unknown[];
};

/**
 * Run a semantic search across the repository's graph.
 */
export const runSearch = async (
  repo: string,
  query: string,
  limit?: number,
): Promise<unknown> => {
  const response = await backendFetch(`${backendUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, repo }),
  });
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the source content of a file in a repository.
 */
export const fetchFileContent = async (
  repo: string,
  filePath: string,
): Promise<string> => {
  const response = await backendFetch(
    `${backendUrl}/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}`,
  );
  await assertOk(response);

  const body = (await response.json()) as { content: string };
  return body.content;
};

/**
 * Fetch all execution-flow processes for a repository.
 */
export const fetchProcesses = async (repo: string): Promise<unknown> => {
  const response = await backendFetch(
    `${backendUrl}/api/processes?repo=${encodeURIComponent(repo)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the detailed step-by-step trace for a single process.
 */
export const fetchProcessDetail = async (
  repo: string,
  name: string,
): Promise<unknown> => {
  const response = await backendFetch(
    `${backendUrl}/api/process?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch all functional-area clusters for a repository.
 */
export const fetchClusters = async (repo: string): Promise<unknown> => {
  const response = await backendFetch(
    `${backendUrl}/api/clusters?repo=${encodeURIComponent(repo)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the members of a single cluster.
 */
export const fetchClusterDetail = async (
  repo: string,
  name: string,
): Promise<unknown> => {
  const response = await backendFetch(
    `${backendUrl}/api/cluster?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};
