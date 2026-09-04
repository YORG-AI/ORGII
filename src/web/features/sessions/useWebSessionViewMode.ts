import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import {
  SESSION_VIEW_MODES,
  type SessionViewMode,
  type SessionViewModeState,
  type UseSessionViewModeResult,
  isSessionViewMode,
  resolveSessionViewMode,
} from "@src/engines/ChatPanel/hooks/useSessionViewMode";
import type { SessionEvent } from "@src/engines/SessionCore";
import {
  ChartGanttIcon,
  CodeXmlIcon,
  FileDiffIcon,
  HugeiconsIcon,
  type IconSvgElement,
  MessagesSquareIcon,
} from "@src/icons";

import { useWebSessionRawTranscript } from "./useWebSessionRawTranscript";

const MODE_ICONS: Record<SessionViewMode, IconSvgElement> = {
  gui: MessagesSquareIcon,
  timeline: ChartGanttIcon,
  changes: FileDiffIcon,
  raw: CodeXmlIcon,
};

const MODE_ICON_SIZE = 14;

const SESSION_VIEW_FALLBACK_LABELS: Record<SessionViewMode, string> = {
  gui: "Chat",
  timeline: "Timeline",
  changes: "Changes",
  raw: "Raw",
};

export function useWebSessionViewMode({
  sessionId,
  events,
  switchable = true,
}: {
  sessionId: string | null;
  events: readonly SessionEvent[];
  switchable?: boolean;
}): UseSessionViewModeResult {
  const { t } = useTranslation("sessions");
  const [state, setState] = useState<SessionViewModeState>({
    mode: "gui",
    sessionId,
  });

  const canSwitch = Boolean(sessionId) && switchable;
  const mode = resolveSessionViewMode(state, sessionId, canSwitch);
  const isRaw = mode === "raw";
  const transcript = useWebSessionRawTranscript(sessionId, events, isRaw);

  const options = useMemo<SelectOption[]>(
    () =>
      SESSION_VIEW_MODES.map((value) => {
        const icon = MODE_ICONS[value];
        return {
          value,
          label: t(`chat.sessionViews.${value}`, {
            defaultValue: SESSION_VIEW_FALLBACK_LABELS[value],
          }),
          icon: React.createElement(HugeiconsIcon, {
            icon,
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

  return {
    mode,
    isRaw,
    switchable: canSwitch,
    options,
    onChange,
    showRaw,
    transcript,
  };
}
