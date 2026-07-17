import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { SUBAGENT_PLAYGROUND_PRESETS, createEvent } from "../shared";

export const agentMessageEvents: Record<string, SessionEvent> = {
  agent_message: createEvent(
    "agent_message",
    {},
    {
      type: "assistant",
      content:
        "I've analyzed your codebase and found a few areas that could benefit from refactoring. The main issues are:\n\n1. **Duplicated logic** in the authentication hooks\n2. **Missing error boundaries** in several components\n3. **Inconsistent naming conventions** in the API layer\n\nWould you like me to start with any of these improvements?",
    },
    "message"
  ),

  thinking: createEvent(
    "thinking",
    {
      content:
        "The user wants to refactor the authentication system. Let me break this down:\n\n1. **Current state**: The auth logic is split across `useAuth.ts`, `AuthContext.tsx`, and `src/api/auth.ts`. There's significant duplication — both `useAuth` and `AuthContext` manage token refresh independently.\n\n2. **Key problems**:\n   - Token refresh race condition: if two components call `refreshToken()` simultaneously, we get duplicate refresh requests. Need a singleton promise pattern.\n   - The `login()` function in `AuthContext` directly calls the API instead of going through a service layer, making it hard to test.\n   - Session expiry handling is scattered — some components check `isTokenExpired()` inline, others rely on the axios interceptor.\n\n3. **Proposed approach**:\n   - Extract all token management into a dedicated `AuthService` class with a lock-based refresh mechanism.\n   - Consolidate the context to be a thin React wrapper around `AuthService`.\n   - Add a `useRequireAuth()` hook that redirects to login if the session is invalid, replacing the ad-hoc checks.\n\nLet me start by reading the existing files to confirm my understanding before proposing specific changes.",
    },
    {
      thought:
        "The user wants to refactor the authentication system. Let me break this down:\n\n1. **Current state**: The auth logic is split across `useAuth.ts`, `AuthContext.tsx`, and `src/api/auth.ts`. There's significant duplication — both `useAuth` and `AuthContext` manage token refresh independently.\n\n2. **Key problems**:\n   - Token refresh race condition: if two components call `refreshToken()` simultaneously, we get duplicate refresh requests. Need a singleton promise pattern.\n   - The `login()` function in `AuthContext` directly calls the API instead of going through a service layer, making it hard to test.\n   - Session expiry handling is scattered — some components check `isTokenExpired()` inline, others rely on the axios interceptor.\n\n3. **Proposed approach**:\n   - Extract all token management into a dedicated `AuthService` class with a lock-based refresh mechanism.\n   - Consolidate the context to be a thin React wrapper around `AuthService`.\n   - Add a `useRequireAuth()` hook that redirects to login if the session is invalid, replacing the ad-hoc checks.\n\nLet me start by reading the existing files to confirm my understanding before proposing specific changes.",
      duration: 12,
    },
    "thinking"
  ),

  user: createEvent(
    "user",
    {
      content: "Can you help me refactor the authentication system?",
    },
    {
      message: "Can you help me refactor the authentication system?",
      content: "Can you help me refactor the authentication system?",
    },
    "user"
  ),

  ask_user_questions: createEvent(
    "ask_user_questions",
    {
      title: "Repo Setup",
      questions: [
        {
          id: "db-choice",
          question:
            "We need to lock the primary datastore before scaffolding migrations and local dev containers. Which database should we standardize on for this codebase? Consider relational integrity for billing and user data, operational familiarity on the team, and a path to add vector search later without a second operational system if possible.",
          options: [
            {
              id: "pg",
              label:
                "PostgreSQL — team default for relational + JSONB, strong ecosystem",
              description:
                "ACID transactions, mature tooling, pgvector available when we need embeddings; matches staging/prod already on Postgres 16.",
            },
            {
              id: "mysql",
              label:
                "MySQL / MariaDB — widely hosted, familiar to many backends",
              description:
                "Good if we must match an existing host; slightly fewer extensions than Postgres for advanced JSON and vector workloads.",
            },
            {
              id: "mongo",
              label:
                "MongoDB — flexible document model, fast iteration on schemas",
              description:
                "Use when access patterns are document-heavy and relational joins are rare; ops cost is a separate conversation.",
            },
            {
              id: "sqlite",
              label: "SQLite — zero-config local and embedded deployments",
              description:
                "Fine for prototypes and single-node apps; not the long-term choice if we expect concurrent writers at scale.",
            },
          ],
        },
        {
          id: "features",
          question: "Features for v1?",
          allow_multiple: true,
          options: [
            { id: "auth", label: "Auth" },
            { id: "i18n", label: "i18n" },
            { id: "testing", label: "Tests" },
            { id: "ci", label: "CI" },
            { id: "docker", label: "Docker" },
          ],
        },
        {
          id: "style",
          question: "CSS approach?",
          options: [
            { id: "tailwind", label: "Tailwind" },
            { id: "css-modules", label: "CSS Modules" },
            { id: "styled", label: "Styled" },
          ],
        },
        {
          id: "ci-provider",
          question: "CI?",
          options: [
            { id: "gha", label: "GHA" },
            { id: "gitlab", label: "GitLab" },
            { id: "circle", label: "Circle" },
          ],
        },
      ],
    },
    {
      success: true,
      answers: [
        [
          "PostgreSQL. Strong relational guarantees for accounts and billing; team already runs it in staging; JSONB for flexible metadata and pgvector later if we add embeddings.",
        ],
        ["Auth", "Tests"],
        ["Tailwind"],
        [],
      ],
    }
  ),

  ask_user_permissions: createEvent(
    "ask_user_permissions",
    {
      tool_name: "execute_shell_command",
      description:
        "Run 'rm -rf node_modules && npm install' to clean and reinstall dependencies",
    },
    {
      pending: true,
      approved: null,
    },
    "ask_user_permissions"
  ),

  // Canonical `subagent` tool; DevTools uses SUBAGENT_PLAYGROUND_PRESETS for other states.
  // Index 1 is "completed" — index 0 is "starting" (no subagentSessionId).
  subagent: createEvent(
    "subagent",
    SUBAGENT_PLAYGROUND_PRESETS[1].args,
    SUBAGENT_PLAYGROUND_PRESETS[1].result,
    "tool_call",
    "completed"
  ),

  suggest_mode_switch: createEvent(
    "suggest_mode_switch",
    {
      target_mode: "plan",
      reason:
        "This task involves architectural changes that would benefit from planning first. There are multiple valid approaches with significant trade-offs, and we should align on the design before writing code.",
    },
    {},
    "tool_call",
    "running"
  ),
};
