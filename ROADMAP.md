# GitNexus Roadmap

> **Goal:** Transform GitNexus from a code intelligence tool into a full code forensics platform that lets a software consultant confidently take over maintenance of undocumented legacy apps.

> **Principle:** Build value features first (reports, analysis, documentation), infrastructure later (auth, dashboard).

---

## Current State (v1.4.0 — March 2026)

**What's built:**
- CLI: `gitnexus analyze`, `gitnexus serve`, `gitnexus mcp`, `gitnexus wiki`
- 11 language support with advanced symbol resolution (3-tier: exact FQN, scope-walk, fuzzy)
- KuzuDB graph database with community detection, process detection, confidence scoring
- Web UI: graph visualization (Sigma.js), chat (LangChain ReAct agent), processes panel, code references panel
- Multi-repo server with registry (`~/.gitnexus/registry.json`)
- 3 report types: Health Assessment, Impact Analysis, Test Scenarios
- Reports tab in left panel with save/view/delete
- File upload for attaching PRD/FSD documents to reports
- MCP server with 7 tools (query, context, impact, search, rename, detect_changes, cypher)
- Hybrid search (BM25 + vector embeddings via Transformers.js)
- Support for 6 LLM providers (OpenAI, Anthropic, Gemini, Ollama, OpenRouter, DeepSeek)

---

## Phase 1: Reports & Documentation (Current)

### 1.1 Reports System ~~DONE~~
- [x] Report types: Health, Impact Analysis, Test Scenarios
- [x] Reports tab in left panel (grouped by type, save/view/delete)
- [x] Report viewer mode in right panel (reuses MarkdownRenderer)
- [x] Quick-action buttons in chat empty state
- [x] Impact Analysis: user describes planned changes before generating
- [x] Test Scenarios: user uploads PRD/FSD or describes requirements
- [x] File upload button (paperclip) with loading/success/error states
- [x] Friendly display names in chat (not raw prompts)
- [x] localStorage persistence for saved reports (survive page refresh)
- [x] Download report as Markdown file

### 1.2 FSD & TSD Generation ~~DONE~~
Two separate report types for different audiences:

**Functional Specification (FSD)** — business-facing, describes WHAT:
- [x] System overview, feature inventory, user workflows
- [x] Screen inventory & screen flow (detects UI components, routes, navigation)
- [x] Business rules & validation logic (extracted from code)
- [x] Data models (entity-relationship level)
- [x] Auth & permissions model
- [x] Placeholder sections for non-derivable items (NFRs, compliance, roadmap)
- [x] Accepts optional business context from user + file upload

**Technical Specification (TSD)** — developer-facing, describes HOW:
- [x] Architecture overview with mermaid diagrams
- [x] Tech stack & dependencies table
- [x] Module structure with inter-module dependency diagrams
- [x] API contracts (endpoints, request/response schemas)
- [x] Data layer (ORM models, data access patterns, class hierarchy)
- [x] Call graphs & dependency chains with sequence diagrams
- [x] External integrations, configuration & environment variables
- [x] File/folder structure with annotations

### 1.3 Refactoring Suggestions Report ~~DONE~~
- [x] New report type: "Refactoring Suggestions"
- [x] Analyzes code quality signals from the graph: god classes/files, circular deps, high coupling, dead code, long dep chains, naming issues
- [x] Produces prioritized refactoring plan with effort estimates (P0/P1/P2)
- [x] Quick wins section (low effort, high impact)
- [x] Each suggestion links to specific files/symbols via citations

---

## Phase 2: Landing Page & Repo Management

### 2.1 Redesign Landing Page
The current DropZone is a one-time onboarding screen. Transform it into a persistent repo management dashboard.

- [x] Show list of existing indexed repos (from server registry) after connecting
- [x] Each repo card shows: name, path, file/node/edge/cluster counts
- [x] Click a repo card to open it (loads graph, switches to exploring view)
- [x] Single-repo servers skip the picker and load directly
- [x] Back button to return to repo list from loading state
- [x] Remember last-used server URL (already in localStorage)
- [x] "Add New Repository" button opens the current DropZone as a modal/section
- [x] Show repo health badge (computed from stats; full report-backed badge deferred to server-side storage)
- [x] Show last indexed date on cards

### 2.2 Multiple Repo Input Methods ~~DONE~~
- [x] ZIP upload (drag & drop)
- [x] Server connection (connect to running `gitnexus serve`)
- [x] GitHub URL with auth
  - [x] Remember GitHub PAT in localStorage (checkbox opt-in)
  - [x] Clone progress with progress bar
  - [x] Auto-index after clone completes
- [x] Local folder picker (File System Access API)
  - [x] `showDirectoryPicker()` in Chrome/Edge (tab hidden if unsupported)
  - [x] Reads files directly in browser, skips ignored paths and binaries
  - [x] Live file count during reading
  - [x] Server mode: POST path to server, server indexes and returns graph (`POST /api/index-path`)
- ~~GitLab / Bitbucket URL support~~ (not needed)

### 2.3 Repo Switching UX
- [x] Repo switcher dropdown in header (server mode)
- [x] Repo switcher works without server (for ZIP-uploaded repos, keep in memory)
- [x] "Re-index" button per repo (re-runs analysis, updates graph)
- [x] "Delete" repo from registry

---

## Phase 3: Server & Infrastructure

