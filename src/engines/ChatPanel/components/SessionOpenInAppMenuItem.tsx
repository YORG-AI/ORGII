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
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  externalHistoryAppOpenPlan,
  externalHistoryOpenInApp,
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
  /** Existing binding owner selected by the canonical conversation resolver. */
  appOpenSessionId?: string | null;
  onCloseMenu: () => void;
}

/**
 * "Open in <App>" menu action for imported and managed native sessions.
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
> = ({
  sessionId,
  appOpenSessionId: resolvedAppOpenSessionId,
  onCloseMenu,
}) => {
  const { t } = useTranslation("navigation");
  const [plan, setPlan] = useState<ExternalHistoryAppOpenPlan | null>(null);
  const opening = useRef(false);
  // `undefined` is a legacy/direct imported surface. An explicit `null`
  // means the canonical binding owner found no executed native episode, so
  // do not silently open an older imported source conversation.
  const appOpenSessionId =
    resolvedAppOpenSessionId === undefined
      ? sessionId
      : resolvedAppOpenSessionId;

  useEffect(() => {
    setPlan(null);
    if (!appOpenSessionId) return undefined;
    let cancelled = false;
    externalHistoryAppOpenPlan(appOpenSessionId)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((error) => {
        log.warn("external app open plan failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [appOpenSessionId]);

  const descriptorAppOpen = useMemo(
    () =>
      plan
        ? IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
            (source) => source.sourceId === plan.source
          )?.appOpen
        : undefined,
    [plan]
  );

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
    if (!appOpenSessionId || !plan?.sourceAvailable || opening.current) return;
    opening.current = true;
    onCloseMenu();
    try {
      await externalHistoryOpenInApp(appOpenSessionId);
    } catch (error) {
      log.error("failed to open imported session in its app", error);
      Message.error(
        t("collaboration.openInApp.openFailed", { app: appDisplayName })
      );
    } finally {
      opening.current = false;
    }
  }, [appDisplayName, appOpenSessionId, onCloseMenu, plan, t]);

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
