// ============================================
// Session stage types
// ============================================
//
// The visual workflow editor's Action* types that used to live here were
// removed together with the unreachable editor cluster (Phase 1 of the
// Orgtrack PM protocol migration). SESSION_STAGES survives because the
// realtime websocket layer re-exports it as the canonical stage-name enum.

export interface StageTransition {
  type: "unconditional" | "conditional";
  targetStage: SessionStage;
  condition?: {
    field: string;
    operator:
      | "equals"
      | "not-equals"
      | "contains"
      | "is-empty"
      | "is-not-empty";
    value?: unknown;
  };
  label?: string;
}

export const SESSION_STAGES = {
  INTAKE: "intake",
  SPEC: "spec",
  PLANNING: "planning",
  EXECUTION: "execution",
  REVIEW: "review",
  MERGE: "merge",
} as const;

export type SessionStage = (typeof SESSION_STAGES)[keyof typeof SESSION_STAGES];

export const SESSION_STAGE_OPTIONS = [
  { label: "Intake", value: SESSION_STAGES.INTAKE },
  { label: "Specification", value: SESSION_STAGES.SPEC },
  { label: "Planning", value: SESSION_STAGES.PLANNING },
  { label: "Execution", value: SESSION_STAGES.EXECUTION },
  { label: "Review", value: SESSION_STAGES.REVIEW },
  { label: "Merge", value: SESSION_STAGES.MERGE },
];
