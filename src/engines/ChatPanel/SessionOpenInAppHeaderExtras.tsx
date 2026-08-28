import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type ExternalHistoryAppOpenPlan,
  externalHistoryAppOpenPlan,
  externalHistoryOpenInApp,
  getImportedHistoryAppOpen,
} from "@src/api/tauri/externalHistory";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Tooltip from "@src/components/Tooltip";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, SquareArrowUpRightIcon } from "@src/icons";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

const log = createLogger("ChatPanel");

export interface SessionOpenInAppHeaderExtrasProps {
  sessionId: string | null;
}

/**
 * "Open in <App>" header action for imported external sessions.
 *
 * Where `SessionContinueCliHeaderExtras` hands the session to its CLI inside
 * an ORGII terminal, this hands it to the vendor's own app through a
 * per-session deep link (`claude://resume?session=…`,
 * `codex://threads/…`) so the user can read or continue the very same
 * conversation in its native UI.
 *
 * The link is built and fired in Rust; the frontend only asks for the plan
 * that decides whether the button renders. Deep links are private vendor
 * surfaces and a route that no longer exists fails silently at the OS level,
 * so this stays a convenience beside the CLI resume rather than the only way
 * back into a session.
 */
const SessionOpenInAppHeaderExtras: React.FC<
  SessionOpenInAppHeaderExtrasProps
> = ({ sessionId }) => {
  const { t } = useTranslation("navigation");
  const [plan, setPlan] = useState<ExternalHistoryAppOpenPlan | null>(null);
  const [opening, setOpening] = useState(false);

  const isImported = Boolean(sessionId && isImportedHistorySession(sessionId));
  // Sync capability gate: sources without an app deep link never render the
  // button and never pay the backend round-trip. The backend stays
  // authoritative for per-session cases (subagents, odd ids).
  const descriptorAppOpen = getImportedHistoryAppOpen(sessionId);

  useEffect(() => {
    setPlan(null);
    if (!sessionId || !isImported || !descriptorAppOpen) return undefined;
    let cancelled = false;
    externalHistoryAppOpenPlan(sessionId)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((error) => {
        log.warn("external app open plan failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isImported, descriptorAppOpen]);

  const appDisplayName =
    plan?.appDisplayName ?? descriptorAppOpen?.displayName ?? "";

  const disabledReason = useMemo(() => {
    if (!plan) return null;
    // Both apps resolve the conversation from the transcript this import was
    // built from, so a deleted transcript can only land on an error state
    // inside the app.
    if (!plan.sourceAvailable) {
      return t("collaboration.openInApp.sourceMissing", {
        app: appDisplayName,
      });
    }
    return null;
  }, [appDisplayName, plan, t]);

  const handleOpen = useCallback(async (): Promise<void> => {
    if (!sessionId || !plan || opening) return;
    setOpening(true);
    try {
      await externalHistoryOpenInApp(sessionId);
    } catch (error) {
      log.error("failed to open imported session in its app", error);
      Message.error(
        t("collaboration.openInApp.openFailed", { app: appDisplayName })
      );
    } finally {
      setOpening(false);
    }
  }, [appDisplayName, opening, plan, sessionId, t]);

  if (!isImported || !plan) return null;

  const openLabel = t("collaboration.openInApp.headerButton", {
    app: appDisplayName,
  });

  return (
    <Tooltip
      content={
        disabledReason ??
        t("collaboration.openInApp.headerTooltip", {
          app: appDisplayName,
          link: plan.deepLink,
        })
      }
      position="bottom-end"
      mouseEnterDelay={200}
      framedPanel
    >
      <span className="inline-flex">
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          loading={opening}
          disabled={Boolean(disabledReason)}
          onClick={() => void handleOpen()}
          aria-label={openLabel}
          data-testid="session-open-in-app-button"
          icon={
            <HugeiconsIcon
              icon={SquareArrowUpRightIcon}
              data-icon="square-arrow-out-up-right"
              size={14}
              strokeWidth={2}
            />
          }
        />
      </span>
    </Tooltip>
  );
};

export default SessionOpenInAppHeaderExtras;
