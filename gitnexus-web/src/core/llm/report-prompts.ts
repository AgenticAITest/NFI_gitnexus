import type { ReportType } from './types';

const STORAGE_KEY = 'gitnexus-report-prompts';

export interface ReportPrompt {
  type: ReportType;
  label: string;
  title: string;
  /** If true, the button pre-fills textarea instead of sending immediately */
  requiresInput?: boolean;
  /** Placeholder text shown in textarea when this report is pending */
  inputPlaceholder?: string;
  /** Hint shown above the textarea */
  inputHint?: string;
  /** If true, show file upload option */
  acceptsFile?: boolean;
  /** The system prompt template. Use {{USER_INPUT}} where user input should go. */
  prompt: string;
}

export const REPORT_PROMPTS: ReportPrompt[] = [
  {
    type: 'health',
    label: 'Health Report',
    title: 'Generate Health Report',
    prompt: `Generate a comprehensive Health Assessment Report for this codebase.

Use the available tools (overview, cypher, impact) to analyze:

1. **Architecture Overview** — High-level structure, main modules, entry points. Include a mermaid diagram showing module dependencies.
2. **Code Quality Indicators** — Analyze coupling (files with most imports/importers), complexity hotspots (files defining many functions/methods), circular dependencies, orphan files (no incoming/outgoing edges), and dead code candidates.
3. **Risk Areas** — Identify the most coupled files (blast radius), files with highest fan-in (many callers), and single points of failure.
4. **Dependency Health** — Import patterns, layering violations, tight vs loose coupling zones.
5. **Summary Table** — A table with metrics: total files, functions, classes, avg coupling, max coupling, circular deps found.
6. **Recommendations** — Top 3-5 actionable improvements ranked by impact.

Format the report with clear markdown headings, mermaid diagrams where helpful, tables for metrics, and [[file.ts]] citations for every file you reference. Use [[Class:Name]] or [[Function:Name]] citations for specific symbols.`,
  },
  {
    type: 'impact',
    label: 'Impact Analysis',
    title: 'Generate Impact Analysis',
    requiresInput: true,
    inputPlaceholder: 'Describe the changes you want to analyze...',
    inputHint: 'Describe what you plan to change so the analysis is targeted to your needs.',
    prompt: `Generate a targeted Impact Analysis Report for this codebase, focused on the following planned changes:

--- USER'S PLANNED CHANGES ---
{{USER_INPUT}}
--- END ---

Use the available tools (impact, cypher, search) to analyze the impact of these specific changes:

1. **Change Scope** — Identify the specific files, functions, and classes that would be directly modified based on the user's description.
2. **Blast Radius** — For each affected symbol, run impact analysis to find all upstream dependents. Show direct callers (d=1, WILL BREAK), indirect deps (d=2, LIKELY AFFECTED), and transitive (d=3, MAY NEED TESTING).
3. **Critical Paths at Risk** — Execution flows that pass through the affected code. Include a mermaid flowchart.
4. **Safe vs Risky Changes** — Classify each proposed change as LOW/MEDIUM/HIGH/CRITICAL risk with reasoning.
5. **Required Updates** — List all files/symbols that MUST be updated alongside the change (d=1 dependents).
6. **Testing Recommendations** — What should be tested after these changes, ranked by priority.
7. **Migration Strategy** — Suggested order of changes to minimize breakage.

Format the report with clear markdown headings, mermaid diagrams, tables, and [[file.ts]] citations for every file referenced. Use [[Function:Name]] or [[Class:Name]] for specific symbols.`,
  },
  {
    type: 'test-scenarios',
    label: 'Test Scenarios',
    title: 'Generate Test Scenarios',
    requiresInput: true,
    inputPlaceholder: 'Paste your PRD/FSD requirements, or describe what needs testing...',
    inputHint: 'Paste a requirements document or describe the features to generate test scenarios for.',
    acceptsFile: true,
    prompt: `Generate a comprehensive Test Scenarios Report for this codebase, based on the following requirements:

--- REQUIREMENTS / SPECIFICATION ---
{{USER_INPUT}}
--- END ---

Use the available tools (search, cypher, read) to analyze the code against these requirements and generate:

1. **Requirements Mapping** — Map each requirement to the relevant code files, functions, and classes that implement it.
2. **Test Scenarios by Requirement** — For each requirement, generate:
   - **Happy path** scenarios (normal expected behavior)
   - **Edge cases** (boundary conditions, empty inputs, max values)
   - **Error handling** (what should happen when things fail)
   Format each scenario as: \`Scenario: [description]\` with Given/When/Then steps.
3. **Integration Test Priorities** — Cross-module interactions implied by the requirements, ranked by risk.
4. **Coverage Gaps** — Requirements or code paths that are hardest to test or most likely to have gaps.
5. **Test Architecture Recommendations** — Suggested test structure, mocking strategy, and test utilities needed.
6. **Priority Matrix** — A table ranking test scenarios by priority (P0-P3) with effort estimate (S/M/L).

Format with clear markdown headings, tables, and [[file.ts]] / [[Function:Name]] citations for every symbol referenced.`,
  },
  {
    type: 'refactoring',
    label: 'Refactoring Suggestions',
    title: 'Generate Refactoring Suggestions',
    prompt: `Generate a comprehensive Refactoring Suggestions Report for this codebase.

Use the available tools (overview, cypher, impact, search) to analyze code quality signals and produce actionable refactoring recommendations:

1. **Codebase Health Summary** — Quick overview of the current state: total files, functions, classes, and overall coupling metrics.

2. **God Classes / God Files** — Identify files or classes that do too much:
   - Files defining the most functions/methods (high definition count)
   - Classes with the most methods
   - Files with the most incoming + outgoing edges (high coupling)
   For each, explain WHY it's a problem and suggest how to split it.

3. **Circular Dependencies** — Find import cycles using the graph. For each cycle:
   - Show the cycle path (A -> B -> C -> A)
   - Explain which direction to break
   - Suggest the specific refactoring (extract interface, invert dependency, etc.)

4. **High Coupling Hotspots** — Files/modules with excessive bi-directional coupling:
   - Top 10 most-coupled file pairs
   - Suggest decoupling strategies (dependency injection, event bus, facade pattern)

5. **Dead Code Candidates** — Identify:
   - Files with no importers (orphan files)
   - Functions/methods with no callers
   - Classes never referenced
   Mark confidence level (HIGH/MEDIUM/LOW) based on graph evidence.

6. **Long Dependency Chains** — Find the longest transitive dependency paths that increase fragility. Suggest where to introduce boundaries.

7. **Naming & Structure Issues** — Flag:
   - Inconsistent naming conventions across modules
   - Files in wrong directories based on their relationships
   - Modules that should be merged or split based on coupling patterns

8. **Prioritized Refactoring Plan** — A table ranking each suggestion:
   | Priority | Category | Target | Issue | Suggestion | Effort | Risk |
   With P0 = must fix, P1 = should fix, P2 = nice to have.

9. **Quick Wins** — Top 3 refactorings that are low effort + high impact. These should be things a developer can do in under an hour.

Format the report with clear markdown headings, mermaid diagrams showing problematic dependency structures, tables for metrics, and [[file.ts]] citations for every file you reference. Use [[Class:Name]] or [[Function:Name]] citations for specific symbols.`,
  },
  {
    type: 'fsd',
    label: 'Functional Spec (FSD)',
    title: 'Generate Functional Specification',
    requiresInput: true,
    inputPlaceholder: 'Describe the app\'s purpose, target users, or business domain (optional)...',
    inputHint: 'Provide business context so the FSD reads naturally. Leave empty to generate from code only.',
    acceptsFile: true,
    prompt: `Generate a Functional Specification Document (FSD) for this codebase. This document is business-facing — it describes WHAT the system does, not how it's built.

--- BUSINESS CONTEXT (provided by user) ---
{{USER_INPUT}}
--- END ---

Use the available tools (overview, cypher, search, read) to analyze the codebase and produce the following sections:

1. **System Overview**
   - Purpose and description of the application (infer from code structure, naming, and any README/comments found)
   - Target users / stakeholders (infer from auth roles, user models, UI patterns)
   - If business context was provided above, incorporate it naturally

2. **Feature Inventory**
   - List every major feature/module (derived from clusters/communities)
   - For each feature: plain-English description of what it does from a user's perspective
   - Feature status: active, deprecated, or partially implemented (infer from code signals)

3. **User Workflows**
   - Key user journeys derived from execution flows/processes
   - For each workflow: step-by-step description of what the user does and what happens
   - Include a mermaid flowchart for each major workflow

4. **Screen Inventory** (for apps with a UI)
   - Detect UI components, pages, views, routes from the code
   - List each screen with:
     - Screen name and route/path
     - Purpose (what the user does on this screen)
     - Key elements: forms, tables, buttons, navigation links
     - Data displayed and user actions available
   - If no UI is detected, note "This appears to be a backend/library project — no screens detected"

5. **Screen Flow**
   - Navigation map between screens (derived from router config, navigation calls, link references)
   - Mermaid diagram showing screen-to-screen transitions
   - Entry points (which screens users land on first)

6. **Business Rules & Validation**
   - Read function bodies to extract conditional logic, validation rules, state machines
   - Format as: "Rule: [description]" with the condition and outcome
   - Cite the source: [[Function:name]] or [[file.ts:line]]
   - Group by feature/module

7. **Data Models**
   - Entity-relationship view (not code-level classes, but business entities)
   - For each entity: name, key fields, relationships to other entities
   - Include a mermaid ER diagram
   - Identify which entities are persisted vs transient

8. **Authentication & Permissions**
   - Auth mechanism (JWT, session, OAuth — infer from middleware/imports)
   - User roles and what each role can access
   - Permission checks and where they're enforced
   - If no auth detected, note "No authentication system detected"

9. **Error Handling (User Perspective)**
   - What error states can users encounter
   - How errors are communicated (error pages, toast messages, form validation)
   - Recovery paths (retry, redirect, fallback)

10. **Sections Not Derivable from Code**
    - Add placeholder sections with "[TO BE FILLED BY STAKEHOLDER]" for:
      - Non-functional requirements (performance, scalability, SLAs)
      - Deployment environments and infrastructure
      - Compliance and regulatory requirements
      - Future roadmap / planned features

Format as a professional specification document with:
- Clear markdown headings and numbered sections
- Mermaid diagrams for workflows, screen flows, and entity relationships
- Tables where appropriate
- [[file.ts]] and [[Function:Name]] citations linking back to source code
- Business-friendly language (avoid technical jargon where possible)`,
  },
  {
    type: 'tsd',
    label: 'Technical Spec (TSD)',
    title: 'Generate Technical Specification',
    requiresInput: true,
    inputPlaceholder: 'Any specific areas to focus on, or leave empty for full analysis...',
    inputHint: 'Optionally specify areas of focus (e.g., "focus on the API layer and database models").',
    prompt: `Generate a Technical Specification Document (TSD) for this codebase. This document is developer-facing — it describes HOW the system is built.

--- FOCUS AREAS (provided by user) ---
{{USER_INPUT}}
--- END ---

Use the available tools (overview, cypher, search, impact, read) to analyze the codebase and produce the following sections:

1. **Architecture Overview**
   - High-level architecture pattern (monolith, microservices, MVC, layered, event-driven, etc.)
   - Module/layer diagram showing major components and their relationships
   - Mermaid architecture diagram
   - Entry points (main files, server startup, CLI commands)

2. **Tech Stack & Dependencies**
   - Language(s) and runtime versions
   - Frameworks and libraries (with versions if detectable from package files)
   - External services and databases (inferred from imports and connection code)
   - Build tools, bundlers, test frameworks
   - Table format: | Category | Technology | Purpose |

3. **Module Structure**
   - Each cluster/community as a module
   - For each module:
     - Purpose and responsibility
     - Key files and their roles
     - Public API (exported functions, classes, interfaces)
     - Internal dependencies (what it imports)
     - External dependents (what imports it)
   - Mermaid diagram showing inter-module dependencies

4. **API Contracts**
   - All HTTP endpoints/routes with:
     - Method, path, handler function
     - Request parameters, body schema, headers
     - Response schema and status codes
     - Authentication requirements
   - Table format for quick reference
   - If no HTTP API, document the public programmatic API (exported functions/classes with signatures)

5. **Data Layer**
   - Database models / schemas (from ORM models, migration files, type definitions)
   - Data access patterns (repository pattern, direct queries, ORM)
   - Class/interface hierarchy with mermaid class diagram
   - Data flow: how data moves from input to storage and back

6. **Call Graphs & Dependency Chains**
   - Critical execution paths (from processes)
   - For the most important flows: step-by-step call chain with mermaid sequence diagram
   - Dependency depth analysis (longest chains)
   - Circular dependency report

7. **External Integrations**
   - Third-party APIs and services called
   - Message queues, caches, storage services
   - For each: how it's configured, where it's used, error handling approach
   - Mermaid diagram showing external system connections

8. **Configuration & Environment**
   - Environment variables used (names, purpose, defaults)
   - Configuration files and their structure
   - Feature flags or conditional behaviors
   - Table format: | Variable | Purpose | Default | Required |

9. **Error Handling & Logging**
   - Error handling strategy (try/catch patterns, error boundaries, middleware)
   - Custom error types and hierarchy
   - Logging approach (logger library, log levels, structured logging)
   - Monitoring hooks or health checks

10. **File & Folder Structure**
    - Directory tree with annotations explaining each folder's purpose
    - Naming conventions observed
    - Key files and their roles (entry points, config, shared utilities)

Format as a professional technical document with:
- Clear markdown headings and numbered sections
- Mermaid diagrams (architecture, class, sequence, flowchart) throughout
- Code snippets for key interfaces and type definitions
- Tables for structured data (APIs, config, dependencies)
- [[file.ts]] and [[Function:Name]] / [[Class:Name]] citations for every reference
- Developer-friendly language with precise technical terminology`,
  },
  // Quick insight reports (no input required)
  {
    type: 'architecture',
    label: 'Architecture Overview',
    title: 'Project Architecture',
    requiresInput: false,
    prompt: `You are a senior software architect producing a comprehensive architecture report for this codebase.

Use ALL available tools (overview, cypher, search, explore, read) to deeply understand the system before writing.

Your report MUST include:
1. **High-Level Architecture** — overall system design, major layers/tiers, and how they interact
2. **Architecture Diagram** — a mermaid flowchart or C4-style diagram showing the main components and their relationships
3. **Design Patterns** — patterns used (MVC, event-driven, pub/sub, repository, etc.) with concrete examples from the code
4. **Module Dependency Map** — a mermaid graph showing how major modules depend on each other
5. **Data Flow** — how data moves through the system from input to output, with a mermaid sequence or flowchart diagram
6. **Key Architectural Decisions** — notable design choices, trade-offs, and their implications
7. **Entry Points & Boundaries** — where the system starts, external interfaces, API boundaries

Format as a professional architecture document with:
- Clear markdown headings and numbered sections
- Mermaid diagrams (flowchart, graph, sequence) throughout — at least 2-3 diagrams
- [[file.ts]] and [[Function:Name]] / [[Class:Name]] citations for every reference
- Tables for structured data where appropriate`,
  },
  {
    type: 'overview',
    label: 'Project Overview',
    title: 'Project Overview',
    requiresInput: false,
    prompt: `You are a technical writer producing a comprehensive project overview report for this codebase.

Use ALL available tools (overview, cypher, search, explore, read) to deeply understand what this project does before writing.

Your report MUST include:
1. **What This Project Does** — purpose, problem it solves, target users
2. **Core Features** — enumerate all major features/capabilities with brief descriptions
3. **Technology Stack** — languages, frameworks, libraries, databases, and infrastructure
4. **Project Structure** — a mermaid diagram showing the folder/module organization
5. **How It Works** — end-to-end walkthrough of the primary user workflow, with a mermaid sequence diagram
6. **Configuration & Setup** — how the project is configured, key environment variables, build process
7. **Key Concepts** — domain-specific terms and concepts a new developer needs to understand

Format as a professional technical document with:
- Clear markdown headings and numbered sections
- Mermaid diagrams (flowchart, sequence) — at least 2 diagrams
- [[file.ts]] and [[Function:Name]] / [[Class:Name]] citations for every reference
- Tables for structured data where appropriate`,
  },
  {
    type: 'key-files',
    label: 'Key Files Analysis',
    title: 'Key Files Analysis',
    requiresInput: false,
    prompt: `You are a senior developer producing a report on the most important files in this codebase.

Use ALL available tools (overview, cypher, search, impact, explore) to identify the highest-impact files before writing.

Your report MUST include:
1. **Critical Files Summary** — table of the top 15-20 most important files ranked by connectivity/impact, with file path, purpose, and why it matters
2. **Dependency Graph** — a mermaid graph showing how the critical files relate to each other
3. **Entry Points** — files that serve as system entry points (main, index, CLI, routes, workers)
4. **Configuration Files** — key config files and what they control
5. **Shared Utilities & Core Libraries** — files that are imported by many others (high fan-out)
6. **Risk Hotspots** — files with the highest number of dependents (high fan-in) that are dangerous to modify
7. **Module Ownership Map** — a mermaid diagram showing which files belong to which functional area/cluster

Format as a professional technical document with:
- Clear markdown headings and numbered sections
- Mermaid diagrams — at least 2 diagrams
- [[file.ts]] citations for every file reference
- Tables for structured data (file lists, metrics)`,
  },
  {
    type: 'api-handlers',
    label: 'API Handlers Report',
    title: 'API Handlers & Endpoints',
    requiresInput: false,
    prompt: `You are a senior backend developer producing a comprehensive API handlers report for this codebase.

Use ALL available tools (overview, cypher, search, explore, read) to find every API handler, route, and endpoint before writing.

Your report MUST include:
1. **API Overview** — summary of the API surface area (REST, GraphQL, RPC, WebSocket, etc.)
2. **Endpoint Catalog** — table of ALL endpoints with: method, path/route, handler function, description, auth required
3. **Request Flow Diagram** — a mermaid sequence diagram showing the typical request lifecycle (middleware → handler → service → response)
4. **Route Organization** — a mermaid graph showing how routes are organized (by module, feature, resource)
5. **Middleware & Interceptors** — what middleware runs on requests (auth, validation, logging, error handling)
6. **Handler Patterns** — common patterns used across handlers, shared utilities, response formatting
7. **Authentication & Authorization** — how endpoints are protected, role-based access, token validation
8. **Error Handling** — how errors are caught and returned to clients

Format as a professional API documentation with:
- Clear markdown headings and numbered sections
- Mermaid diagrams (sequence, flowchart) — at least 2 diagrams
- [[file.ts]] and [[Function:Name]] citations for every reference
- Tables for the endpoint catalog and structured data`,
  },
];

/** Load custom prompt overrides from localStorage */
export function loadCustomPrompts(): Partial<Record<ReportType, string>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Save custom prompt overrides to localStorage */
export function saveCustomPrompts(overrides: Partial<Record<ReportType, string>>): void {
  // Only store non-default values
  const cleaned: Partial<Record<ReportType, string>> = {};
  for (const [type, prompt] of Object.entries(overrides)) {
    const defaultPrompt = REPORT_PROMPTS.find(rp => rp.type === type);
    if (defaultPrompt && prompt !== defaultPrompt.prompt) {
      cleaned[type as ReportType] = prompt;
    }
  }
  if (Object.keys(cleaned).length === 0) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  }
}

/** Get effective prompts (defaults merged with custom overrides) */
export function getEffectivePrompts(): ReportPrompt[] {
  const overrides = loadCustomPrompts();
  return REPORT_PROMPTS.map(rp => {
    const customPrompt = overrides[rp.type];
    if (customPrompt) {
      return { ...rp, prompt: customPrompt };
    }
    return rp;
  });
}
