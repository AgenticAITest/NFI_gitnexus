import { useState, useCallback, useRef, DragEvent } from 'react';
import { Upload, FileArchive, Github, Loader2, ArrowRight, Key, Eye, EyeOff, Globe, X, Database, ArrowLeft, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { cloneRepository, parseGitHubUrl } from '../services/git-clone';
import { connectToServer, fetchRepos, normalizeServerUrl, reindexRepo, deleteRepo, type ConnectToServerResult, type RepoSummary } from '../services/server-connection';
import { FileEntry } from '../services/zip';
import { shouldIgnorePath } from '../config/ignore-service';

function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

interface DropZoneProps {
  onFileSelect: (file: File) => void;
  onGitClone?: (files: FileEntry[]) => void;
  onServerConnect?: (result: ConnectToServerResult, serverUrl?: string) => void;
  isModal?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Check if File System Access API is available
const hasDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export const DropZone = ({ onFileSelect, onGitClone, onServerConnect, isModal }: DropZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<'zip' | 'github' | 'local' | 'server'>('zip');
  const [githubUrl, setGithubUrl] = useState('');
  const [githubToken, setGithubToken] = useState(() =>
    localStorage.getItem('gitnexus-github-pat') || ''
  );
  const [showToken, setShowToken] = useState(false);
  const [rememberPat, setRememberPat] = useState(() =>
    !!localStorage.getItem('gitnexus-github-pat')
  );
  const [isCloning, setIsCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState({ phase: '', percent: 0 });
  const [error, setError] = useState<string | null>(null);

  // Local folder state
  const [isReadingFolder, setIsReadingFolder] = useState(false);
  const [folderProgress, setFolderProgress] = useState({ read: 0, total: 0 });

  // Server tab state
  const [serverUrl, setServerUrl] = useState(() =>
    localStorage.getItem('gitnexus-server-url') || ''
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFetchingRepos, setIsFetchingRepos] = useState(false);
  const [serverRepos, setServerRepos] = useState<RepoSummary[] | null>(null);
  const [connectedServerUrl, setConnectedServerUrl] = useState<string | null>(null);
  const [serverProgress, setServerProgress] = useState<{
    phase: string;
    downloaded: number;
    total: number | null;
  }>({ phase: '', downloaded: 0, total: null });
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.zip')) {
        onFileSelect(file);
      } else {
        setError('Please drop a .zip file');
      }
    }
  }, [onFileSelect]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.zip')) {
        onFileSelect(file);
      } else {
        setError('Please select a .zip file');
      }
    }
  }, [onFileSelect]);

  const handleGitClone = async () => {
    if (!githubUrl.trim()) {
      setError('Please enter a GitHub URL');
      return;
    }

    const parsed = parseGitHubUrl(githubUrl);
    if (!parsed) {
      setError('Invalid GitHub URL. Use format: https://github.com/owner/repo');
      return;
    }

    setError(null);
    setIsCloning(true);
    setCloneProgress({ phase: 'starting', percent: 0 });

    try {
      const files = await cloneRepository(
        githubUrl,
        (phase, percent) => setCloneProgress({ phase, percent }),
        githubToken || undefined
      );

      // Persist or clear PAT based on user preference
      if (rememberPat && githubToken) {
        localStorage.setItem('gitnexus-github-pat', githubToken);
      } else {
        localStorage.removeItem('gitnexus-github-pat');
        setGithubToken('');
      }

      if (onGitClone) {
        onGitClone(files);
      }
    } catch (err) {
      console.error('Clone failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to clone repository';
      if (message.includes('401') || message.includes('403') || message.includes('Authentication')) {
        if (!githubToken) {
          setError('This looks like a private repo. Add a GitHub PAT (Personal Access Token) to access it.');
        } else {
          setError('Authentication failed. Check your token permissions (needs repo access).');
        }
      } else if (message.includes('404') || message.includes('not found')) {
        setError('Repository not found. Check the URL or it might be private (needs PAT).');
      } else {
        setError(message);
      }
    } finally {
      setIsCloning(false);
    }
  };

  const handleServerConnect = async () => {
    const urlToUse = serverUrl.trim() || window.location.origin;
    if (!urlToUse) {
      setError('Please enter a server URL');
      return;
    }

    // Persist URL to localStorage
    localStorage.setItem('gitnexus-server-url', serverUrl);

    setError(null);
    setIsFetchingRepos(true);

    try {
      const baseUrl = normalizeServerUrl(urlToUse);
      const repos = await fetchRepos(baseUrl);
      setConnectedServerUrl(urlToUse);

      if (repos.length === 1) {
        // Single repo — load it directly
        handleSelectRepo(repos[0].name, urlToUse);
      } else if (repos.length === 0) {
        setError('Server has no indexed repositories. Run `gitnexus analyze` in a repo first.');
        setIsFetchingRepos(false);
      } else {
        // Multiple repos — show picker
        setServerRepos(repos);
        setIsFetchingRepos(false);
      }
    } catch (err) {
      console.error('Server connect failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to connect to server';
      if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
        setError('Cannot reach server. Check the URL and ensure the server is running.');
      } else {
        setError(message);
      }
      setIsFetchingRepos(false);
    }
  };

  const handleSelectRepo = async (repoName: string, serverUrlOverride?: string) => {
    const urlToUse = serverUrlOverride || connectedServerUrl || serverUrl.trim() || window.location.origin;

    setError(null);
    setIsConnecting(true);
    setServerProgress({ phase: 'validating', downloaded: 0, total: null });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const result = await connectToServer(
        urlToUse,
        (phase, downloaded, total) => {
          setServerProgress({ phase, downloaded, total });
        },
        abortController.signal,
        repoName
      );

      if (onServerConnect) {
        onServerConnect(result, urlToUse);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return;
      }
      console.error('Repo load failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to load repository';
      setError(message);
    } finally {
      setIsConnecting(false);
      abortControllerRef.current = null;
    }
  };

  const handleBackToRepoList = () => {
    setIsConnecting(false);
    setServerProgress({ phase: '', downloaded: 0, total: null });
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  const handleCancelConnect = () => {
    abortControllerRef.current?.abort();
    setIsConnecting(false);
  };

  // Local folder picker
  const handleLocalFolder = async () => {
    if (!hasDirectoryPicker) {
      setError('Your browser does not support the folder picker. Use Chrome or Edge.');
      return;
    }

    setError(null);
    setIsReadingFolder(true);
    setFolderProgress({ read: 0, total: 0 });

    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
      const files: FileEntry[] = [];

      // Recursively read all files
      const readDir = async (handle: FileSystemDirectoryHandle, basePath: string) => {
        for await (const entry of (handle as any).values()) {
          const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

          if (entry.kind === 'directory') {
            // Skip ignored directories early
            if (shouldIgnorePath(entryPath + '/')) continue;
            await readDir(entry as FileSystemDirectoryHandle, entryPath);
          } else {
            if (shouldIgnorePath(entryPath)) continue;
            try {
              const file = await (entry as FileSystemFileHandle).getFile();
              // Skip binary/large files
              if (file.size > 1024 * 1024) continue; // 1MB limit per file
              const content = await file.text();
              files.push({ path: `${dirHandle.name}/${entryPath}`, content });
              setFolderProgress(prev => ({ ...prev, read: files.length }));
            } catch {
              // Skip unreadable files
            }
          }
        }
      };

      await readDir(dirHandle, '');

      if (files.length === 0) {
        setError('No readable source files found in the selected folder.');
        setIsReadingFolder(false);
        return;
      }

      setIsReadingFolder(false);

      if (onGitClone) {
        onGitClone(files);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled the picker
        setIsReadingFolder(false);
        return;
      }
      console.error('Folder read failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to read folder');
      setIsReadingFolder(false);
    }
  };

  const serverProgressPercent = serverProgress.total
    ? Math.round((serverProgress.downloaded / serverProgress.total) * 100)
    : null;

  return (
    <div className={`flex items-center justify-center p-8 bg-void ${isModal ? 'py-10' : 'min-h-screen'}`}>
      {/* Background gradient effects */}
      {!isModal && (
        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-node-interface/10 rounded-full blur-3xl" />
        </div>
      )}

      <div className="relative w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center mb-6">
          <img src="/CerebroNexus_darkbackground.png" alt="CerebroNexus" className="w-1/2 min-w-[200px] hidden dark:block" />
          <img src="/CerebroNexus_lightbackground.png" alt="CerebroNexus" className="w-1/2 min-w-[200px] block dark:hidden" />
        </div>

        {/* Tab Switcher */}
        <div className="flex mb-4 bg-surface border border-border-default rounded-xl p-1">
          <button
            onClick={() => { setActiveTab('zip'); setError(null); }}
            className={`
              flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
              text-sm font-medium transition-all duration-200
              ${activeTab === 'zip'
                ? 'bg-accent text-white shadow-md'
                : 'text-text-secondary hover:text-text-primary hover:bg-elevated'
              }
            `}
          >
            <FileArchive className="w-4 h-4" />
            ZIP Upload
          </button>
          <button
            onClick={() => { setActiveTab('github'); setError(null); }}
            className={`
              flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
              text-sm font-medium transition-all duration-200
              ${activeTab === 'github'
                ? 'bg-accent text-white shadow-md'
                : 'text-text-secondary hover:text-text-primary hover:bg-elevated'
              }
            `}
          >
            <Github className="w-4 h-4" />
            GitHub
          </button>
          {hasDirectoryPicker && (
            <button
              onClick={() => { setActiveTab('local'); setError(null); }}
              className={`
                flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
                text-sm font-medium transition-all duration-200
                ${activeTab === 'local'
                  ? 'bg-accent text-white shadow-md'
                  : 'text-text-secondary hover:text-text-primary hover:bg-elevated'
                }
              `}
            >
              <FolderOpen className="w-4 h-4" />
              Local
            </button>
          )}
          <button
            onClick={() => { setActiveTab('server'); setError(null); }}
            className={`
              flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
              text-sm font-medium transition-all duration-200
              ${activeTab === 'server'
                ? 'bg-accent text-white shadow-md'
                : 'text-text-secondary hover:text-text-primary hover:bg-elevated'
              }
            `}
          >
            <Globe className="w-4 h-4" />
            Server
          </button>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        {/* ZIP Upload Tab */}
        {activeTab === 'zip' && (
          <>
            <div
              className={`
                relative p-16
                bg-surface border-2 border-dashed rounded-3xl
                transition-all duration-300 cursor-pointer
                ${isDragging
                  ? 'border-accent bg-elevated scale-105 shadow-glow'
                  : 'border-border-default hover:border-accent/50 hover:bg-elevated/50 animate-breathe'
                }
              `}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input
                id="file-input"
                type="file"
                accept=".zip"
                className="hidden"
                onChange={handleFileInput}
              />

              {/* Icon */}
              <div className={`
                mx-auto w-20 h-20 mb-6
                flex items-center justify-center
                bg-gradient-to-br from-accent to-node-interface
                rounded-2xl shadow-glow
                transition-transform duration-300
                ${isDragging ? 'scale-110' : ''}
              `}>
                {isDragging ? (
                  <Upload className="w-10 h-10 text-white" />
                ) : (
                  <FileArchive className="w-10 h-10 text-white" />
                )}
              </div>

              {/* Text */}
              <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
                {isDragging ? 'Drop it here!' : 'Drop your codebase'}
              </h2>
              <p className="text-sm text-text-secondary text-center mb-6">
                Drag & drop a .zip file to generate a knowledge graph
              </p>

              {/* Hints */}
              <div className="flex items-center justify-center gap-3 text-xs text-text-muted">
                <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                  .zip
                </span>
              </div>
            </div>

          </>
        )}

        {/* GitHub URL Tab */}
        {activeTab === 'github' && (
          <div className="p-8 bg-surface border border-border-default rounded-3xl">
            {/* Icon */}
            <div className="mx-auto w-20 h-20 mb-6 flex items-center justify-center bg-gradient-to-br from-[#333] to-[#24292e] rounded-2xl shadow-lg">
              <Github className="w-10 h-10 text-white" />
            </div>

            {/* Text */}
            <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
              Clone from GitHub
            </h2>
            <p className="text-sm text-text-secondary text-center mb-6">
              Enter a repository URL to clone directly
            </p>

            {/* Inputs - wrapped in div to prevent form autofill */}
            <div className="space-y-3" data-form-type="other">
              <input
                type="url"
                name="github-repo-url-input"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isCloning && handleGitClone()}
                placeholder="https://github.com/owner/repo"
                disabled={isCloning}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-form-type="other"
                className="
                  w-full px-4 py-3
                  bg-elevated border border-border-default rounded-xl
                  text-text-primary placeholder-text-muted
                  focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200
                "
              />

              {/* Token input for private repos */}
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                  <Key className="w-4 h-4" />
                </div>
                <input
                  type={showToken ? 'text' : 'password'}
                  name="github-pat-token-input"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="GitHub PAT (optional, for private repos)"
                  disabled={isCloning}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-form-type="other"
                  className="
                    w-full pl-10 pr-10 py-3
                    bg-elevated border border-border-default rounded-xl
                    text-text-primary placeholder-text-muted
                    focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
                    disabled:opacity-50 disabled:cursor-not-allowed
                    transition-all duration-200
                  "
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <button
                onClick={handleGitClone}
                disabled={isCloning || !githubUrl.trim()}
                className="
                  w-full flex items-center justify-center gap-2
                  px-4 py-3
                  bg-accent hover:bg-accent/90
                  text-white font-medium rounded-xl
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200
                "
              >
                {isCloning ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {cloneProgress.phase === 'cloning'
                      ? `Cloning... ${cloneProgress.percent}%`
                      : cloneProgress.phase === 'reading'
                        ? 'Reading files...'
                        : 'Starting...'
                    }
                  </>
                ) : (
                  <>
                    Clone Repository
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>
            </div>

            {/* Progress bar */}
            {isCloning && (
              <div className="mt-4">
                <div className="h-2 bg-elevated rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-300 ease-out"
                    style={{ width: `${cloneProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Remember PAT checkbox */}
            {githubToken && (
              <label className="mt-3 flex items-center gap-2 cursor-pointer justify-center">
                <input
                  type="checkbox"
                  checked={rememberPat}
                  onChange={(e) => {
                    setRememberPat(e.target.checked);
                    if (!e.target.checked) {
                      localStorage.removeItem('gitnexus-github-pat');
                    }
                  }}
                  className="w-3.5 h-3.5 rounded border-border-subtle accent-accent"
                />
                <span className="text-xs text-text-muted">Remember token (stored in browser)</span>
              </label>
            )}

            {/* Hints */}
            <div className="mt-4 flex items-center justify-center gap-3 text-xs text-text-muted">
              <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                {githubToken ? 'Private + Public' : 'Public repos'}
              </span>
              <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                Shallow clone
              </span>
            </div>
          </div>
        )}

        {/* Local Folder Tab */}
        {activeTab === 'local' && (
          <div className="p-8 bg-surface border border-border-default rounded-3xl">
            {/* Icon */}
            <div className="mx-auto w-20 h-20 mb-6 flex items-center justify-center bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl shadow-lg">
              <FolderOpen className="w-10 h-10 text-white" />
            </div>

            {/* Text */}
            <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
              {isReadingFolder ? 'Reading Files' : 'Open Local Folder'}
            </h2>
            <p className="text-sm text-text-secondary text-center mb-6">
              {isReadingFolder
                ? `Reading source files... ${folderProgress.read} files found`
                : 'Select a project folder from your computer'
              }
            </p>

            {isReadingFolder ? (
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="w-8 h-8 animate-spin text-accent" />
                <p className="text-xs text-text-muted">{folderProgress.read} files read so far...</p>
              </div>
            ) : (
              <>
                <button
                  onClick={handleLocalFolder}
                  className="
                    w-full flex items-center justify-center gap-2
                    px-4 py-3
                    bg-accent hover:bg-accent/90
                    text-white font-medium rounded-xl
                    transition-all duration-200
                  "
                >
                  <FolderOpen className="w-5 h-5" />
                  Choose Folder
                </button>

                {/* Hints */}
                <div className="mt-4 flex items-center justify-center gap-3 text-xs text-text-muted">
                  <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                    No upload needed
                  </span>
                  <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                    Stays on your machine
                  </span>
                </div>

                <p className="mt-3 text-xs text-text-muted text-center">
                  Files are read directly in your browser. Nothing is uploaded.
                </p>
              </>
            )}
          </div>
        )}

        {/* Server Tab */}
        {activeTab === 'server' && (
          <div className="p-8 bg-surface border border-border-default rounded-3xl">
            {/* Repo List View — shown after connecting to server */}
            {serverRepos && !isConnecting ? (
              <>
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => { setServerRepos(null); setConnectedServerUrl(null); }}
                    className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg transition-colors"
                    title="Back"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">Select Repository</h2>
                    <p className="text-xs text-text-muted">{serverRepos.length} repos on {connectedServerUrl}</p>
                  </div>
                </div>

                <div className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin">
                  {serverRepos.map((repo) => (
                    <div
                      key={repo.name}
                      className="p-4 bg-elevated border border-border-subtle rounded-xl hover:border-accent/50 hover:bg-hover transition-all group"
                    >
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => handleSelectRepo(repo.name)}
                          className="flex items-center gap-3 flex-1 min-w-0 text-left"
                        >
                          <div className="w-10 h-10 flex items-center justify-center bg-accent/15 rounded-lg shrink-0 group-hover:bg-accent/25 transition-colors">
                            <Database className="w-5 h-5 text-accent" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">{repo.name}</p>
                            <p className="text-[10px] text-text-muted truncate">{repo.path}</p>
                          </div>
                          <ArrowRight className="w-4 h-4 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                        </button>
                        {/* Re-index & Delete */}
                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!connectedServerUrl) return;
                              try {
                                const baseUrl = normalizeServerUrl(connectedServerUrl);
                                await reindexRepo(baseUrl, repo.name);
                              } catch (err: any) {
                                console.warn('Re-index failed:', err);
                              }
                            }}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                            title="Re-index"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!connectedServerUrl) return;
                              try {
                                const baseUrl = normalizeServerUrl(connectedServerUrl);
                                await deleteRepo(baseUrl, repo.name);
                                // Refresh the repo list
                                const updated = await fetchRepos(baseUrl);
                                setServerRepos(updated);
                              } catch (err: any) {
                                console.warn('Delete failed:', err);
                              }
                            }}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                            title="Remove from registry"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center flex-wrap gap-2 mt-2 ml-13">
                        <span className="text-[10px] text-text-muted px-2 py-0.5 bg-surface rounded">
                          {repo.stats.files} files
                        </span>
                        <span className="text-[10px] text-text-muted px-2 py-0.5 bg-surface rounded">
                          {repo.stats.nodes} nodes
                        </span>
                        <span className="text-[10px] text-text-muted px-2 py-0.5 bg-surface rounded">
                          {repo.stats.edges} edges
                        </span>
                        {repo.stats.communities > 0 && (
                          <span className="text-[10px] text-text-muted px-2 py-0.5 bg-surface rounded">
                            {repo.stats.communities} clusters
                          </span>
                        )}
                        {repo.indexedAt && (
                          <span className="text-[10px] text-text-muted px-2 py-0.5 bg-surface rounded" title={new Date(repo.indexedAt).toLocaleString()}>
                            indexed {formatRelativeDate(repo.indexedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {/* Connection Form / Loading View */}
                {/* Icon */}
                <div className="mx-auto w-20 h-20 mb-6 flex items-center justify-center bg-gradient-to-br from-accent to-emerald-600 rounded-2xl shadow-lg">
                  <Globe className="w-10 h-10 text-white" />
                </div>

                {/* Text */}
                <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
                  {isConnecting ? 'Loading Repository' : 'Connect to Server'}
                </h2>
                <p className="text-sm text-text-secondary text-center mb-6">
                  {isConnecting
                    ? 'Downloading knowledge graph...'
                    : 'Load a pre-built knowledge graph from a running GitNexus server'
                  }
                </p>

                {/* Inputs — hide while loading a repo */}
                {!isConnecting && (
                  <div className="space-y-3" data-form-type="other">
                    <input
                      type="url"
                      name="server-url-input"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !isFetchingRepos && handleServerConnect()}
                      placeholder={window.location.origin}
                      disabled={isFetchingRepos}
                      autoComplete="off"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-form-type="other"
                      className="
                        w-full px-4 py-3
                        bg-elevated border border-border-default rounded-xl
                        text-text-primary placeholder-text-muted
                        focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
                        disabled:opacity-50 disabled:cursor-not-allowed
                        transition-all duration-200
                      "
                    />

                    <button
                      onClick={handleServerConnect}
                      disabled={isFetchingRepos}
                      className="
                        w-full flex items-center justify-center gap-2
                        px-4 py-3
                        bg-accent hover:bg-accent/90
                        text-white font-medium rounded-xl
                        disabled:opacity-50 disabled:cursor-not-allowed
                        transition-all duration-200
                      "
                    >
                      {isFetchingRepos ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          Connect
                          <ArrowRight className="w-5 h-5" />
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* Loading repo progress */}
                {isConnecting && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-center gap-2 text-text-secondary text-sm">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {serverProgress.phase === 'validating'
                        ? 'Validating...'
                        : serverProgress.phase === 'downloading'
                          ? serverProgressPercent !== null
                            ? `Downloading... ${serverProgressPercent}%`
                            : `Downloading... ${formatBytes(serverProgress.downloaded)}`
                          : serverProgress.phase === 'extracting'
                            ? 'Processing...'
                            : 'Connecting...'
                      }
                    </div>

                    {/* Progress bar */}
                    {serverProgress.phase === 'downloading' && (
                      <div>
                        <div className="h-2 bg-elevated rounded-full overflow-hidden">
                          <div
                            className={`h-full bg-accent transition-all duration-300 ease-out ${
                              serverProgressPercent === null ? 'animate-pulse' : ''
                            }`}
                            style={{
                              width: serverProgressPercent !== null
                                ? `${serverProgressPercent}%`
                                : '100%',
                            }}
                          />
                        </div>
                        {serverProgress.total && (
                          <p className="mt-1 text-xs text-text-muted text-center">
                            {formatBytes(serverProgress.downloaded)} / {formatBytes(serverProgress.total)}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex justify-center gap-2">
                      {serverRepos && (
                        <button
                          onClick={handleBackToRepoList}
                          className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                        >
                          Back to list
                        </button>
                      )}
                      <button
                        onClick={handleCancelConnect}
                        className="px-4 py-2 text-sm text-red-400 hover:text-red-300 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Hints — only show on initial form */}
                {!isConnecting && (
                  <div className="mt-4 flex items-center justify-center gap-3 text-xs text-text-muted">
                    <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                      Pre-indexed
                    </span>
                    <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
                      No WASM needed
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
