import { GraphNode, GraphRelationship } from '../core/graph/types';
import { getStoredTokens, emitAuthExpired } from './auth';

/** Build auth headers from stored token (if any) */
function authHeaders(): Record<string, string> {
  const { accessToken } = getStoredTokens();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/** Fetch with auth headers, emits auth-expired on 401 */
async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = { ...authHeaders(), ...init?.headers };
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) emitAuthExpired();
  return res;
}

export interface RepoSummary {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
  };
}

export interface ServerRepoInfo {
  name: string;
  repoPath: string;
  indexedAt: string;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
  };
}

export interface ConnectToServerResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>;
  repoInfo: ServerRepoInfo;
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim();

  // Strip trailing slashes
  url = url.replace(/\/+$/, '');

  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.startsWith('localhost') || url.startsWith('127.0.0.1')) {
      url = `http://${url}`;
    } else {
      url = `https://${url}`;
    }
  }

  // Add /api if not already present
  if (!url.endsWith('/api')) {
    url = `${url}/api`;
  }

  return url;
}

export async function fetchRepos(baseUrl: string): Promise<RepoSummary[]> {
  const response = await authedFetch(`${baseUrl}/repos`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

export async function fetchRepoInfo(baseUrl: string, repoName?: string): Promise<ServerRepoInfo> {
  const url = repoName ? `${baseUrl}/repo?repo=${encodeURIComponent(repoName)}` : `${baseUrl}/repo`;
  const response = await authedFetch(url);
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  // npm gitnexus@1.3.3 returns "path"; git HEAD returns "repoPath"
  return { ...data, repoPath: data.repoPath ?? data.path };
}

export async function fetchGraph(
  baseUrl: string,
  onProgress?: (downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> {
  const url = repoName ? `${baseUrl}/graph?repo=${encodeURIComponent(repoName)}` : `${baseUrl}/graph`;
  const response = await authedFetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;

  if (!response.body) {
    const data = await response.json();
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    downloaded += value.length;
    onProgress?.(downloaded, total);
  }

  const combined = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);
  return JSON.parse(text);
}

export function extractFileContents(nodes: GraphNode[]): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const node of nodes) {
    if (node.label === 'File' && (node.properties as any).content) {
      contents[node.properties.filePath] = (node.properties as any).content;
    }
  }
  return contents;
}

/** Delete a repo from the server registry */
export async function deleteRepo(baseUrl: string, repoName: string, deleteData = false): Promise<void> {
  const url = `${baseUrl}/repos/${encodeURIComponent(repoName)}${deleteData ? '?deleteData=true' : ''}`;
  const response = await authedFetch(url, { method: 'DELETE' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${response.status}`);
  }
}

/** Trigger re-index for a repo on the server */
export async function reindexRepo(baseUrl: string, repoName: string): Promise<{ jobId: string }> {
  const response = await authedFetch(`${baseUrl}/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: repoName }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${response.status}`);
  }
  return response.json();
}

/** Index a local folder path via the server */
export async function indexPath(baseUrl: string, folderPath: string): Promise<{ jobId?: string; nodes?: GraphNode[]; relationships?: GraphRelationship[]; repoInfo?: ServerRepoInfo }> {
  const response = await authedFetch(`${baseUrl}/index-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${response.status}`);
  }
  return response.json();
}

// ── Report API ───────────────────────────────────────────────────

export interface ServerReport {
  id: string;
  type: string;
  title: string;
  content?: string;
  repo: string;
  version: number;
  createdAt: string;
}

/** List reports for a repo (without content) */
export async function listReports(baseUrl: string, repoName?: string, type?: string): Promise<ServerReport[]> {
  const params = new URLSearchParams();
  if (repoName) params.set('repo', repoName);
  if (type) params.set('type', type);
  const response = await authedFetch(`${baseUrl}/reports?${params}`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

/** Get a single report with full content */
export async function getReport(baseUrl: string, reportId: string, repoName?: string): Promise<ServerReport> {
  const params = repoName ? `?repo=${encodeURIComponent(repoName)}` : '';
  const response = await authedFetch(`${baseUrl}/reports/${encodeURIComponent(reportId)}${params}`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

/** Save a report to the server (auto-versions) */
export async function saveReportToServer(baseUrl: string, report: { type: string; title: string; content: string }, repoName?: string): Promise<{ id: string; version: number }> {
  const response = await authedFetch(`${baseUrl}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...report, repo: repoName }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${response.status}`);
  }
  return response.json();
}

/** Delete a report from the server */
export async function deleteServerReport(baseUrl: string, reportId: string, repoName?: string): Promise<void> {
  const params = repoName ? `?repo=${encodeURIComponent(repoName)}` : '';
  const response = await authedFetch(`${baseUrl}/reports/${encodeURIComponent(reportId)}${params}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
}

/** Get version history for a report type+title */
export async function getReportVersions(baseUrl: string, type: string, title: string, repoName?: string): Promise<ServerReport[]> {
  const params = repoName ? `?repo=${encodeURIComponent(repoName)}` : '';
  const response = await authedFetch(`${baseUrl}/reports/versions/${encodeURIComponent(type)}/${encodeURIComponent(title)}${params}`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

/** Get HTML export URL for a report */
export function getReportHtmlUrl(baseUrl: string, reportId: string, repoName?: string): string {
  const params = repoName ? `?repo=${encodeURIComponent(repoName)}` : '';
  return `${baseUrl}/reports/${encodeURIComponent(reportId)}/html${params}`;
}

export async function connectToServer(
  url: string,
  onProgress?: (phase: string, downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string
): Promise<ConnectToServerResult> {
  const baseUrl = normalizeServerUrl(url);

  // Phase 1: Validate server
  onProgress?.('validating', 0, null);
  const repoInfo = await fetchRepoInfo(baseUrl, repoName);

  // Phase 2: Download graph
  onProgress?.('downloading', 0, null);
  const { nodes, relationships } = await fetchGraph(
    baseUrl,
    (downloaded, total) => onProgress?.('downloading', downloaded, total),
    signal,
    repoName
  );

  // Phase 3: Extract file contents
  onProgress?.('extracting', 0, null);
  const fileContents = extractFileContents(nodes);

  return { nodes, relationships, fileContents, repoInfo };
}
