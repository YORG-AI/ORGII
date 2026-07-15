import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { MOCK_MANAGE_TODO_12_ITEMS, createEvent } from "../shared";

export const taskToolsEvents: Record<string, SessionEvent> = {
  manage_todo: createEvent(
    "manage_todo",
    {
      todos: [...MOCK_MANAGE_TODO_12_ITEMS],
    },
    {
      success: {
        todos: [...MOCK_MANAGE_TODO_12_ITEMS],
        wasMerge: true,
      },
    }
  ),

  inspect_terminals: createEvent(
    "inspect_terminals",
    {
      action: "list",
      include_output: true,
    },
    {
      success: true,
      terminals: [
        {
          id: "48291",
          cwd: "/Users/developer/Documents/GitHub/orgii_frontend",
          command: "npm run dev",
          status: "running",
          output: "VITE v6.2.0 ready in 418 ms\nLocal: http://localhost:5173/",
        },
        {
          id: "52107",
          cwd: "/Users/developer/Documents/GitHub/orgii_frontend/src-tauri",
          command: "cargo test -p agent-core",
          status: "completed",
          exit_code: 0,
          output: "test result: ok. 128 passed; 0 failed",
        },
      ],
    }
  ),

  org_send_message: createEvent(
    "org_send_message",
    {
      sender_member_id: "coordinator",
      recipient_member_id: "frontend_builder",
      kind: "task_assignment",
      title: "Wire Playground mock coverage",
      content:
        "Please add representative fixtures for the newly registered chat blocks so visual QA can exercise them without a live Agent Team run.",
    },
    {
      success: true,
      sender_member_id: "coordinator",
      content: JSON.stringify({
        delivered: [
          {
            inbox_id: 42,
            recipient_member_id: "frontend_builder",
            kind: "task_assignment",
            org_run_id: "org-run-preview-001",
          },
        ],
      }),
    }
  ),

  task_create: {
    ...createEvent(
      "task_create",
      {
        org_run_id: "org-run-preview-001",
        task: {
          id: "TASK-101",
          subject: "Add Playground fixtures for new event blocks",
          description:
            "Keep DevTools visual previews in sync with the unified event registry.",
          owner: "frontend_builder",
          status: "pending",
          priority: "high",
          blocks: ["TASK-099"],
        },
      },
      {
        success: true,
        task_id: "TASK-101",
      }
    ),
    extracted: {
      kind: "orgTask",
      outcome: "succeeded",
      action: "create",
      orgRunId: "org-run-preview-001",
      taskAssignedDispatched: true,
      task: {
        id: "TASK-101",
        subject: "Add Playground fixtures for new event blocks",
        description:
          "Keep DevTools visual previews in sync with the unified event registry.",
        owner: "frontend_builder",
        ownerName: "Frontend Builder",
        status: "pending",
        priority: "high",
        blocks: ["TASK-099"],
        blockedBy: [],
      },
    },
  },

  task_update: {
    ...createEvent(
      "task_update",
      {
        org_run_id: "org-run-preview-001",
        task_id: "TASK-101",
        status: "in_progress",
        owner: "qa_reviewer",
      },
      {
        success: true,
        updated_fields: ["status", "owner"],
      }
    ),
    extracted: {
      kind: "orgTask",
      outcome: "succeeded",
      action: "update",
      orgRunId: "org-run-preview-001",
      ownerChanged: true,
      statusChanged: true,
      task: {
        id: "TASK-101",
        subject: "Add Playground fixtures for new event blocks",
        description:
          "Fixture coverage is now in progress and ready for QA handoff.",
        owner: "qa_reviewer",
        ownerName: "QA Reviewer",
        status: "in_progress",
        priority: "high",
        blocks: [],
        blockedBy: ["TASK-099"],
      },
    },
  },

  task_list: {
    ...createEvent(
      "task_list",
      {
        org_run_id: "org-run-preview-001",
        status: "open",
      },
      {
        success: true,
        total: 3,
      }
    ),
    extracted: {
      kind: "orgTask",
      outcome: "succeeded",
      action: "list",
      orgRunId: "org-run-preview-001",
      total: 3,
      tasks: [
        {
          id: "TASK-101",
          subject: "Add Playground fixtures for new event blocks",
          status: "in_progress",
          owner: "qa_reviewer",
          ownerName: "QA Reviewer",
          priority: "high",
          blocks: [],
          blockedBy: ["TASK-099"],
        },
        {
          id: "TASK-102",
          subject: "Verify registry sync warning stays quiet",
          status: "pending",
          owner: "frontend_builder",
          ownerName: "Frontend Builder",
          priority: "medium",
          blocks: [],
          blockedBy: [],
        },
        {
          id: "TASK-103",
          subject: "Capture screenshots for release notes",
          status: "completed",
          owner: "docs_writer",
          ownerName: "Docs Writer",
          priority: "low",
          blocks: [],
          blockedBy: [],
        },
      ],
    },
  },

  task_get: {
    ...createEvent(
      "task_get",
      {
        org_run_id: "org-run-preview-001",
        task_id: "TASK-101",
      },
      {
        success: true,
        task_id: "TASK-101",
      }
    ),
    extracted: {
      kind: "orgTask",
      outcome: "succeeded",
      action: "get",
      orgRunId: "org-run-preview-001",
      total: 1,
      task: {
        id: "TASK-101",
        subject: "Add Playground fixtures for new event blocks",
        description:
          "The task detail view should include assignment, priority, status, and dependency metadata.",
        status: "in_progress",
        owner: "qa_reviewer",
        ownerName: "QA Reviewer",
        priority: "high",
        blocks: [],
        blockedBy: ["TASK-099"],
      },
    },
  },

  setup_repo: createEvent(
    "setup_repo",
    {
      action: "clone",
      repo_url: "https://github.com/orgii-labs/playground-demo",
      target_dir: "/Users/developer/Documents/GitHub/playground-demo",
    },
    {
      success: true,
      path: "/Users/developer/Documents/GitHub/playground-demo",
      branch: "main",
      content: [
        "Repository cloned successfully.",
        "Dependencies detected: npm workspace",
        "Next step: run `npm install` and launch the app preview.",
      ].join("\n"),
    }
  ),

  rate_limit_hint: createEvent(
    "rate_limit_hint",
    {},
    {
      observation: "rate_limit_hint",
    },
    "rate_limit_hint",
    "completed"
  ),

  plan_approval: createEvent(
    "plan_approval",
    {
      title: "Playground registry sync plan",
      content: [
        "## Goal",
        "Add mock fixtures for every event type registered in `COMPONENT_LOADERS`.",
        "",
        "## Steps",
        "1. Add representative raw args/results for fallback blocks.",
        "2. Include extracted task payloads for Agent Team task cards.",
        "3. Verify the dev-mode sync warning no longer appears.",
      ].join("\n"),
      planId: "plan-playground-sync",
      planRevisionId: "plan-rev-playground-sync-001",
    },
    {
      status: "pending",
      planId: "plan-playground-sync",
      planRevisionId: "plan-rev-playground-sync-001",
    },
    "plan_approval",
    "completed"
  ),

  mcp_tool: createEvent(
    "query_database",
    {
      server: "postgres-mcp",
      query:
        "SELECT id, name, email FROM users WHERE active = true ORDER BY created_at DESC LIMIT 10",
      database: "production",
    },
    {
      success: true,
      rows: [
        { id: 1, name: "Alice Chen", email: "alice@example.com" },
        { id: 2, name: "Bob Martinez", email: "bob@example.com" },
        { id: 3, name: "Carol Wu", email: "carol@example.com" },
      ],
      row_count: 3,
      execution_time_ms: 42,
    }
  ),

  manage_story: createEvent(
    "manage_story",
    {
      action: "list",
    },
    {
      content: [
        "- **Chat panel visual polish** (slug: chat-panel-visual-polish) — in_progress · high",
        "- **Agent team onboarding** (slug: agent-org-onboarding) — planned · medium",
        "- **Work item scheduling** (slug: work-item-scheduling) — backlog · medium",
        "- **Marketplace source selector** (slug: marketplace-source-selector) — in_review · high",
        "- **Key Vault cleanup** (slug: key-vault-cleanup) — completed · low",
        "- **Simulator replay parity** (slug: simulator-replay-parity) — planned · high",
        "- **Project manager QA** (slug: project-manager-qa) — backlog · medium",
      ].join("\n"),
    }
  ),

  manage_work_item: createEvent(
    "manage_work_item",
    {
      action: "list_items",
      project_slug: "chat-panel-visual-polish",
    },
    {
      content: [
        "- **Unify project list row style** [CP-101] — completed · high · @frontend",
        "- **Add CRUD trailing indicators** [CP-102] — in_review · high · @frontend",
        "- **Update Built-in Tool Playground fixtures** [CP-103] — in_progress · medium · @frontend",
        "- **Verify simulator replay icons** [CP-104] — planned · medium · @qa",
        "- **Remove legacy action-specific icons** [CP-105] — completed · high · @frontend",
        "- **Document list row rendering contract** [CP-106] — backlog · low · @docs",
        "- **Run visual regression pass** [CP-107] — planned · medium · @qa",
      ].join("\n"),
    }
  ),

  worktree: createEvent(
    "worktree",
    {
      action: "add",
      branch: "feature/auth-refactor",
      base_ref: "main",
    },
    {
      success: true,
      reused: false,
      branch: "feature/auth-refactor",
      path: "/Users/developer/Documents/GitHub/orgii_frontend/.orgii/worktrees/feature/auth-refactor",
      base: "main",
      content: [
        "Created worktree at `/Users/developer/Documents/GitHub/orgii_frontend/.orgii/worktrees/feature/auth-refactor`",
        "Branch: `feature/auth-refactor`",
        "Base: `main`",
        "",
        "All file operations now target this worktree. Use `leave` to return.",
      ].join("\n"),
    }
  ),

  turn_summary: createEvent(
    "turn_summary",
    { toolCalls: 16, wallTimeSecs: 68 },
    {
      observation: `Completed the auth refactor. Key changes:

- Extracted token refresh into \`AuthService\` with a singleton-promise lock to eliminate race conditions.
- Consolidated \`useAuth\` and \`AuthContext\` — the hook is now a thin wrapper around the service.
- Added \`useRequireAuth()\` that redirects to \`/login\` on session expiry, replacing 7 ad-hoc inline checks.
- Updated axios interceptor to call \`AuthService.refresh()\` directly (no more duplicate requests).

All 42 existing auth integration tests pass. TypeScript clean.`,
    },
    "tool_call",
    "completed"
  ),

  // Single shell wait_for — build succeeded, pattern matched, exit 0.
  // Renders as TitleOnly: "Waited for 1 terminal process" header only.
  await_output: createEvent(
    "await_output",
    {
      command: "wait_for",
      handles: ["48291"],
      pattern: "Build succeeded|error\\[",
      block_until_ms: 90000,
      tail_lines: 50,
    },
    {
      output:
        '[48291: succeeded]\nawaitMeta::{"count":1,"items":[{"handle":"48291","jobKind":"shell","status":"succeeded","exitCode":0,"patternMatched":true,"matchLine":"Build succeeded"}]}\n--- [48291] last 50 lines ---\nCompiling orgii-app v0.1.0\n    Checking agent_core v0.1.0\n    Finished dev profile [unoptimized + debuginfo] target(s) in 42.8s\nBuild succeeded',
    }
  ),

  // Single subagent monitor — agent peeks at a delegate that finished.
  // Renders as TitleOnly: "Checked 1 Subagent" header only.
  await_output_subagent: createEvent(
    "await_output",
    {
      command: "monitor",
      handles: ["agent-builtin:explore-abc123"],
      tail_lines: 50,
    },
    {
      output:
        '[agent-builtin:explore-abc123: succeeded]\nawaitMeta::{"count":1,"items":[{"handle":"agent-builtin:explore-abc123","jobKind":"subagent","status":"succeeded","exitCode":0}]}\n--- [agent-builtin:explore-abc123] last 50 lines ---\nSubagent finished. Found 7 matching files across 3 feature areas.\n\nsrc/modules/MainApp/Integrations/index.tsx\nsrc/features/auth/KeyVaultWizard.tsx\nsrc/features/session/SessionCreator.tsx',
    }
  ),

  // Multi-handle monitor — shell + subagent together. Exercises the
  // "N terminal processes, M Subagents" summary branch in i18n.
  await_output_multi: createEvent(
    "await_output",
    {
      command: "monitor",
      handles: ["48291", "agent-builtin:explore-abc123", "52107"],
      tail_lines: 20,
    },
    {
      output:
        '[48291: running] [agent-builtin:explore-abc123: succeeded] [52107: failed]\nawaitMeta::{"count":3,"items":[{"handle":"48291","jobKind":"shell","status":"running","waitedMs":0},{"handle":"agent-builtin:explore-abc123","jobKind":"subagent","status":"succeeded","exitCode":0},{"handle":"52107","jobKind":"shell","status":"failed","exitCode":1}]}\n--- [48291] last 20 lines ---\n[webpack] compiling...\n--- [agent-builtin:explore-abc123] last 20 lines ---\nSubagent finished. Found 7 matching files.\n--- [52107] last 20 lines ---\nerror[E0308]: mismatched types\n  --> src/lib.rs:42:5',
    }
  ),

  // Listing — renders as ToolCallBlock with stack list of jobs (mirrors
  // manage_workspace > list).
  await_output_list: createEvent(
    "await_output",
    {
      command: "list",
    },
    {
      output:
        '[background jobs]\nawaitMeta::{"command":"list","status":"succeeded","count":3,"items":[{"handle":"48291","kind":"shell","status":"running","ageMs":42800,"label":"npm run dev"},{"handle":"agent-builtin:explore-abc123","kind":"subagent","status":"succeeded","ageMs":15200,"label":"Explorer"},{"handle":"52107","kind":"shell","status":"failed","ageMs":8100,"label":"cargo test"}]}\nHANDLE          KIND              STATUS      AGE       LABEL\n48291           shell             running     42s       npm run dev\nagent-builtin:explore-abc123 subagent         succeeded  15s       Explorer\n52107           shell             failed      8s        cargo test',
    }
  ),

  tool_call: createEvent(
    "custom_internal_tool",
    {
      action: "process",
      input: "raw-data-payload",
      options: { format: "json", verbose: true },
    },
    {
      success: true,
      output: "Processed 128 records in 0.3s",
    }
  ),
};