### 3.1 Nexus Server Enhancements
- [x] Multi-repo support via registry
- [x] KuzuDB connection pooling (max 5, auto-evict after 5 min)
- [x] Background indexing queue (index repos without blocking the API)
- [x] Webhook endpoint for CI/CD (auto-re-index on push)
- [x] WebSocket support for real-time indexing progress
- [x] Server health endpoint (`GET /api/health`)
- [x] Configurable CORS origins (`GITNEXUS_CORS_ORIGINS` env var or `--cors-origins` flag)
- [x] Rate limiting (200 req/min API, 10 req/min webhooks)

### 3.2 Authentication & Multi-User ~~DONE~~
- [x] Auth system (JWT-based, email/password)
- [x] First-run setup flow (first user becomes admin)
- [x] User roles: admin, user
- [x] Admin panel: add/delete/suspend users, reset passwords, toggle roles
- [x] Per-user repo access controls (grant/revoke per repo, bulk assign)
- [x] Repo filtering (users only see repos they have access to)
- [x] Audit log (login, user CRUD, repo access changes — filterable by user/action)
- [x] User settings synced to server (LLM provider config per user)
- [x] Token refresh with rotation (7-day refresh tokens)
- [x] Login page with setup/login modes
- [x] User menu in header (display name, logout)
- [x] Admin button in header (shield icon, admin-only)
- ~~SSO~~ (not needed for self-hosted)
- [ ] Shared reports (team can view saved reports) — deferred to Phase 4

### 3.3 Persistent Storage
- [x] localStorage persistence for saved reports
- [x] Server-side report storage (CRUD at `/api/reports`, stored in `.gitnexus/reports/`)
- [x] Report versioning (auto-increments on same type+title, version history via `/api/reports/versions/:type/:title`)
- [x] Export reports as HTML (server: `/api/reports/:id/html`, client: HTML download button alongside Markdown)

---

## Phase 4: UI Polish & UX

### 4.1 Graph Visualization
- [ ] Minimap for large graphs
- [ ] Cluster visualization mode (group nodes by community, collapsible)
- [ ] Edge bundling for high-density graphs
- [ ] Graph layout presets (force-directed, hierarchical, radial)
- [ ] "Focus mode" — click a node, see only its neighborhood (already has depth filter, but needs better UX)
- [ ] Node search from graph (not just header search)

### 4.2 Chat & Reports UX
- [ ] Report comparison view (side-by-side two reports)
- [ ] Report annotations (user can add notes to a saved report)
- [ ] Chat history persistence (localStorage or server)
- [ ] Prompt templates library (user can save custom prompts)
- [ ] "Ask about this file" — right-click a file in tree, opens chat with context
- [ ] Streaming progress indicator for long reports (show which tools are running)

### 4.3 Code Panel
- [ ] Syntax highlighting improvements (more languages)
- [ ] Inline diff view (show changes when doing impact analysis)
- [ ] "Open in editor" button (VS Code deep link)
- [ ] Multi-file view (tabs for multiple referenced files)

### 4.4 General UI
- [ ] Light theme option
- [ ] Responsive layout for smaller screens
- [ ] Keyboard shortcuts help panel
- [ ] Onboarding tour for first-time users
- [ ] Loading skeletons instead of spinners

---

## Phase 5: Advanced Analysis

### 5.1 Incremental Indexing
- [ ] Only re-index changed files (git diff based)
- [ ] Watch mode (auto-re-index on file save)
- [ ] Partial graph updates (add/remove nodes without full rebuild)

### 5.2 AST Decorator Detection
- [ ] Detect framework decorators (@Controller, @Get, @Injectable, @Component, etc.)
- [ ] Map decorators to framework concepts (routes, DI, lifecycle hooks)
- [ ] Framework-aware analysis (e.g., "show all API routes")

### 5.3 Cross-Repo Analysis
- [ ] Compare two repos (shared patterns, forked code, dependency overlap)
- [ ] Migration analysis (map old repo structure to new)
- [ ] "What changed between versions" (diff two indexes of same repo)

### 5.4 LLM Cluster Enrichment
- [ ] Use LLM to generate semantic cluster names (instead of algorithm-derived IDs)
- [ ] Cluster descriptions (what each module does, in plain English)
- [ ] Auto-generated architecture diagram from enriched clusters

---

## Priority Order

| Priority | Item | Effort | Value |
|----------|------|--------|-------|
| P0 | localStorage for reports | S | Prevents data loss |
| P0 | FSD generation report | M | Core value proposition |
| P1 | Landing page with existing repos | M | UX — currently one-shot onboarding |
| P1 | Local folder picker | S | Key input method for consultants |
| P1 | Refactoring suggestions report | M | Completes the report suite |
| P2 | GitHub PAT polish | S | Better onboarding for GitHub repos |
| P2 | Report export (Markdown download) | S | Users need to share reports with clients |
| P2 | Chat history persistence | S | Quality of life |
| P2 | Incremental indexing | L | Performance for large repos |
| P3 | Auth & multi-user | L | Only needed for team/SaaS use |
| P3 | Server-side report storage | M | Depends on auth |
| P3 | Cross-repo analysis | L | Advanced feature |
| P3 | Light theme | S | Nice to have |

**Effort:** S = hours, M = 1-2 days, L = 3+ days

---

## Non-Goals (For Now)

- **SaaS/hosted version** — focus on self-hosted CLI + local web UI first
- **Real-time collaboration** — single-user tool for now
- **IDE plugin** — MCP integration with Claude Code / Cursor is sufficient
- **Mobile UI** — desktop-first tool
- **Custom graph query builder UI** — Cypher via chat is good enough
