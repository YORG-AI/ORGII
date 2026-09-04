/** Demo fixtures for Phase 0 mobile remote UI (no relay yet). */

export const DEMO_SAS_PHRASE = "amber-falcon-42";

export const DEMO_DESKTOP_NAME = "Home Mac";

export interface DemoSessionRow {
  id: string;
  name: string;
  status: "running" | "idle";
}

export const DEMO_SESSIONS: DemoSessionRow[] = [
  { id: "fix-auth-tests", name: "fix-auth-tests", status: "running" },
];

export const DEMO_PERMISSION_REQUEST = {
  requestId: "demo-permission-1",
  sessionId: "fix-auth-tests",
  toolName: "run_shell",
  toolArgs: {
    command: "pnpm test --filter auth",
  },
} as const;
