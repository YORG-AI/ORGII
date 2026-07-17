import { Settings } from "lucide-react";
import React, { useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";

import { buildIntegrationsPath } from "@src/config/mainAppPaths";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import Modal from "@src/scaffold/ModalSystem";

export interface GitAuthenticationDialogOptions {
  operation: "push" | "pull" | "fetch" | "sync";
  repoPath?: string;
  remote?: string;
  onLoadStoredCredential?: () => Promise<GitAuthenticationDialogResult | null>;
}

export interface GitAuthenticationDialogResult {
  username: string;
  token: string;
  shouldStore: boolean;
}

interface GitAuthenticationDialogProps extends GitAuthenticationDialogOptions {
  onResolve: (result: GitAuthenticationDialogResult | null) => void;
}

const APP_TOP_DRAG_ZONE_HEIGHT = 52;

function openConnectionsPage() {
  window.history.pushState(
    {},
    "",
    buildIntegrationsPath({ category: "connections" })
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function GitAuthenticationDialog({ onResolve }: GitAuthenticationDialogProps) {
  const { t } = useTranslation("common");

  const handleCancel = useCallback(() => {
    onResolve(null);
  }, [onResolve]);

  const handleOpenConnections = useCallback(() => {
    openConnectionsPage();
    onResolve(null);
  }, [onResolve]);

  return (
    <Modal
      visible
      title={t("git.authDialog.title")}
      width={460}
      topDragZoneHeight={APP_TOP_DRAG_ZONE_HEIGHT}
      okText={t("git.authDialog.openGitSettingsButton")}
      cancelText={t("actions.cancel")}
      onOk={handleOpenConnections}
      onCancel={handleCancel}
      onClose={handleCancel}
      maskClosable={false}
      footer={
        <PanelFooter
          secondaryActions={[
            {
              label: t("actions.cancel"),
              onClick: handleCancel,
              variant: "secondary",
            },
          ]}
          primaryAction={{
            label: t("git.authDialog.openGitSettingsButton"),
            onClick: handleOpenConnections,
            variant: "primary",
          }}
        />
      }
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-fill-2 p-2 text-text-2">
          <Settings size={16} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium text-text-1">
            {t("git.authDialog.configureInSettings")}
          </div>
          <div className="text-[12px] leading-5 text-text-3">
            {t("git.authDialog.configureInSettingsDesc")}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function showGitAuthenticationDialog(
  options: GitAuthenticationDialogOptions
): Promise<GitAuthenticationDialogResult | null> {
  return new Promise((resolve) => {
    const container = document.createElement("div");
    container.setAttribute("data-git-auth-dialog-root", "true");
    document.body.appendChild(container);

    const root = createRoot(container);

    const cleanup = () => {
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 0);
    };

    root.render(
      <GitAuthenticationDialog
        {...options}
        onResolve={(result) => {
          resolve(result);
          cleanup();
        }}
      />
    );
  });
}
