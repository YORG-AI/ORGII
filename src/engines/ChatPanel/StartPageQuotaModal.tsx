import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { PanelRefreshButton } from "@src/modules/shared/layouts/blocks";
import Modal from "@src/scaffold/ModalSystem";

import {
  type QuotaRefreshControl,
  StartPageQuotaGrid,
} from "./StartPageQuotaGrid";

interface StartPageQuotaModalProps {
  onClose: () => void;
  visible: boolean;
}

/** Reuses the Runtime quota surface for the Launchpad quick action. */
export function StartPageQuotaModal({
  onClose,
  visible,
}: StartPageQuotaModalProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const [refreshControl, setRefreshControl] =
    useState<QuotaRefreshControl | null>(null);
  const handleRefreshControlChange = useCallback(
    (control: QuotaRefreshControl | null) => setRefreshControl(control),
    []
  );
  const refreshLabel = t("chat.startPage.quota.refresh");

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={t("kanban.dataSource.views.quota")}
      size="large"
      width={760}
      footer={null}
      bodyClassName="p-4"
      headerActions={
        <PanelRefreshButton
          dataTestId="quota-modal-refresh"
          disabled={refreshControl === null || refreshControl.disabled}
          loading={refreshControl?.refreshing ?? false}
          onRefresh={refreshControl?.onRefresh ?? (() => undefined)}
          title={refreshLabel}
        />
      }
    >
      <StartPageQuotaGrid
        showHeader={false}
        onRefreshControlChange={handleRefreshControlChange}
      />
    </Modal>
  );
}
