import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode,
  Search,
  Filter,
  PanelLeftClose,
  PanelLeft,
  Box,
  Braces,
  Variable,
  Hash,
  Target,
  FileText,
  HeartPulse,
  Zap,
  TestTube2,
  Trash2,
  Download,
  FileDown,
  Wrench,
  BookOpen,
  Code2,
} from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import { FILTERABLE_LABELS, NODE_COLORS, ALL_EDGE_TYPES, EDGE_INFO, type EdgeType } from '../lib/constants';
import { GraphNode, NodeLabel } from '../core/graph/types';
import type { ReportType } from '../core/llm/types';

// Tree node structure
interface TreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  path: string;
  children: TreeNode[];
  graphNode?: GraphNode;
}

// Build tree from graph nodes
const buildFileTree = (nodes: GraphNode[]): TreeNode[] => {
  const root: TreeNode[] = [];
  const pathMap = new Map<string, TreeNode>();

  // Filter to only folders and files
  const fileNodes = nodes.filter(n => n.label === 'Folder' || n.label === 'File');

  // Sort by path to ensure parents come before children
  fileNodes.sort((a, b) => a.properties.filePath.localeCompare(b.properties.filePath));

  fileNodes.forEach(node => {
    const parts = node.properties.filePath.split('/').filter(Boolean);
    let currentPath = '';
    let currentLevel = root;

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let existing = pathMap.get(currentPath);

      if (!existing) {
        const isLastPart = index === parts.length - 1;
        const isFile = isLastPart && node.label === 'File';

        existing = {
          id: isLastPart ? node.id : currentPath,
          name: part,
          type: isFile ? 'file' : 'folder',
          path: currentPath,
          children: [],
          graphNode: isLastPart ? node : undefined,
        };

        pathMap.set(currentPath, existing);
        currentLevel.push(existing);
      }

      currentLevel = existing.children;
    });
  });

  return root;
};

// Tree item component
interface TreeItemProps {
  node: TreeNode;
  depth: number;
  searchQuery: string;
  onNodeClick: (node: TreeNode) => void;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
  selectedPath: string | null;
}

