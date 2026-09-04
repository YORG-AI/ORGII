import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type ExternalHistoryAppOpenPlan,
  externalHistoryAppOpenPlan,
  externalHistoryOpenInApp,
  getImportedHistoryAppOpen,
} from "@src/api/tauri/externalHistory";
import AnyIcon from "@src/components/AnyIcon";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import Tooltip from "@src/components/Tooltip";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { createLogger } from "@src/hooks/logger";
import { ArrowUpRight01Icon, HugeiconsIcon } from "@src/icons";

const log = createLogger("ChatPanel");

interface SessionOpenInAppMenuItemProps {
  sessionId: string | null;
  onCloseMenu: () => void;
}

/**
 * "Open in <App>" menu action for imported external sessions.
 *
 * Where `SessionContinueCliHeaderExtras` hands the session to its CLI inside
 * an ORGII terminal, this hands it to the vendor's own app through a
 * per-session deep link (`claude://resume?session=…`,
 * `codex://threads/…`) so the user can read or continue the very same
 * conversation in its native UI.
 *
 * The link is built and fired in Rust; the frontend only asks for the plan
 * that decides whether the row renders. Deep links are private vendor
 * surfaces and a route that no longer exists fails silently at the OS level,
 * so this stays a convenience beside the CLI resume rather than the only way
 * back into a session.
 */
export const SessionOpenInAppMenuItem: React.FC<
  SessionOpenInAppMenuItemProps
> = ({ sessionId, onCloseMenu }) => {
  const { t } = useTranslation("navigation");
  const [plan, setPlan] = useState<ExternalHistoryAppOpenPlan | null>(null);
  const opening = useRef(false);

  // Sync capability gate: sources without an app deep link never render the
  // row and never pay the backend round-trip. The backend stays
  // authoritative for per-session cases (subagents, odd ids).
  const descriptorAppOpen = getImportedHistoryAppOpen(sessionId);

  useEffect(() => {
    setPlan(null);
    if (!sessionId || !descriptorAppOpen) return undefined;
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
  }, [sessionId, descriptorAppOpen]);

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
    if (!sessionId || !plan?.sourceAvailable || opening.current) return;
    opening.current = true;
    onCloseMenu();
    try {
      await externalHistoryOpenInApp(sessionId);
    } catch (error) {
      log.error("failed to open imported session in its app", error);
      Message.error(
        t("collaboration.openInApp.openFailed", { app: appDisplayName })
      );
    } finally {
      opening.current = false;
    }
  }, [appDisplayName, onCloseMenu, plan, sessionId, t]);

  if (!descriptorAppOpen || !plan) return null;

  const openLabel = t("collaboration.openInApp.headerButton", {
    app: appDisplayName,
  });

  return (
    <>
      <div role="separator" className={DROPDOWN_CLASSES.menuGroupSeparator} />
      <Tooltip
        content={
          disabledReason ??
          t("collaboration.openInApp.headerTooltip", {
            app: appDisplayName,
            link: plan.deepLink,
          })
        }
        position="left"
        mouseEnterDelay={200}
        framedPanel
      >
        <div>
          <DropdownItem
            role="menuitem"
            fullWidth
            tabIndex={0}
            disabled={Boolean(disabledReason)}
            onClick={() => void handleOpen()}
            dataTestId="session-open-in-app-menu-item"
            icon={
              <AnyIcon
                icon={resolveAgentIcon(descriptorAppOpen.iconId)}
                data-icon={descriptorAppOpen.iconId}
                size={DROPDOWN_ITEM.iconSize}
                aria-hidden="true"
              />
            }
            suffix={
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                data-icon="arrow-up-right"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                aria-hidden="true"
              />
            }
          >
            {openLabel}
          </DropdownItem>
        </div>
      </Tooltip>
    </>
  );
};
