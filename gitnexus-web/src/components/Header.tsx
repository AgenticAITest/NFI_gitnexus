import { Search, Settings, HelpCircle, Sparkles, ChevronDown, Plus, RefreshCw, Trash2, Shield, LogOut, User, Sun, Moon } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import type { RepoSummary } from '../services/server-connection';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { GraphNode } from '../core/graph/types';
import { EmbeddingStatus } from './EmbeddingStatus';

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

/** Simple health indicator based on repo stats (placeholder until server-side report caching) */
function getHealthBadge(stats?: RepoSummary['stats']): { label: string; color: string } | null {
  if (!stats || !stats.nodes) return null;
  // Heuristic: repos with communities and processes are well-structured
  const hasClusters = (stats.communities ?? 0) > 0;
  const hasProcesses = (stats.processes ?? 0) > 0;
  if (hasClusters && hasProcesses) return { label: 'Good', color: 'bg-emerald-500' };
  if (hasClusters || hasProcesses) return { label: 'Fair', color: 'bg-yellow-500' };
  return { label: 'Basic', color: 'bg-orange-500' };
}

// Color mapping for node types in search results
const NODE_TYPE_COLORS: Record<string, string> = {
  Folder: '#6366f1',
  File: '#3b82f6',
  Function: '#10b981',
  Class: '#f59e0b',
  Method: '#14b8a6',
  Interface: '#ec4899',
  Variable: '#64748b',
  Import: '#475569',
  Type: '#a78bfa',
};

import type { AuthUser } from '../services/auth';

interface HeaderProps {
  onFocusNode?: (nodeId: string) => void;
  availableRepos?: RepoSummary[];
  onSwitchRepo?: (repoName: string) => void;
  onReindexRepo?: (repoName: string) => void;
  onDeleteRepo?: (repoName: string) => void;
  authUser?: AuthUser | null;
  onOpenAdmin?: () => void;
  onLogout?: () => void;
}

