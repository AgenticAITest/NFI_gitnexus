import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Send, Square, Sparkles, User,
  PanelRightClose, Loader2, AlertTriangle, GitBranch,
  HeartPulse, Zap, TestTube2, Save, ArrowLeft, Trash2, Check,
  Paperclip, X, Wrench, BookOpen, Code2, Search, Bot, CircleAlert,
  Network, LayoutDashboard, FileSearch, Route
} from 'lucide-react';
import type { AgentInitStep } from '../hooks/useAppState';
import { useAppState } from '../hooks/useAppState';
import { ToolCallCard } from './ToolCallCard';
import { isProviderConfigured } from '../core/llm/settings-service';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProcessesPanel } from './ProcessesPanel';
import { getEffectivePrompts, type ReportPrompt } from '../core/llm/report-prompts';

const INIT_STEPS = [
  { key: 'search', label: 'Search index', icon: Search },
  { key: 'agent', label: 'AI Agent', icon: Bot },
] as const;

/** Stepped progress indicator shown during agent initialization */
const AgentInitProgress = ({ step }: { step: NonNullable<AgentInitStep> }) => {
  // Determine the ordinal position of the current step
  const currentIdx = INIT_STEPS.findIndex(s => s.key === step.step);

  return (
    <div className="px-4 py-3 border-b border-border-subtle bg-surface/50">
      <div className="flex items-center gap-1">
        {INIT_STEPS.map((s, i) => {
          const Icon = s.icon;
          const isCurrent = s.key === step.step;
          const isPast = i < currentIdx;
          const isFuture = i > currentIdx;

          let statusIcon: React.ReactNode;
          let textColor: string;

          if (isPast || (isCurrent && step.status === 'done')) {
            statusIcon = <Check className="w-3 h-3 text-emerald-400" />;
            textColor = 'text-emerald-400';
          } else if (isCurrent && step.status === 'warn') {
            statusIcon = <CircleAlert className="w-3 h-3 text-amber-400" />;
            textColor = 'text-amber-400';
          } else if (isCurrent && step.status === 'active') {
            statusIcon = <Loader2 className="w-3 h-3 animate-spin text-accent" />;
            textColor = 'text-accent';
          } else {
            statusIcon = null;
            textColor = 'text-text-muted/50';
          }

          return (
            <div key={s.key} className="flex items-center gap-1">
              {i > 0 && (
                <div className={`w-4 h-px mx-0.5 ${isPast || (isCurrent && step.status !== 'active') ? 'bg-emerald-400/40' : 'bg-border-subtle'}`} />
              )}
              <div className={`flex items-center gap-1 text-[11px] ${textColor}`}>
                {statusIcon || <Icon className="w-3 h-3" />}
                <span>{s.label}</span>
                {isCurrent && step.status === 'warn' && 'detail' in step && (
                  <span className="text-[10px] text-amber-400/70">({step.detail})</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const RightPanel = () => {
  const {
    isRightPanelOpen,
    setRightPanelOpen,
    fileContents,
    graph,
    addCodeReference,
    // LLM / chat state
    chatMessages,
    isChatLoading,
    currentToolCalls,
    agentError,
    isAgentReady,
    agentInitStep,
    sendChatMessage,
    stopChatResponse,
    clearChat,
    // Reports
    savedReports,
    saveReport,
    activeReport,
    setActiveReport,
    // Settings (to refresh prompts on close)
    isSettingsPanelOpen,
  } = useAppState();

  const [chatInput, setChatInput] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'processes'>('chat');
  const [pendingReport, setPendingReport] = useState<ReportPrompt | null>(null);
  const [attachedFile, setAttachedFile] = useState<{ name: string; content: string } | null>(null);
  const [fileUploadStatus, setFileUploadStatus] = useState<'idle' | 'reading' | 'error'>('idle');
  // Re-read prompts from localStorage when settings panel closes (user may have edited them)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reportPrompts = useMemo(() => getEffectivePrompts(), [isSettingsPanelOpen]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages update or while streaming
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatLoading]);

  const resolveFilePathForUI = useCallback((requestedPath: string): string | null => {
    const req = requestedPath.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    if (!req) return null;

    // Exact match first (case-insensitive)
    for (const key of fileContents.keys()) {
      const norm = key.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
      if (norm === req) return key;
    }

    // Ends-with match (best for partial paths)
    let best: { path: string; score: number } | null = null;
    for (const key of fileContents.keys()) {
      const norm = key.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
      if (norm.endsWith(req)) {
        const score = 1000 - norm.length;
        if (!best || score > best.score) best = { path: key, score };
      }
    }
    return best?.path ?? null;
  }, [fileContents]);

  const findFileNodeIdForUI = useCallback((filePath: string): string | undefined => {
    if (!graph) return undefined;
    const target = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
    const node = graph.nodes.find(
      (n) => n.label === 'File' && n.properties.filePath.replace(/\\/g, '/').replace(/^\.?\//, '') === target
    );
    return node?.id;
  }, [graph]);

  const handleGroundingClick = useCallback((inner: string) => {
    const raw = inner.trim();
    if (!raw) return;

    let rawPath = raw;
    let startLine1: number | undefined;
    let endLine1: number | undefined;

    // Match line:num or line:num-num (supports both hyphen - and en dash –)
    const lineMatch = raw.match(/^(.*):(\d+)(?:[-–](\d+))?$/);
    if (lineMatch) {
      rawPath = lineMatch[1].trim();
      startLine1 = parseInt(lineMatch[2], 10);
      endLine1 = parseInt(lineMatch[3] || lineMatch[2], 10);
    }

    const resolvedPath = resolveFilePathForUI(rawPath);
    if (!resolvedPath) return;

    const nodeId = findFileNodeIdForUI(resolvedPath);

    addCodeReference({
      filePath: resolvedPath,
      startLine: startLine1 ? Math.max(0, startLine1 - 1) : undefined,
      endLine: endLine1 ? Math.max(0, endLine1 - 1) : (startLine1 ? Math.max(0, startLine1 - 1) : undefined),
      nodeId,
      label: 'File',
      name: resolvedPath.split('/').pop() ?? resolvedPath,
      source: 'ai',
    });
  }, [addCodeReference, findFileNodeIdForUI, resolveFilePathForUI]);

  // Handler for node grounding: [[Class:View]], [[Function:trigger]], etc.
  const handleNodeGroundingClick = useCallback((nodeTypeAndName: string) => {
    const raw = nodeTypeAndName.trim();
    if (!raw || !graph) return;

    // Parse Type:Name format
    const match = raw.match(/^(Class|Function|Method|Interface|File|Folder|Variable|Enum|Type|CodeElement):(.+)$/);
    if (!match) return;

    const [, nodeType, nodeName] = match;
    const trimmedName = nodeName.trim();

    // Find node in graph by type + name
    const node = graph.nodes.find(n =>
      n.label === nodeType &&
      n.properties.name === trimmedName
    );

    if (!node) {
      console.warn(`Node not found: ${nodeType}:${trimmedName}`);
      return;
    }

    // 1. Highlight in graph (add to AI citation highlights)
    // Note: This requires accessing the state setter from parent context
    // For now, we'll add to code references which triggers the highlight

    // 2. Add to Code Panel (if node has file/line info)
    if (node.properties.filePath) {
      const resolvedPath = resolveFilePathForUI(node.properties.filePath);
      if (resolvedPath) {
        addCodeReference({
          filePath: resolvedPath,
          startLine: node.properties.startLine ? node.properties.startLine - 1 : undefined,
          endLine: node.properties.endLine ? node.properties.endLine - 1 : undefined,
          nodeId: node.id,
          label: node.label,
          name: node.properties.name,
          source: 'ai',
        });
      }
    }
  }, [graph, resolveFilePathForUI, addCodeReference]);

  const handleLinkClick = useCallback((href: string) => {
    if (href.startsWith('code-ref:')) {
      const inner = decodeURIComponent(href.slice('code-ref:'.length));
      handleGroundingClick(inner);
    } else if (href.startsWith('node-ref:')) {
      const inner = decodeURIComponent(href.slice('node-ref:'.length));
      handleNodeGroundingClick(inner);
    }
  }, [handleGroundingClick, handleNodeGroundingClick]);



  // Auto-resize textarea as user types
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get accurate scrollHeight
    textarea.style.height = 'auto';
    // Set to scrollHeight, capped at max
    const maxHeight = 160; // ~6 lines
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    // Show scrollbar if content exceeds max
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Adjust height when input changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [chatInput, adjustTextareaHeight]);

  // File upload handler
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileUploadStatus('reading');

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      setAttachedFile({ name: file.name, content });
      setFileUploadStatus('idle');
    };
    reader.onerror = () => {
      setFileUploadStatus('error');
      setTimeout(() => setFileUploadStatus('idle'), 3000);
    };
    reader.readAsText(file);

    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, []);

  // Chat handlers
  const handleSendMessage = async () => {
    if (!chatInput.trim() && !attachedFile) return;

    let text = chatInput.trim();
    const reportMeta = pendingReport ? { type: pendingReport.type, title: pendingReport.title } as const : undefined;

    // Build the full message
    let fullMessage: string;
    if (pendingReport) {
      // Combine user input + attached file content
      let userInput = text;
      if (attachedFile) {
        userInput = `${userInput ? userInput + '\n\n' : ''}--- Attached: ${attachedFile.name} ---\n${attachedFile.content}`;
      }
      // Replace placeholder in the report prompt template
      fullMessage = pendingReport.prompt.replace('{{USER_INPUT}}', userInput);
    } else if (attachedFile) {
      // Regular chat with file attachment
      fullMessage = `${text ? text + '\n\n' : ''}--- Attached: ${attachedFile.name} ---\n${attachedFile.content}`;
    } else {
      fullMessage = text;
    }

    setChatInput('');
    setPendingReport(null);
    setAttachedFile(null);

    // Reset textarea height after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = '36px';
      textareaRef.current.style.overflowY = 'hidden';
    }
    await sendChatMessage(fullMessage, reportMeta);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleReportPrompt = useCallback((rp: ReportPrompt) => {
    if (rp.requiresInput) {
      // Set pending report and focus textarea
      setPendingReport(rp);
      setChatInput('');
      setAttachedFile(null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } else {
      // Fire immediately (e.g., Health Report)
      sendChatMessage(rp.prompt, { type: rp.type, title: rp.title });
    }
  }, [sendChatMessage]);

  const cancelPendingReport = useCallback(() => {
    setPendingReport(null);
    setChatInput('');
    setAttachedFile(null);
  }, []);

  const getReportIcon = (type: string) => {
    switch (type) {
      case 'health': return HeartPulse;
      case 'impact': return Zap;
      case 'test-scenarios': return TestTube2;
      case 'refactoring': return Wrench;
      case 'fsd': return BookOpen;
      case 'tsd': return Code2;
      case 'architecture': return Network;
      case 'overview': return LayoutDashboard;
      case 'key-files': return FileSearch;
      case 'api-handlers': return Route;
      default: return Sparkles;
    }
  };

  // Split report prompts into quick insights vs deep reports
  const quickInsightTypes = new Set(['architecture', 'overview', 'key-files', 'api-handlers']);
  const quickInsights = reportPrompts.filter(rp => quickInsightTypes.has(rp.type));
  const deepReports = reportPrompts.filter(rp => !quickInsightTypes.has(rp.type));

  if (!isRightPanelOpen) return null;

  return (
    <aside className="w-[40%] min-w-[400px] max-w-[600px] flex flex-col bg-deep border-l border-border-subtle animate-slide-in relative z-30 flex-shrink-0">
      {/* Header with Tabs */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border-subtle">
        <div className="flex items-center gap-1">
          {/* Chat Tab */}
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'chat'
              ? 'bg-accent/15 text-accent'
              : 'text-text-muted hover:text-text-primary hover:bg-hover'
              }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Chat with AI</span>
          </button>

          {/* Processes Tab */}
          <button
            onClick={() => setActiveTab('processes')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'processes'
              ? 'bg-accent/15 text-accent'
              : 'text-text-muted hover:text-text-primary hover:bg-hover'
              }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>Processes</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white rounded-full font-semibold">
              NEW
            </span>
          </button>
        </div>

        {/* Close button */}
        <button
          onClick={() => setRightPanelOpen(false)}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
          title="Close Panel"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Processes Tab */}
      {activeTab === 'processes' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <ProcessesPanel />
        </div>
      )}

      {/* Report Viewer - show when activeReport is set */}
      {activeTab === 'chat' && activeReport && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-elevated/50 border-b border-border-subtle">
            <button
              onClick={() => setActiveReport(null)}
              className="p-1 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
              title="Back to Chat"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-text-primary truncate">{activeReport.title}</h3>
              <p className="text-[10px] text-text-muted">
                {new Date(activeReport.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 scrollbar-thin chat-prose">
            <MarkdownRenderer content={activeReport.content} onLinkClick={handleLinkClick} showCopyButton={true} />
          </div>
        </div>
      )}

      {/* Chat Content - only show when chat tab is active and no report viewer */}
      {activeTab === 'chat' && !activeReport && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Status bar */}
          <div className="flex items-center gap-2.5 px-4 py-3 bg-elevated/50 border-b border-border-subtle">
            <div className="ml-auto flex items-center gap-2">
              {!isProviderConfigured() && (
                <span className="text-[11px] px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  Configure AI
                </span>
              )}
            </div>
          </div>

          {/* Stepped init progress */}
          {agentInitStep && <AgentInitProgress step={agentInitStep} />}

          {/* Status / errors */}
          {agentError && (
            <div className="px-4 py-3 bg-rose-500/10 border-b border-rose-500/30 text-rose-100 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{agentError}</span>
            </div>
          )}



          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
            {chatMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <div className="w-14 h-14 mb-4 flex items-center justify-center bg-gradient-to-br from-accent to-node-interface rounded-xl shadow-glow text-2xl">
                  🧠
                </div>
                <h3 className="text-base font-medium mb-2">
                  Ask me anything
                </h3>
                <p className="text-sm text-text-secondary leading-relaxed mb-5">
                  I can help you understand the architecture, find functions, or explain connections.
                </p>
                {/* Quick Insights */}
                <div className="w-full">
                  <p className="text-xs text-text-muted mb-3">Quick Insights</p>
                  <div className="grid grid-cols-2 gap-2 w-full">
                    {quickInsights.map((rp) => {
                      const Icon = getReportIcon(rp.type);
                      return (
                        <button
                          key={rp.type}
                          onClick={() => handleReportPrompt(rp)}
                          disabled={!isProviderConfigured()}
                          className="flex items-center gap-2.5 px-3 py-3 bg-elevated border border-border-subtle rounded-xl text-left hover:border-accent hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                        >
                          <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent/20 transition-colors shrink-0">
                            <Icon className="w-4 h-4" />
                          </div>
                          <span className="text-xs text-text-secondary group-hover:text-text-primary transition-colors leading-tight">{rp.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Deep Reports */}
                <div className="mt-4 pt-4 border-t border-border-subtle w-full">
                  <p className="text-xs text-text-muted mb-3">Deep Reports</p>
                  <div className="grid grid-cols-3 gap-2 w-full">
                    {deepReports.map((rp) => {
                      const Icon = getReportIcon(rp.type);
                      return (
                        <button
                          key={rp.type}
                          onClick={() => handleReportPrompt(rp)}
                          disabled={!isProviderConfigured()}
                          className="flex flex-col items-center gap-1.5 px-2 py-3 bg-elevated border border-border-subtle rounded-xl text-xs text-text-secondary hover:border-accent hover:text-text-primary hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Icon className="w-4 h-4" />
                          <span className="text-center text-[10px] leading-tight">{rp.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {chatMessages.map((message) => (
                  <div
                    key={message.id}
                    className="animate-fade-in"
                  >
                    {/* User message - compact label style */}
                    {message.role === 'user' && (
                      <div className="mb-4">
                        <div className="flex items-center gap-2 mb-2">
                          <User className="w-4 h-4 text-text-muted" />
                          <span className="text-xs font-medium text-text-muted uppercase tracking-wide">You</span>
                        </div>
                        <div className="pl-6 text-sm text-text-primary">
                          {message.reportMeta ? (
                            <div>
                              <span className="flex items-center gap-1.5">
                                {(() => { const Icon = getReportIcon(message.reportMeta.type); return <Icon className="w-3.5 h-3.5 text-accent" />; })()}
                                {message.reportMeta.title}
                              </span>
                              {/* Show user's input excerpt for reports that required input */}
                              {(() => {
                                const match = message.content.match(/--- USER'S PLANNED CHANGES ---\n([\s\S]*?)\n--- END ---/);
                                const match2 = message.content.match(/--- REQUIREMENTS \/ SPECIFICATION ---\n([\s\S]*?)\n--- END ---/);
                                const userInput = (match?.[1] || match2?.[1] || '').trim();
                                // Strip attached file content for display
                                const displayInput = userInput.split(/\n--- Attached: /)[0].trim();
                                if (!displayInput) return null;
                                return (
                                  <p className="mt-1 text-xs text-text-secondary line-clamp-3">{displayInput}</p>
                                );
                              })()}
                            </div>
                          ) : (
                            message.content
                          )}
                        </div>
                      </div>
                    )}

                    {/* Assistant message - copilot style */}
                    {message.role === 'assistant' && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <Sparkles className="w-4 h-4 text-accent" />
                          <span className="text-xs font-medium text-text-muted uppercase tracking-wide">Chat with AI</span>
                          {isChatLoading && message === chatMessages[chatMessages.length - 1] && (
                            <Loader2 className="w-3 h-3 animate-spin text-accent" />
                          )}
                        </div>
                        <div className="pl-6 chat-prose">
                          {/* Render steps in order (reasoning, tool calls, content interleaved) */}
                          {message.steps && message.steps.length > 0 ? (
                            <div className="space-y-4">
                              {message.steps.map((step, index) => (
                                <div key={step.id}>
                                  {step.type === 'reasoning' && step.content && (
                                    <div className="text-text-secondary text-sm italic border-l-2 border-text-muted/30 pl-3 mb-3">
                                      <MarkdownRenderer
                                        content={step.content}
                                        onLinkClick={handleLinkClick}
                                      />
                                    </div>
                                  )}
                                  {step.type === 'tool_call' && step.toolCall && (
                                    <div className="mb-3">
                                      <ToolCallCard toolCall={step.toolCall} defaultExpanded={false} />
                                    </div>
                                  )}
                                  {step.type === 'content' && step.content && (
                                    <MarkdownRenderer
                                      content={step.content}
                                      onLinkClick={handleLinkClick}
                                      showCopyButton={index === message.steps!.length - 1}
                                    />
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            // Fallback: render content + toolCalls separately (old format)
                            <MarkdownRenderer
                              content={message.content}
                              onLinkClick={handleLinkClick}
                              toolCalls={message.toolCalls}
                              showCopyButton={true}
                            />
                          )}
                        </div>
                        {/* Save to Reports button */}
                        {message.reportMeta && !isChatLoading && message.content && (
                          <div className="pl-6 mt-3">
                            {savedReports.some(r => r.messageId === message.id) ? (
                              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                                <Check className="w-3.5 h-3.5" />
                                Saved to Reports
                              </span>
                            ) : (
                              <button
                                onClick={() => saveReport(message.id, message.reportMeta!.type, message.reportMeta!.title)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent/15 text-accent border border-accent/30 rounded-lg hover:bg-accent/25 transition-colors"
                              >
                                <Save className="w-3.5 h-3.5" />
                                Save to Reports
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}


              </div>
            )}
            {/* Scroll anchor for auto-scroll */}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-3 bg-surface border-t border-border-subtle">
            {/* Pending report hint */}
            {pendingReport && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-accent/10 border border-accent/20 rounded-lg">
                {(() => { const Icon = getReportIcon(pendingReport.type); return <Icon className="w-3.5 h-3.5 text-accent shrink-0" />; })()}
                <span className="text-xs text-accent flex-1">{pendingReport.inputHint}</span>
                <button
                  onClick={cancelPendingReport}
                  className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* File upload status */}
            {fileUploadStatus === 'reading' && (
              <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-elevated border border-border-subtle rounded-lg">
                <Loader2 className="w-3 h-3 text-accent shrink-0 animate-spin" />
                <span className="text-xs text-text-muted">Reading file...</span>
              </div>
            )}
            {fileUploadStatus === 'error' && (
              <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-rose-500/10 border border-rose-500/30 rounded-lg">
                <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0" />
                <span className="text-xs text-rose-300">Failed to read file. Try a .txt or .md file.</span>
              </div>
            )}

            {/* Attached file chip */}
            {attachedFile && (
              <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="text-xs text-text-primary truncate flex-1">{attachedFile.name}</span>
                <span className="text-[10px] text-text-muted shrink-0">
                  {(attachedFile.content.length / 1024).toFixed(1)} KB
                </span>
                <button
                  onClick={() => setAttachedFile(null)}
                  className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                  title="Remove file"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.rst,.adoc"
              onChange={handleFileUpload}
              className="hidden"
            />

            <div className="flex items-end gap-2 px-3 py-2 bg-elevated border border-border-subtle rounded-xl transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
              <textarea
                ref={textareaRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={pendingReport?.inputPlaceholder ?? 'Ask about the codebase...'}
                rows={1}
                className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted resize-none min-h-[36px] scrollbar-thin"
                style={{ height: '36px', overflowY: 'hidden' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 text-text-muted hover:text-text-primary transition-colors"
                title="Attach file"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <button
                onClick={clearChat}
                className="px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
                title="Clear chat"
              >
                Clear
              </button>
              {isChatLoading ? (
                <button
                  onClick={stopChatResponse}
                  className="w-9 h-9 flex items-center justify-center bg-red-500/80 rounded-md text-white transition-all hover:bg-red-500"
                  title="Stop response"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  onClick={handleSendMessage}
                  disabled={!chatInput.trim() && !attachedFile && !pendingReport}
                  className="w-9 h-9 flex items-center justify-center bg-accent rounded-md text-white transition-all hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {!isProviderConfigured() && (
              <div className="mt-2 text-xs text-amber-200 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Configure an LLM provider to enable chat.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};



