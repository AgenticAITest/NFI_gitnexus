/**
 * Indexing Worker
 *
 * Forked child process that runs the full analyze pipeline for a single repo.
 * Sends progress updates to the parent via IPC messages.
 */

import path from 'path';
import fs from 'fs/promises';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import {
  initKuzu, loadGraphToKuzu, getKuzuStats, createFTSIndex, closeKuzu,
} from '../core/kuzu/kuzu-adapter.js';
import {
  getStoragePaths, saveMeta, registerRepo, addToGitignore,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo } from '../storage/git.js';

const repoPath = process.argv[2];
if (!repoPath) {
  console.error('Usage: indexing-worker <repoPath>');
  process.exit(1);
}

const sendProgress = (phase: string, percent: number, message: string, detail?: string) => {
  process.send?.({ type: 'progress', data: { phase, percent, message, detail } });
};

const run = async () => {
  if (!isGitRepo(repoPath)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const currentCommit = getCurrentCommit(repoPath);

  // Phase 1: Pipeline (0-60%)
  sendProgress('extracting', 0, 'Starting pipeline...', 'Scanning repository');
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const scaled = Math.round(progress.percent * 0.6);
    sendProgress(progress.phase, scaled, progress.message, progress.detail);
  });

  // Phase 2: KuzuDB (60-85%)
  sendProgress('kuzu', 60, 'Loading into KuzuDB...');
  await closeKuzu();
  const kuzuFiles = [kuzuPath, `${kuzuPath}.wal`, `${kuzuPath}.lock`];
  for (const f of kuzuFiles) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  await initKuzu(kuzuPath);
  let msgCount = 0;
  await loadGraphToKuzu(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
    msgCount++;
    const progress = Math.min(84, 60 + Math.round((msgCount / (msgCount + 10)) * 24));
    sendProgress('kuzu', progress, msg);
  });

  // Phase 3: FTS (85-90%)
  sendProgress('fts', 85, 'Creating search indexes...');
  try {
    await createFTSIndex('File', 'file_fts', ['name', 'content']);
    await createFTSIndex('Function', 'function_fts', ['name', 'content']);
    await createFTSIndex('Class', 'class_fts', ['name', 'content']);
    await createFTSIndex('Method', 'method_fts', ['name', 'content']);
    await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
  } catch { /* non-fatal */ }

  // Phase 4: Finalize (90-100%)
  sendProgress('done', 95, 'Saving metadata...');
  const stats = await getKuzuStats();
  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    stats: {
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
    },
  };
  await saveMeta(storagePath, meta);
  await registerRepo(repoPath, meta);
  await addToGitignore(repoPath);
  await closeKuzu();

  sendProgress('done', 100, 'Indexing complete');
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Indexing failed:', err);
    sendProgress('error', 0, 'Indexing failed', err?.message ?? String(err));
    process.exit(1);
  });