const TreeItem = ({
  node,
  depth,
  searchQuery,
  onNodeClick,
  expandedPaths,
  toggleExpanded,
  selectedPath,
}: TreeItemProps) => {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children.length > 0;

  // Filter children based on search
  const filteredChildren = useMemo(() => {
    if (!searchQuery) return node.children;
    return node.children.filter(child =>
      child.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      child.children.some(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [node.children, searchQuery]);

  // Check if this node matches search
  const matchesSearch = searchQuery && node.name.toLowerCase().includes(searchQuery.toLowerCase());

  const handleClick = () => {
    if (hasChildren) {
      toggleExpanded(node.path);
    }
    onNodeClick(node);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className={`
          w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm
          hover:bg-hover transition-colors rounded relative
          ${isSelected ? 'bg-amber-500/15 text-amber-300 border-l-2 border-amber-400' : 'text-text-secondary hover:text-text-primary border-l-2 border-transparent'}
          ${matchesSearch ? 'bg-accent/10' : ''}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Expand/collapse icon */}
        {hasChildren ? (
          isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-muted" />
          )
        ) : (
          <span className="w-3.5" />
        )}

        {/* Node icon */}
        {node.type === 'folder' ? (
          isExpanded ? (
            <FolderOpen className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.Folder }} />
          ) : (
            <Folder className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.Folder }} />
          )
        ) : (
          <FileCode className="w-4 h-4 shrink-0" style={{ color: NODE_COLORS.File }} />
        )}

        {/* Name */}
        <span className="truncate font-mono text-xs">{node.name}</span>
      </button>

      {/* Children */}
      {isExpanded && filteredChildren.length > 0 && (
        <div>
          {filteredChildren.map(child => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              searchQuery={searchQuery}
              onNodeClick={onNodeClick}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Icon for node types
const getNodeTypeIcon = (label: NodeLabel) => {
  switch (label) {
    case 'Folder': return Folder;
    case 'File': return FileCode;
    case 'Class': return Box;
    case 'Function': return Braces;
    case 'Method': return Braces;
    case 'Interface': return Hash;
    case 'Import': return FileCode;
    default: return Variable;
  }
};

interface FileTreePanelProps {
  onFocusNode: (nodeId: string) => void;
}

/** Generate a standalone HTML page from a Markdown report */
function reportToHTML(title: string, type: string, content: string, createdAt: number): string {
  let body = content
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - GitNexus Report</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#22d3ee}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.7;padding:2rem;max-width:900px;margin:0 auto}
h1{font-size:1.8rem;margin:1.5rem 0 .5rem;color:var(--accent)}h2{font-size:1.4rem;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--border);padding-bottom:.3rem}
h3{font-size:1.1rem;margin:1.2rem 0 .4rem;color:#cbd5e1}h4{font-size:1rem;margin:1rem 0 .3rem;color:#94a3b8}
p{margin:.5rem 0}ul{margin:.5rem 0 .5rem 1.5rem}li{margin:.2rem 0}
code{background:var(--surface);padding:.15rem .4rem;border-radius:4px;font-size:.9em;color:var(--accent)}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;margin:.8rem 0}pre code{background:none;padding:0;color:var(--text)}
strong{color:#f8fafc}.meta{color:var(--muted);font-size:.85rem;margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid var(--border)}
@media print{body{background:#fff;color:#1e293b}h1{color:#0891b2}code{color:#0891b2}pre{border-color:#e2e8f0}.meta{color:#64748b}}
</style></head><body>
<div class="meta"><strong>${title}</strong> &middot; ${type} report<br>Generated: ${new Date(createdAt).toLocaleString()}<br><em>Exported from GitNexus</em></div>
${body}
</body></html>`;
}

export const FileTreePanel = ({ onFocusNode }: FileTreePanelProps) => {
  const { graph, visibleLabels, toggleLabelVisibility, visibleEdgeTypes, toggleEdgeVisibility, selectedNode, setSelectedNode, openCodePanel, depthFilter, setDepthFilter, savedReports, deleteReport, setActiveReport, setRightPanelOpen } = useAppState();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'files' | 'filters' | 'reports'>('files');

  // Build file tree from graph
  const fileTree = useMemo(() => {
    if (!graph) return [];
    return buildFileTree(graph.nodes);
  }, [graph]);

  // Auto-expand first level on initial load
  useEffect(() => {
    if (fileTree.length > 0 && expandedPaths.size === 0) {
      const firstLevel = new Set(fileTree.map(n => n.path));
      setExpandedPaths(firstLevel);
    }
  }, [fileTree.length]); // Only run when tree first loads

  // Auto-expand to selected file when selectedNode changes (e.g., from graph click)
  useEffect(() => {
    const path = selectedNode?.properties?.filePath;
    if (!path) return;

    // Expand all parent folders leading to this file
    const parts = path.split('/').filter(Boolean);
    const pathsToExpand: string[] = [];
    let currentPath = '';

    // Build all parent paths (exclude the last part if it's a file)
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      pathsToExpand.push(currentPath);
    }

    if (pathsToExpand.length > 0) {
      setExpandedPaths(prev => {
        const next = new Set(prev);
        pathsToExpand.forEach(p => next.add(p));
        return next;
      });
    }
  }, [selectedNode?.id]); // Trigger when selected node changes

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((treeNode: TreeNode) => {
    if (treeNode.graphNode) {
      // Only focus if selecting a different node
      const isSameNode = selectedNode?.id === treeNode.graphNode.id;
      setSelectedNode(treeNode.graphNode);
      openCodePanel();
      if (!isSameNode) {
        onFocusNode(treeNode.graphNode.id);
      }
    }
  }, [setSelectedNode, openCodePanel, onFocusNode, selectedNode]);

  const selectedPath = selectedNode?.properties.filePath || null;

  if (isCollapsed) {
    return (
      <div className="h-full w-12 bg-surface border-r border-border-subtle flex flex-col items-center py-3 gap-2">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-hover rounded transition-colors"
          title="Expand Panel"
        >
          <PanelLeft className="w-5 h-5" />
        </button>
        <div className="w-6 h-px bg-border-subtle my-1" />
        <button
          onClick={() => { setIsCollapsed(false); setActiveTab('files'); }}
          className={`p-2 rounded transition-colors ${activeTab === 'files' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-hover'}`}
          title="File Explorer"
        >
          <Folder className="w-5 h-5" />
        </button>
        <button
          onClick={() => { setIsCollapsed(false); setActiveTab('filters'); }}
          className={`p-2 rounded transition-colors ${activeTab === 'filters' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-hover'}`}
          title="Filters"
        >
          <Filter className="w-5 h-5" />
        </button>
        <button
          onClick={() => { setIsCollapsed(false); setActiveTab('reports'); }}
          className={`p-2 rounded transition-colors ${activeTab === 'reports' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-hover'}`}
          title="Reports"
        >
          <FileText className="w-5 h-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full w-64 bg-surface border-r border-border-subtle flex flex-col animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('files')}
            className={`px-2 py-1 text-xs rounded transition-colors ${activeTab === 'files'
              ? 'bg-accent/20 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
          >
            Explorer
          </button>
          <button
            onClick={() => setActiveTab('filters')}
            className={`px-2 py-1 text-xs rounded transition-colors ${activeTab === 'filters'
              ? 'bg-accent/20 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
          >
            Filters
          </button>
          <button
            onClick={() => setActiveTab('reports')}
            className={`px-2 py-1 text-xs rounded transition-colors ${activeTab === 'reports'
              ? 'bg-accent/20 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
          >
            Reports
          </button>
        </div>
        <button
          onClick={() => setIsCollapsed(true)}
          className="p-1 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
          title="Collapse Panel"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {activeTab === 'files' && (
        <>
          {/* Search */}
          <div className="px-3 py-2 border-b border-border-subtle">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
              <input
                type="text"
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-elevated border border-border-subtle rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* File tree */}
          <div className="flex-1 overflow-y-auto scrollbar-thin py-2">
            {fileTree.length === 0 ? (
              <div className="px-3 py-4 text-center text-text-muted text-xs">
                No files loaded
              </div>
            ) : (
              fileTree.map(node => (
                <TreeItem
                  key={node.id}
                  node={node}
                  depth={0}
                  searchQuery={searchQuery}
                  onNodeClick={handleNodeClick}
                  expandedPaths={expandedPaths}
                  toggleExpanded={toggleExpanded}
                  selectedPath={selectedPath}
                />
              ))
            )}
          </div>
        </>
      )}

      {activeTab === 'filters' && (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
          <div className="mb-3">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Node Types
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Toggle visibility of node types in the graph
            </p>
          </div>

          <div className="flex flex-col gap-1">
            {FILTERABLE_LABELS.map((label) => {
              const Icon = getNodeTypeIcon(label);
              const isVisible = visibleLabels.includes(label);

              return (
                <button
                  key={label}
                  onClick={() => toggleLabelVisibility(label)}
                  className={`
                    flex items-center gap-2.5 px-2 py-1.5 rounded text-left transition-colors
                    ${isVisible
                      ? 'bg-elevated text-text-primary'
                      : 'text-text-muted hover:bg-hover hover:text-text-secondary'
                    }
                  `}
                >
                  <div
                    className={`w-5 h-5 rounded flex items-center justify-center ${isVisible ? '' : 'opacity-40'}`}
                    style={{ backgroundColor: `${NODE_COLORS[label]}20` }}
                  >
                    <Icon className="w-3 h-3" style={{ color: NODE_COLORS[label] }} />
                  </div>
                  <span className="text-xs flex-1">{label}</span>
                  <div
                    className={`w-2 h-2 rounded-full transition-colors ${isVisible ? 'bg-accent' : 'bg-border-subtle'}`}
                  />
                </button>
              );
            })}
          </div>

          {/* Edge Type Toggles */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Edge Types
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Toggle visibility of relationship types
            </p>

            <div className="flex flex-col gap-1">
              {ALL_EDGE_TYPES.map((edgeType) => {
                const info = EDGE_INFO[edgeType];
                const isVisible = visibleEdgeTypes.includes(edgeType);

                return (
                  <button
                    key={edgeType}
                    onClick={() => toggleEdgeVisibility(edgeType)}
                    className={`
                      flex items-center gap-2.5 px-2 py-1.5 rounded text-left transition-colors
                      ${isVisible
                        ? 'bg-elevated text-text-primary'
                        : 'text-text-muted hover:bg-hover hover:text-text-secondary'
                      }
                    `}
                  >
                    <div
                      className={`w-6 h-1.5 rounded-full ${isVisible ? '' : 'opacity-40'}`}
                      style={{ backgroundColor: info.color }}
                    />
                    <span className="text-xs flex-1">{info.label}</span>
                    <div
                      className={`w-2 h-2 rounded-full transition-colors ${isVisible ? 'bg-accent' : 'bg-border-subtle'}`}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Depth Filter */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              <Target className="w-3 h-3 inline mr-1.5" />
              Focus Depth
            </h3>
            <p className="text-[11px] text-text-muted mb-3">
              Show nodes within N hops of selection
            </p>

            <div className="flex flex-wrap gap-1.5">
              {[
                { value: null, label: 'All' },
                { value: 1, label: '1 hop' },
                { value: 2, label: '2 hops' },
                { value: 3, label: '3 hops' },
                { value: 5, label: '5 hops' },
              ].map(({ value, label }) => (
                <button
                  key={label}
                  onClick={() => setDepthFilter(value)}
                  className={`
                    px-2 py-1 text-xs rounded transition-colors
                    ${depthFilter === value
                      ? 'bg-accent text-white'
                      : 'bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
                    }
                  `}
                >
                  {label}
                </button>
              ))}
            </div>

            {depthFilter !== null && !selectedNode && (
              <p className="mt-2 text-[10px] text-amber-400">
                Select a node to apply depth filter
              </p>
            )}
          </div>

          {/* Legend */}
          <div className="mt-6 pt-4 border-t border-border-subtle">
            <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
              Color Legend
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {(['Folder', 'File', 'Class', 'Function', 'Interface', 'Method'] as NodeLabel[]).map(label => (
                <div key={label} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: NODE_COLORS[label] }}
                  />
                  <span className="text-[10px] text-text-muted">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'reports' && (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
          {savedReports.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <FileText className="w-10 h-10 text-text-muted mb-3 opacity-40" />
              <p className="text-xs text-text-muted">No reports yet.</p>
              <p className="text-[10px] text-text-muted mt-1">Use the chat to generate reports.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {([
                { type: 'health' as ReportType, label: 'Health Assessment', Icon: HeartPulse },
                { type: 'impact' as ReportType, label: 'Impact Analysis', Icon: Zap },
                { type: 'test-scenarios' as ReportType, label: 'Test Scenarios', Icon: TestTube2 },
                { type: 'refactoring' as ReportType, label: 'Refactoring Suggestions', Icon: Wrench },
                { type: 'fsd' as ReportType, label: 'Functional Specification', Icon: BookOpen },
                { type: 'tsd' as ReportType, label: 'Technical Specification', Icon: Code2 },
              ]).map(({ type, label, Icon }) => {
                const reports = savedReports.filter(r => r.type === type);
                if (!reports.length) return null;
                return (
                  <div key={type}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Icon className="w-3.5 h-3.5 text-text-muted" />
                      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</h3>
                    </div>
                    <div className="flex flex-col gap-1">
                      {reports.map(report => (
                        <div
                          key={report.id}
                          className="group flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors hover:bg-hover cursor-pointer"
                          onClick={() => { setActiveReport(report); setRightPanelOpen(true); }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-text-primary truncate">{report.title}</p>
                            <p className="text-[10px] text-text-muted">{new Date(report.createdAt).toLocaleDateString()}</p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const blob = new Blob([report.content], { type: 'text/markdown' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${report.title.replace(/[^a-zA-Z0-9-_ ]/g, '')}-${new Date(report.createdAt).toISOString().slice(0, 10)}.md`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="p-1 text-text-muted hover:text-accent opacity-0 group-hover:opacity-100 transition-all"
                            title="Download as Markdown"
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const html = reportToHTML(report.title, report.type, report.content, report.createdAt);
                              const blob = new Blob([html], { type: 'text/html' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${report.title.replace(/[^a-zA-Z0-9-_ ]/g, '')}-${new Date(report.createdAt).toISOString().slice(0, 10)}.html`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="p-1 text-text-muted hover:text-emerald-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Download as HTML"
                          >
                            <FileDown className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteReport(report.id); }}
                            className="p-1 text-text-muted hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Delete report"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Stats footer */}
      {graph && (
        <div className="px-3 py-2 border-t border-border-subtle bg-elevated/50">
          <div className="flex items-center justify-between text-[10px] text-text-muted">
            <span>{graph.nodes.length} nodes</span>
            <span>{graph.relationships.length} edges</span>
          </div>
        </div>
      )}
    </div>
  );
};

