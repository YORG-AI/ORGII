/**
 * ChatViewTypes — prop types for `ChatView`, split into their own module so
 * sibling hooks/sub-components can reference them without importing the
 * full `ChatView` component.
 */
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

export interface ChatViewProps {
  /** Session ID to display. Sync bridges and events load for this session. */
  sessionId: string;
  onRegisterSearchOpen?: (handler: (() => void) | null) => void;
  displayMode?: ChatHistoryDisplayMode;
  turnPaginationEnabled?: boolean;
  /** Dock side for the containing chat panel, used to place side previews inward. */
  position?: "left" | "right";
  /**
   * Height of the floating tab/published-header chrome overlaying the pane
   * top. The pinned-header host and transcript top padding clear this
   * region; 0 when the chrome is rendered in flow.
   */
  chromeTopInset?: number;
  /** Opaque background class for sticky headers (must match the container surface).
   *  Defaults to "bg-chat-pane" (side panel). Pass EDITOR_TAB_CANVAS_BG_CLASS for WorkStation. */
  surfaceBgClass?: string;
  /**
   * Passive replay mode: this ChatView does NOT write the pipeline
   * atom AND does NOT mirror the IDE workspace folders into the
   * session's backend workspace. Use for editor-tab session inspection
   * where the chat is a read-only artifact.
   */
  readOnly?: boolean;
  /**
   * Secondary/inspect mode: this ChatView DOES claim the pipeline
   * (so live events stream and the user can interact), but does NOT
   * mutate the session's persisted backend workspace via
   * `useSessionWorkspaceSync`. Use when showing another session's
   * chat in a non-primary surface (kanban detail, project-manager
   * tab) — those sessions may belong to a totally different repo and
   * we must not silently rewrite their workspace footprint to match
   * the IDE's current folders.
   */
  secondary?: boolean;
  /**
   * Retarget the owning tab after an immutable imported history is forked
   * into a writable ORGII session. The callback must also claim/navigate the
   * new session pipeline for its surface.
   */
  onSessionContinuation?: (continuation: SessionContinuation) => void;
}
