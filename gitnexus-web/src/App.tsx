import { useCallback, useEffect, useRef, useState } from 'react';
import { AppStateProvider, useAppState } from './hooks/useAppState';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { DropZone } from './components/DropZone';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Header } from './components/Header';
import { GraphCanvas, GraphCanvasHandle } from './components/GraphCanvas';
import { RightPanel } from './components/RightPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { FileTreePanel } from './components/FileTreePanel';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { LoginPage } from './components/LoginPage';
import { AdminPanel } from './components/AdminPanel';
import { FileEntry } from './services/zip';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { createKnowledgeGraph } from './core/graph/graph';
import { connectToServer, fetchRepos, normalizeServerUrl, reindexRepo, deleteRepo as deleteRepoApi, type ConnectToServerResult } from './services/server-connection';
import { Shield, LogOut, User } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';

const AppContent = () => {
  const {
    viewMode, setViewMode, setGraph, setFileContents, setProgress, setProjectName,
    progress, isRightPanelOpen, runPipeline, runPipelineFromFiles,
    isSettingsPanelOpen, setSettingsPanelOpen, isAddRepoModalOpen, setAddRepoModalOpen,
    refreshLLMSettings, initializeAgent, startEmbeddings, codeReferences,
    selectedNode, isCodePanelOpen, serverBaseUrl, setServerBaseUrl,
    availableRepos, setAvailableRepos, switchRepo, saveLocalRepo,
  } = useAppState();

  const { user, loading: authLoading, needsLogin, serverUrl: authServerUrl, logout } = useAuth();
  const [isAdminPanelOpen, setAdminPanelOpen] = useState(false);
  const graphCanvasRef = useRef<GraphCanvasHandle>(null);

  // ── Auth gate (simple) ──────────────────────────────────────────
  // While checking auth on mount → spinner
  // If login needed → login page
  // Everything else → normal app

  const handleFocusNode = useCallback((nodeId: string) => {
    graphCanvasRef.current?.focusNode(nodeId);
  }, []);

  const handleSettingsSaved = useCallback(() => {
    refreshLLMSettings();
    initializeAgent();
  }, [refreshLLMSettings, initializeAgent]);

  const handleReindexRepo = useCallback(async (repoName: string) => {
    if (!serverBaseUrl) return;
    try { await reindexRepo(serverBaseUrl, repoName); } catch (err) { console.warn('Re-index failed:', err); }
  }, [serverBaseUrl]);

  const handleDeleteRepo = useCallback(async (repoName: string) => {
    if (!serverBaseUrl) return;
    try {
      await deleteRepoApi(serverBaseUrl, repoName);
      const repos = await fetchRepos(serverBaseUrl);
      setAvailableRepos(repos);
    } catch (err) { console.warn('Delete failed:', err); }
  }, [serverBaseUrl, setAvailableRepos]);

  const startEmbeddingsWithFallback = useCallback(() => {
    startEmbeddings().catch((err) => {
      if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
        startEmbeddings('wasm').catch(console.warn);
      } else {
        console.warn('Embeddings auto-start failed:', err);
      }
    });
  }, [startEmbeddings]);

  const handleFileSelect = useCallback(async (file: File) => {
    const projectName = file.name.replace('.zip', '');
    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to extract files' });
    setViewMode('loading');
    try {
      const result = await runPipeline(file, (p) => setProgress(p));
      setGraph(result.graph);
      setFileContents(result.fileContents);
      saveLocalRepo(projectName, result.graph, result.fileContents);
      setViewMode('exploring');
      if (getActiveProviderConfig()) initializeAgent(projectName);
      startEmbeddingsWithFallback();
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({ phase: 'error', percent: 0, message: 'Error processing file', detail: error instanceof Error ? error.message : 'Unknown error' });
      setTimeout(() => { setViewMode('onboarding'); setProgress(null); }, 3000);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipeline, startEmbeddingsWithFallback, initializeAgent, saveLocalRepo]);

  const handleGitClone = useCallback(async (files: FileEntry[]) => {
    const firstPath = files[0]?.path || 'repository';
    const projectName = firstPath.split('/')[0].replace(/-\d+$/, '') || 'repository';
    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to process files' });
    setViewMode('loading');
    try {
      const result = await runPipelineFromFiles(files, (p) => setProgress(p));
      setGraph(result.graph);
      setFileContents(result.fileContents);
      saveLocalRepo(projectName, result.graph, result.fileContents);
      setViewMode('exploring');
      if (getActiveProviderConfig()) initializeAgent(projectName);
      startEmbeddingsWithFallback();
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({ phase: 'error', percent: 0, message: 'Error processing repository', detail: error instanceof Error ? error.message : 'Unknown error' });
      setTimeout(() => { setViewMode('onboarding'); setProgress(null); }, 3000);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipelineFromFiles, startEmbeddingsWithFallback, initializeAgent, saveLocalRepo]);

  const handleServerConnect = useCallback(async (result: ConnectToServerResult) => {
    const repoPath = result.repoInfo.repoPath;
    const projectName = result.repoInfo.name || repoPath.split('/').pop() || 'server-project';
    setProjectName(projectName);
    const graph = createKnowledgeGraph();
    for (const node of result.nodes) graph.addNode(node);
    for (const rel of result.relationships) graph.addRelationship(rel);
    setGraph(graph);
    const fileMap = new Map<string, string>();
    for (const [p, content] of Object.entries(result.fileContents)) fileMap.set(p, content);
    setFileContents(fileMap);
    setViewMode('exploring');
    // Agent initializes lazily on first chat message via HTTP-backed tools.
    // No browser-side KuzuDB WASM load — it's 512MB and risks OOM tab crashes.
    // No browser-side embeddings — the server provides hybrid search via /api/search.
    // Starting embeddings here would block the worker thread and prevent agent init.
  }, [setViewMode, setGraph, setFileContents, setProjectName]);

  const onServerConnected = useCallback(async (result: ConnectToServerResult, serverUrl?: string) => {
    await handleServerConnect(result);
    if (serverUrl) {
      const baseUrl = normalizeServerUrl(serverUrl);
      setServerBaseUrl(baseUrl);
      try {
        const repos = await fetchRepos(baseUrl);
        setAvailableRepos(repos);
      } catch (e) { console.warn('Failed to fetch repo list:', e); }
    }
  }, [handleServerConnect, setServerBaseUrl, setAvailableRepos]);

  // Auto-connect when ?server query param is present
  const autoConnectRan = useRef(false);
  useEffect(() => {
    if (autoConnectRan.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('server')) return;
    autoConnectRan.current = true;
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);
    setProgress({ phase: 'extracting', percent: 0, message: 'Connecting to server...', detail: 'Validating server' });
    setViewMode('loading');
    const serverUrl = params.get('server') || window.location.origin;
    const baseUrl = normalizeServerUrl(serverUrl);
    connectToServer(serverUrl, (phase, downloaded, total) => {
      if (phase === 'validating') setProgress({ phase: 'extracting', percent: 5, message: 'Connecting to server...', detail: 'Validating server' });
      else if (phase === 'downloading') {
        const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
        setProgress({ phase: 'extracting', percent: pct, message: 'Downloading graph...', detail: `${(downloaded / (1024 * 1024)).toFixed(1)} MB downloaded` });
      } else if (phase === 'extracting') setProgress({ phase: 'extracting', percent: 97, message: 'Processing...', detail: 'Extracting file contents' });
    }).then(async (result) => {
      handleServerConnect(result);
      setServerBaseUrl(baseUrl);
      try { const repos = await fetchRepos(baseUrl); setAvailableRepos(repos); } catch {}
    }).catch((err) => {
      console.error('Auto-connect failed:', err);
      setProgress({ phase: 'error', percent: 0, message: 'Failed to connect to server', detail: err instanceof Error ? err.message : 'Unknown error' });
      setTimeout(() => { setViewMode('onboarding'); setProgress(null); }, 3000);
    });
  }, [handleServerConnect, setProgress, setViewMode, setServerBaseUrl, setAvailableRepos]);

  // ── Render ──────────────────────────────────────────────────────

  // 1. Auth loading → spinner
  if (authLoading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <div className="flex items-center gap-3 text-text-muted">
          <div className="w-5 h-5 border-2 border-text-muted/30 border-t-accent rounded-full animate-spin" />
          <span className="text-sm">Connecting...</span>
        </div>
      </div>
    );
  }

  // 2. Needs login → login page
  if (needsLogin) {
    return <LoginPage />;
  }

  // 3. Normal app flow
  if (viewMode === 'onboarding') {
    return (
      <div className="flex flex-col h-screen bg-void">
        {/* Top bar when logged in */}
        {user && (
          <div className="flex items-center justify-end gap-2 px-5 py-2 bg-deep border-b border-border-subtle">
            {user.role === 'admin' && (
              <button
                onClick={() => setAdminPanelOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-hover hover:text-accent transition-colors"
              >
                <Shield className="w-3.5 h-3.5" />
                Admin
              </button>
            )}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface border border-border-subtle">
              <User className="w-3.5 h-3.5 text-text-muted" />
              <span className="text-xs text-text-secondary">{user.displayName}</span>
              <button onClick={() => logout()} className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 transition-colors" title="Logout">
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Admin panel modal */}
        {(serverBaseUrl || authServerUrl) && (
          <AdminPanel isOpen={isAdminPanelOpen} onClose={() => setAdminPanelOpen(false)} serverUrl={(serverBaseUrl || authServerUrl)!} availableRepos={availableRepos} currentUser={user} />
        )}

        <div className="flex-1 overflow-auto">
          <DropZone
            onFileSelect={handleFileSelect}
            onGitClone={handleGitClone}
            onServerConnect={onServerConnected}
          />
        </div>
      </div>
    );
  }

  if (viewMode === 'loading' && progress) {
    return <LoadingOverlay progress={progress} />;
  }

  return (
    <div className="flex flex-col h-screen bg-void overflow-hidden">
      <Header
        onFocusNode={handleFocusNode}
        availableRepos={availableRepos}
        onSwitchRepo={switchRepo}
        onReindexRepo={handleReindexRepo}
        onDeleteRepo={handleDeleteRepo}
        authUser={user}
        onOpenAdmin={user?.role === 'admin' ? () => setAdminPanelOpen(true) : undefined}
        onLogout={user ? () => logout() : undefined}
      />

      <ErrorBoundary fallbackMessage="A rendering error occurred. Your data is safe — click Retry to recover.">
        <main className="flex-1 flex min-h-0">
          <FileTreePanel onFocusNode={handleFocusNode} />
          <div className="flex-1 relative min-w-0">
            <GraphCanvas ref={graphCanvasRef} />
            {isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
              <div className="absolute inset-y-0 left-0 z-30 pointer-events-auto">
                <CodeReferencesPanel onFocusNode={handleFocusNode} />
              </div>
            )}
          </div>
          {isRightPanelOpen && <RightPanel />}
        </main>
      </ErrorBoundary>

      <StatusBar />

      <SettingsPanel isOpen={isSettingsPanelOpen} onClose={() => setSettingsPanelOpen(false)} onSettingsSaved={handleSettingsSaved} />

      {(serverBaseUrl || authServerUrl) && (
        <AdminPanel
          isOpen={isAdminPanelOpen}
          onClose={() => setAdminPanelOpen(false)}
          serverUrl={(serverBaseUrl || authServerUrl)!}
          availableRepos={availableRepos}
          currentUser={user}
        />
      )}

      {isAddRepoModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
          onClick={(e) => { if (e.target === e.currentTarget) setAddRepoModalOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setAddRepoModalOpen(false); }}>
          <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-void border border-border-subtle rounded-2xl shadow-2xl shadow-black/40 animate-scale-in">
            <button onClick={() => setAddRepoModalOpen(false)}
              className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-lg bg-surface border border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
              title="Close">✕</button>
            <DropZone isModal
              onFileSelect={(file) => { setAddRepoModalOpen(false); handleFileSelect(file); }}
              onGitClone={(files) => { setAddRepoModalOpen(false); handleGitClone(files); }}
              onServerConnect={async (result, serverUrl) => { setAddRepoModalOpen(false); await onServerConnected(result, serverUrl); }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

function App() {
  return (
    <AuthProvider>
      <AppStateProvider>
        <AppContent />
      </AppStateProvider>
    </AuthProvider>
  );
}

export default App;
