import { PanelsTopLeft } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

import { WebOrganizationOnboarding } from "./WebOrganizationOnboarding";
import { useWebSessions } from "./WebSessionsContext";

export function WebSessionsPage() {
  const { t } = useTranslation("navigation");
  const {
    sessions,
    status,
    error,
    refresh,
    organizationStatus,
    organizationsKnown,
    hasOrganizations,
  } = useWebSessions();

  if (organizationsKnown && !hasOrganizations) {
    return (
      <WebOrganizationOnboarding
        refreshError={organizationStatus === "error" ? error : null}
        onRetry={() => void refresh()}
      />
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-workstation-bg p-6">
      <Placeholder
        variant={
          status === "loading" && sessions.length === 0
            ? "loading"
            : status === "error" && sessions.length === 0
              ? "error"
              : "empty"
        }
        icon={<PanelsTopLeft size={22} aria-hidden />}
        placement="detail-panel"
        title={
          status === "loading" && sessions.length === 0
            ? t("web.sessionsPage.loading")
            : status === "error" && sessions.length === 0
              ? t("web.sessionsPage.loadError")
              : sessions.length === 0 && status !== "loading"
                ? t("web.sessionsPage.empty")
                : t("web.sessionsPage.select")
        }
        subtitle={
          error ||
          (sessions.length === 0
            ? t("web.sessionsPage.emptyHint")
            : t("web.sessionsPage.selectHint"))
        }
        action={
          status === "error"
            ? {
                label: t("web.sessionsPage.retry"),
                onClick: () => void refresh(),
              }
            : undefined
        }
      />
    </main>
  );
}
