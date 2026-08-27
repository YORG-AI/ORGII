/**
 * SimulatorPreview
 *
 * Per-tool manual rendering for the DevTools playground.
 *
 * The real simulator apps (SessionReplayIDE, SessionReplayMessages, etc.)
 * depend on Jotai session atoms (simulatorEventsAtom, currentEventAtom, etc.)
 * that are only populated inside a live session context. The playground has
 * no session, so we render lightweight standalone views per AppType:
 *
 *   CODE_EDITOR → CodePanel only (no replay sidebar)
 *   CHANNELS    → MessageViewer with a single constructed MessageEntry
 *   BROWSER     → URL / screenshot placeholder
 *   Others      → Descriptive placeholder
 */
import { useEffect, useMemo, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { getAppTypeForEventSafe } from "@src/engines/Simulator/utils/eventToDockMapping";
import MessageViewer from "@src/modules/WorkStation/Chat/Communication/MessageViewer";
import type { MessageViewMode } from "@src/modules/WorkStation/Chat/Communication/types";
import { convertToMessageEntry } from "@src/modules/WorkStation/Chat/Communication/utils";
import { CodePanel } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel";
import type { FileOperationEntry } from "@src/modules/WorkStation/CodeEditor/SessionReplay/types";
import { SimulatorProject } from "@src/modules/WorkStation/ProjectManager/SessionReplay";
import { STORY_APP_CONFIG } from "@src/modules/WorkStation/ProjectManager/SessionReplay/config";

import { PlaygroundPreviewShell } from "../panels";
import {
  buildFileOperationsFromEvent,
  eventToExploreOperation,
  eventToShellOperation,
  getOperationType,
} from "../shared";

const SIMULATOR_PREVIEW_CONTENT_CLASS =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

// ============================================
// CODE_EDITOR preview (file / shell / search)
// ============================================

function CodeEditorPreview({
  event,
  isLoading,
}: {
  event: SessionEvent;
  isLoading: boolean;
}) {
  const operationType = useMemo(
    () => getOperationType(event.functionName),
    [event.functionName]
  );

  const [fileOperationsBase, setFileOperationsBase] = useState<
    FileOperationEntry[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    if (operationType !== "file") {
      queueMicrotask(() => {
        if (!cancelled) setFileOperationsBase([]);
      });
    } else {
      buildFileOperationsFromEvent(event).then((ops) => {
        if (!cancelled) setFileOperationsBase(ops);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [event, operationType]);

  const fileOperation = useMemo(
    () => fileOperationsBase[0] ?? null,
    [fileOperationsBase]
  );

  const shellOperation = useMemo(() => {
    if (operationType !== "shell") return null;
    return eventToShellOperation(event);
  }, [event, operationType]);

  const exploreOperation = useMemo(() => {
    if (operationType !== "explore") return null;
    return eventToExploreOperation(event);
  }, [event, operationType]);

  const codePanelMode = useMemo(() => {
    if (operationType === "shell") return "terminal" as const;
    if (operationType === "explore") return "explore" as const;
    return "file" as const;
  }, [operationType]);

  return (
    <div
      className={`session-replay-ide tool-event-preview-human-shell ${SIMULATOR_PREVIEW_CONTENT_CLASS}`}
    >
      <div className="ide-code-panel allow-select-deep min-h-0 flex-1 overflow-hidden">
        <CodePanel
          operation={fileOperation}
          exploreOperation={exploreOperation}
          shellOperation={shellOperation}
          mode={codePanelMode}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

// ============================================
// CHANNELS preview (messages / thinking / ask_user / user)
// ============================================

function resolveChannelsViewMode(functionName: string): MessageViewMode {
  if (functionName === "thinking") return "think";
  if (functionName === "manage_todo") return "todo";
  return "think";
}

function ChannelsPreview({ event }: { event: SessionEvent }) {
  const viewMode = useMemo(
    () => resolveChannelsViewMode(event.functionName),
    [event.functionName]
  );

  const messages = useMemo(() => {
    const messageEntry = convertToMessageEntry(event, viewMode, false);
    return [messageEntry];
  }, [event, viewMode]);

  return (
    <div
      className={`session-replay-messages tool-event-preview-human-shell ${SIMULATOR_PREVIEW_CONTENT_CLASS}`}
    >
      <MessageViewer messages={messages} viewMode={viewMode} />
    </div>
  );
}

// ============================================
// BROWSER preview (web_search / web_fetch / browser control)
// ============================================

function BrowserPreview({ event }: { event: SessionEvent }) {
  const args = event.args;
  const url =
    (args?.url as string) ||
    (args?.search_term as string) ||
    (args?.query as string) ||
    "";

  return (
    <div
      className={`session-replay-browser tool-event-preview-human-shell ${SIMULATOR_PREVIEW_CONTENT_CLASS}`}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <Placeholder
          variant="empty"
          placement="detail-panel"
          fillParentHeight
          title={`Browser — ${url || event.functionName}`}
        />
      </div>
    </div>
  );
}

function ProjectManagerPreview({ event }: { event: SessionEvent }) {
  const state = useMemo(
    () => ({
      currentEventId: event.id,
      appEvents: [event],
      selectedItemId: event.id,
      isReplaying: true,
      ...STORY_APP_CONFIG.deriveState([event], event.id),
    }),
    [event]
  );

  return (
    <SimulatorProject
      state={state}
      currentEvent={event}
      selectedItemId={event.id}
      onSelectItem={() => {}}
      mode="simulation"
    />
  );
}

// ============================================
// Main SimulatorPreview
// ============================================

export function SimulatorPreview({ event }: { event: SessionEvent }) {
  const appType = useMemo(
    () => getAppTypeForEventSafe(event.functionName),
    [event.functionName]
  );

  const isLoading = event.displayStatus === "running";

  const content = useMemo(() => {
    switch (appType) {
      case AppType.CODE_EDITOR:
        return <CodeEditorPreview event={event} isLoading={isLoading} />;
      case AppType.CHANNELS:
        return <ChannelsPreview event={event} />;
      case AppType.BROWSER:
        return <BrowserPreview event={event} />;
      case AppType.STORY_MANAGER:
        return <ProjectManagerPreview event={event} />;
      default:
        return (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            fillParentHeight
            title={`No simulator app — ${event.functionName}`}
          />
        );
    }
  }, [appType, event, isLoading]);

  return <PlaygroundPreviewShell>{content}</PlaygroundPreviewShell>;
}
