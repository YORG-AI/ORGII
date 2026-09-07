/**
 * SessionReplayProject Configuration
 *
 * Registry configuration for the Project Manager simulator app.
 * Uses Rust registry (getAppTypeForTool) as single source of truth for event matching.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getAppTypeForTool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { defineSimulatorAppConfig } from "@src/engines/Simulator/apps/core/configFactory";
import type {
  ProjectOperation,
  SimulatorProjectState,
} from "@src/engines/Simulator/apps/core/sessionReplayTypes";
import { AppType } from "@src/engines/Simulator/types/appTypes";

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function extractAction(
  params: Record<string, unknown> | undefined
): string | undefined {
  if (!params) return undefined;
  return (params.action as string) ?? (params.operation as string) ?? undefined;
}

function extractProjectOp(
  event: SessionEvent,
  isCurrent: boolean
): ProjectOperation | null {
  if (getAppTypeForTool(event.functionName) !== AppType.STORY_MANAGER) {
    return null;
  }

  const params = normalizeArgs(event.args);
  const result = event.result as Record<string, unknown> | string | undefined;
  const isError =
    typeof result === "string"
      ? result.toLowerCase().includes("error")
      : Boolean(result && (result as Record<string, unknown>).error);

  const action = extractAction(params);

  let resultText = "";
  if (typeof result === "string") {
    resultText = result;
  } else if (result && typeof result === "object") {
    const observation = result.observation as string | undefined;
    const summary = result.summary as string | undefined;
    const output = result.output as string | undefined;
    const content = result.content as string | undefined;
    resultText =
      observation ?? summary ?? output ?? content ?? JSON.stringify(result);
  }
  const resultSummary = resultText.slice(0, 300);

  return {
    eventId: event.id,
    timestamp: new Date(event.createdAt).getTime(),
    type: "project",
    functionName: event.functionName,
    action,
    args: params,
    resultText,
    projectName:
      (params.project_name as string) ?? (params.name as string) ?? undefined,
    workItemTitle:
      (params.title as string) ?? (params.item_title as string) ?? undefined,
    resultSummary,
    isError,
    isCurrent,
  };
}

export function deriveProjectState(
  events: SessionEvent[],
  currentEventId: string | null
): Omit<
  SimulatorProjectState,
  keyof import("@src/engines/Simulator/apps/core/types").SimulatorAppBaseState
> {
  const operations: ProjectOperation[] = [];

  for (const event of events) {
    const isCurrent = event.id === currentEventId;
    const op = extractProjectOp(event, isCurrent);
    if (!op) continue;
    operations.push(op);
  }

  const selectedOperation =
    operations.find((op) => op.eventId === currentEventId) ??
    operations[operations.length - 1] ??
    null;

  return { operations, selectedOperation };
}

/**
 * Project Manager simulator app config.
 * Uses Rust registry for event matching.
 */
export const STORY_APP_CONFIG = defineSimulatorAppConfig<SimulatorProjectState>(
  {
    appType: AppType.STORY_MANAGER,
    name: "Project Manager",
    icon: "LayoutList",
    deriveState: deriveProjectState,
  }
);
