/**
 * Per-session view-mode state, shared by the two hosts that render a session
 * surface: the chat pane (`ChatPanel/index.tsx`) and the Workstation
 * `chat-session` tab renderer. Both show the same ghost select and the same
 * bodies, so the mode state, the option list and the raw-transcript wiring
 * live here instead of being duplicated per host.
 *
 * The mode is keyed by session id: switching to another session inside the
 * same host lands back on "gui" rather than stranding the new session in the
 * previous one's view.
 *
 * `useSessionRawTranscript` is called with `enabled = isRaw`, so a session that
 * never opens Raw pays neither the transcript load nor the JSON serialization.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import {
  ChartGanttIcon,
  FileDiffIcon,
  FirstBracketIcon,
  HugeiconsIcon,
  MessageMultiple01Icon,
} from "@src/icons";

import { useSessionRawTranscript } from "../components/SessionRawTranscriptDialog/useSessionRawTranscript";

export const SESSION_VIEW_MODES = [
  "gui",
  "timeline",
  "changes",
  "raw",
] as const;
export type SessionViewMode = (typeof SESSION_VIEW_MODES)[number];

export function isSessionViewMode(value: string): value is SessionViewMode {
  return (SESSION_VIEW_MODES as readonly string[]).includes(value);
}

export interface SessionViewModeState {
  mode: SessionViewMode;
  sessionId: string | null;
}

/**
 * Effective mode for the session currently being rendered.
 *
 * A state entry belonging to another session (or a session that cannot switch
 * at all) resolves to "gui" without a state write, so changing sessions never
 * needs an effect to reset the mode — and a session can never inherit the
 * previous session's view.
 */
export function resolveSessionViewMode(
  state: SessionViewModeState,
  sessionId: string | null,
  switchable: boolean
): SessionViewMode {
  if (!switchable) return "gui";
  return state.sessionId === sessionId ? state.mode : "gui";
}

const MODE_ICONS: Record<SessionViewMode, typeof MessageMultiple01Icon> = {
  gui: MessageMultiple01Icon,
  timeline: ChartGanttIcon,
  changes: FileDiffIcon,
  raw: FirstBracketIcon,
};

const MODE_ICON_SIZE = 14;

const SESSION_VIEW_FALLBACK_LABELS: Record<SessionViewMode, string> = {
  gui: "Chat",
  timeline: "Timeline",
  changes: "Changes",
  raw: "Raw",
};

export interface UseSessionViewModeOptions {
  sessionId: string | null;
  /**
   * Human sessions carry no agent event transcript, so there is nothing to
   * show in the derived views — the mode is pinned to "gui" and the select is
   * suppressed.
   */
  humanSession: boolean;
}

export interface UseSessionViewModeResult {
  mode: SessionViewMode;
  isRaw: boolean;
  /** False for human sessions / no session — hosts skip the select entirely. */
  switchable: boolean;
  options: SelectOption[];
  onChange: (value: string | number | (string | number)[]) => void;
  /** Jump straight to Raw; wired to the header menu's "Raw transcript" item. */
  showRaw: () => void;
  transcript: ReturnType<typeof useSessionRawTranscript>;
}

export function useSessionViewMode({
  sessionId,
  humanSession,
}: UseSessionViewModeOptions): UseSessionViewModeResult {
  const { t } = useTranslation("sessions");
  const [state, setState] = useState<SessionViewModeState>({
    mode: "gui",
    sessionId,
  });

  const switchable = Boolean(sessionId) && !humanSession;
  const mode = resolveSessionViewMode(state, sessionId, switchable);
  const isRaw = mode === "raw";

  const transcript = useSessionRawTranscript(sessionId, isRaw);

  const options = useMemo<SelectOption[]>(
    () =>
      SESSION_VIEW_MODES.map((value) => {
        const Icon = MODE_ICONS[value];
        return {
          value,
          label: t(`chat.sessionViews.${value}`, {
            defaultValue: SESSION_VIEW_FALLBACK_LABELS[value],
          }),
          icon: React.createElement(HugeiconsIcon, {
            icon: Icon,
            size: MODE_ICON_SIZE,
            strokeWidth: 1.75,
          }),
          dataTestId: `session-view-option-${value}`,
        };
      }),
    [t]
  );

  const onChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const next = String(value);
      if (!isSessionViewMode(next)) return;
      setState({ mode: next, sessionId });
    },
    [sessionId]
  );

  const showRaw = useCallback(() => {
    if (!sessionId) return;
    setState({ mode: "raw", sessionId });
  }, [sessionId]);

  return { mode, isRaw, switchable, options, onChange, showRaw, transcript };
}
