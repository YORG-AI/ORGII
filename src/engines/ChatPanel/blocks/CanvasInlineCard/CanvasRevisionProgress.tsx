import { LoaderCircle, PenTool } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { CanvasRevisionDraft } from "@src/store/session/canvasRevisionDraftAtom";

import CanvasRevisionSteps from "./CanvasRevisionSteps";
import { formatCanvasRevisionCharacterCount } from "./canvasRevisionProgressState";

interface CanvasRevisionProgressProps {
  draft: CanvasRevisionDraft;
  variant?: "chat" | "overlay";
}

const CanvasRevisionProgress: React.FC<CanvasRevisionProgressProps> = ({
  draft,
  variant = "chat",
}) => {
  const { t } = useTranslation("sessions");
  const title = draft.title?.trim() || t("canvasApp.revisionCanvas", "Canvas");
  const applying = draft.phase === "applying";
  const detail = applying
    ? t("canvasApp.revisionApplying", "Applying the validated change…")
    : t(
        "canvasApp.revisionReceiving",
        "Generating the change · {{amount}} characters",
        {
          amount: formatCanvasRevisionCharacterCount(draft.receivedCharacters),
        }
      );
  // Screen-reader announcement changes only on phase transitions. The visible
  // detail line updates its character counter at ~20Hz — putting it inside an
  // aria-live region used to spam assistive tech on every tick.
  const phaseAnnouncement = applying
    ? t("canvasApp.revisionApplying", "Applying the validated change…")
    : t("canvasApp.revisionReceivingLabel", "Generating the change…");

  return (
    <div
      data-testid="canvas-revision-progress"
      data-phase={draft.phase}
      className={[
        "flex min-w-0 items-center gap-2 rounded-lg border border-border-1 bg-bg-1/95 px-3 py-2 shadow-lg backdrop-blur",
        variant === "overlay"
          ? "w-fit max-w-[min(28rem,calc(100vw-2rem))]"
          : "my-2",
      ].join(" ")}
    >
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-2 text-primary-6">
        <PenTool size={13} aria-hidden />
        <LoaderCircle
          size={27}
          aria-hidden
          className="absolute inset-0 animate-spin motion-reduce:animate-none"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-text-1">
          {t("canvasApp.revisionTitle", "Updating {{title}}", { title })}
        </span>
        <span
          aria-hidden
          className="block truncate text-[11px] text-text-3"
          data-testid="canvas-revision-progress-detail"
        >
          {detail}
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {phaseAnnouncement}
        </span>
        <CanvasRevisionSteps
          phase={draft.phase}
          steps={draft.agentSteps ?? []}
          className="mt-1"
        />
      </span>
    </div>
  );
};

CanvasRevisionProgress.displayName = "CanvasRevisionProgress";

export default CanvasRevisionProgress;
