/**
 * StreamingHud
 *
 * A compact pill above the input area showing live streaming telemetry —
 * elapsed time, estimated throughput (tokens/s), and a soft ETA — while the
 * agent is producing an answer. Renders nothing when the session is idle or
 * has not started streaming output yet.
 *
 * It is a sibling of the stream-retry indicator in `ChatHeader` and follows
 * the same low-key pill styling so the input area chrome stays consistent.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { useStreamingHud } from "@src/engines/ChatPanel/hooks/useStreamingHud";
import { GaugeIcon, HugeiconsIcon } from "@src/icons";

interface StreamingHudProps {
  sessionId: string | undefined;
}

/** Format whole seconds as `M:SS` (or `SS s` under a minute). */
function formatElapsed(totalSecs: number): string {
  if (totalSecs < 60) return `${totalSecs}s`;
  const minutes = Math.floor(totalSecs / 60);
  const seconds = totalSecs % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const StreamingHud: React.FC<StreamingHudProps> = ({ sessionId }) => {
  const { t } = useTranslation("sessions");
  const hud = useStreamingHud(sessionId);

  if (!hud.active) return null;

  return (
    <div className="mx-auto mb-1 flex w-full items-center justify-center">
      <div className="flex h-[24px] items-center gap-2 rounded-full border border-solid border-border-2 bg-bg-2 px-3 text-[12px] text-text-2">
        <HugeiconsIcon
          icon={GaugeIcon}
          data-icon="gauge"
          size={12}
          strokeWidth={1.75}
          className="text-text-3"
        />
        <span>
          {hud.tokens > 0
            ? t("chat.hudElapsed", { time: formatElapsed(hud.elapsedSecs) })
            : t("chat.workspaceIsWorking")}
        </span>
        {hud.tokensPerSec !== null && (
          <>
            <span className="text-text-3">·</span>
            <span>{t("chat.hudThroughput", { rate: hud.tokensPerSec })}</span>
          </>
        )}
        {hud.etaSecs !== null && (
          <>
            <span className="text-text-3">·</span>
            <span>{t("chat.hudEta", { eta: formatElapsed(hud.etaSecs) })}</span>
          </>
        )}
      </div>
    </div>
  );
};

export default StreamingHud;