export const Header = ({ onFocusNode, availableRepos = [], onSwitchRepo, onReindexRepo, onDeleteRepo, authUser, onOpenAdmin, onLogout }: HeaderProps) => {
  const {
    projectName,
    graph,
    openChatPanel,
    isRightPanelOpen,
    rightPanelTab,
    setSettingsPanelOpen,
    setAddRepoModalOpen,
  } = useAppState();
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.relationships.length ?? 0;

  // Search results - filter nodes by name
  const searchResults = useMemo(() => {
    if (!graph || !searchQuery.trim()) return [];

    const query = searchQuery.toLowerCase();
    return graph.nodes
      .filter(node => node.properties.name.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }, [graph, searchQuery]);

  // Handle clicking outside to close dropdowns
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setIsRepoDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setIsSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle keyboard navigation in results
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isSearchOpen || searchResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = searchResults[selectedIndex];
      if (selected) {
        handleSelectNode(selected);
      }
    }
  };

  const handleSelectNode = (node: GraphNode) => {
    // onFocusNode handles both camera focus AND selection in useSigma
    onFocusNode?.(node.id);
    setSearchQuery('');
    setIsSearchOpen(false);
    setSelectedIndex(0);
  };

  return (
    <header className="flex items-center justify-between px-5 py-3 bg-deep border-b border-dashed border-border-subtle">
      {/* Left section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <img src="/CerebroNexus_darkbackground.png" alt="CerebroNexus" className="h-8 hidden dark:block" />
          <img src="/CerebroNexus_lightbackground.png" alt="CerebroNexus" className="h-8 block dark:hidden" />
        </div>

        {/* Project badge / Repo selector dropdown */}
        {projectName && (
          <div className="relative" ref={repoDropdownRef}>
            <button
              onClick={() => availableRepos.length >= 2 && setIsRepoDropdownOpen(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 bg-surface border border-border-subtle rounded-lg text-sm text-text-secondary transition-colors ${availableRepos.length >= 2 ? 'hover:bg-hover cursor-pointer' : ''}`}
            >
              <span className="w-1.5 h-1.5 bg-node-function rounded-full animate-pulse" />
              <span className="truncate max-w-[200px]">{projectName}</span>
              {availableRepos.length >= 2 && (
                <ChevronDown className={`w-3.5 h-3.5 text-text-muted transition-transform ${isRepoDropdownOpen ? 'rotate-180' : ''}`} />
              )}
            </button>

            {/* Repo dropdown */}
            {isRepoDropdownOpen && availableRepos.length >= 2 && (
              <div className="absolute top-full left-0 mt-1 w-80 bg-surface border border-border-subtle rounded-lg shadow-xl overflow-hidden z-50">
                {availableRepos.map((repo) => {
                  const isCurrent = repo.name === projectName;
                  const health = getHealthBadge(repo.stats);
                  return (
                    <div
                      key={repo.name}
                      className={`px-4 py-3 flex items-center gap-3 transition-colors ${isCurrent ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-hover border-l-2 border-transparent'}`}
                    >
                      <button
                        className="flex-1 flex items-center gap-3 text-left min-w-0"
                        onClick={() => {
                          if (!isCurrent && onSwitchRepo) {
                            onSwitchRepo(repo.name);
                          }
                          setIsRepoDropdownOpen(false);
                        }}
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isCurrent ? 'bg-node-function animate-pulse' : 'bg-text-muted'}`} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate flex items-center gap-2 ${isCurrent ? 'text-accent' : 'text-text-primary'}`}>
                            {repo.name}
                            {health && (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium text-white ${health.color}`}>
                                {health.label}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5">
                            {repo.stats?.nodes ?? '?'} nodes &middot; {repo.stats?.files ?? '?'} files
                            {repo.indexedAt && (
                              <span className="ml-1" title={new Date(repo.indexedAt).toLocaleString()}>
                                &middot; {formatRelativeDate(repo.indexedAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      {/* Action buttons */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {onReindexRepo && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onReindexRepo(repo.name); setIsRepoDropdownOpen(false); }}
                            className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                            title="Re-index"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {onDeleteRepo && !isCurrent && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onDeleteRepo(repo.name); setIsRepoDropdownOpen(false); }}
                            className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                            title="Remove from registry"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Add Repository button */}
        <button
          onClick={() => setAddRepoModalOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface border border-border-subtle rounded-lg text-sm text-text-secondary hover:bg-hover hover:text-text-primary hover:border-accent/40 transition-colors"
          title="Add New Repository"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden lg:inline">Add Repo</span>
        </button>
      </div>

      {/* Center - Search */}
      <div className="flex-1 max-w-md mx-6 relative" ref={searchRef}>
        <div className="flex items-center gap-2.5 px-3.5 py-2 bg-surface border border-border-subtle rounded-lg transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <Search className="w-4 h-4 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchOpen(true);
              setSelectedIndex(0);
            }}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted"
          />
          <kbd className="px-1.5 py-0.5 bg-elevated border border-border-subtle rounded text-[10px] text-text-muted font-mono">
            ⌘K
          </kbd>
        </div>

        {/* Search Results Dropdown */}
        {isSearchOpen && searchQuery.trim() && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border-subtle rounded-lg shadow-xl overflow-hidden z-50">
            {searchResults.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-muted">
                No nodes found for "{searchQuery}"
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    onClick={() => handleSelectNode(node)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors ${index === selectedIndex
                      ? 'bg-accent/20 text-text-primary'
                      : 'hover:bg-hover text-text-secondary'
                      }`}
                  >
                    {/* Node type indicator */}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: NODE_TYPE_COLORS[node.label] || '#6b7280' }}
                    />
                    {/* Node name */}
                    <span className="flex-1 truncate text-sm font-medium">
                      {node.properties.name}
                    </span>
                    {/* Node type badge */}
                    <span className="text-xs text-text-muted px-2 py-0.5 bg-elevated rounded">
                      {node.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Theme Toggle */}
        <button
          onClick={() => {
            const html = document.documentElement;
            const current = html.getAttribute('data-theme');
            const next = current === 'light' ? 'dark' : 'light';
            html.setAttribute('data-theme', next);
            localStorage.setItem('gitnexus-theme', next);
          }}
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Toggle theme"
        >
          <Sun className="w-[18px] h-[18px] hidden dark:block" />
          <Moon className="w-[18px] h-[18px] block dark:hidden" />
        </button>

        {/* Stats */}
        {graph && (
          <div className="flex items-center gap-4 mr-2 text-xs text-text-muted">
            <span>{nodeCount} nodes</span>
            <span>{edgeCount} edges</span>
          </div>
        )}

        {/* Embedding Status */}
        <EmbeddingStatus />

        {/* Icon buttons */}
        <button
          onClick={() => setSettingsPanelOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="AI Settings"
        >
          <Settings className="w-[18px] h-[18px]" />
        </button>
        <button className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors">
          <HelpCircle className="w-[18px] h-[18px]" />
        </button>

        {/* Admin button */}
        {onOpenAdmin && (
          <button
            onClick={onOpenAdmin}
            className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-accent transition-colors"
            title="Admin Panel"
          >
            <Shield className="w-[18px] h-[18px]" />
          </button>
        )}

        {/* User / Logout */}
        {authUser && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface border border-border-subtle">
            <User className="w-3.5 h-3.5 text-text-muted" />
            <span className="text-xs text-text-secondary max-w-[100px] truncate">{authUser.displayName}</span>
            {onLogout && (
              <button
                onClick={onLogout}
                className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 transition-colors"
                title="Logout"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* AI Button */}
        <button
          onClick={openChatPanel}
          className={`
            flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-all
            ${isRightPanelOpen && rightPanelTab === 'chat'
              ? 'bg-accent text-white shadow-glow'
              : 'bg-gradient-to-r from-accent to-accent-dim text-white shadow-glow hover:shadow-lg hover:-translate-y-0.5'
            }
          `}
        >
          <Sparkles className="w-4 h-4" />
          <span>Chat with AI</span>
        </button>
      </div>
    </header>
  );
};

