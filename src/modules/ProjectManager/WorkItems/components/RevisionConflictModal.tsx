import React from "react";
import { useTranslation } from "react-i18next";

import Textarea from "@src/components/Textarea";
import Modal from "@src/scaffold/ModalSystem";

export interface RevisionConflictValue {
  fieldLabel: string;
  mine: string;
  latest: string;
  expectedRevision: number;
  actualRevision: number;
}

export interface RevisionConflictModalProps {
  conflict: RevisionConflictValue | null;
  onUseLatest: () => void;
  onKeepMine: () => void | Promise<void>;
}

/**
 * Explicit two-version exit for a stale text edit. "Keep mine" is supplied
 * by the owning data boundary and must retry against `actualRevision`.
 */
export const RevisionConflictModal: React.FC<RevisionConflictModalProps> = ({
  conflict,
  onUseLatest,
  onKeepMine,
}) => {
  const { t } = useTranslation("projects");

  return (
    <Modal
      visible={Boolean(conflict)}
      title={t("workItems.revisionConflict.title")}
      width={620}
      onCancel={onUseLatest}
      onOk={onKeepMine}
      cancelText={t("workItems.revisionConflict.useLatest")}
      okText={t("workItems.revisionConflict.keepMine")}
      maskClosable={false}
      bodyClassName="p-4"
    >
      {conflict ? (
        <div
          className="flex flex-col gap-4"
          data-testid="work-item-revision-conflict"
        >
          <p className="text-sm text-text-2">
            {t("workItems.revisionConflict.description", {
              field: conflict.fieldLabel,
              expected: conflict.expectedRevision,
              actual: conflict.actualRevision,
            })}
          </p>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-text-2">
              {t("workItems.revisionConflict.mine")}
              <Textarea
                value={conflict.mine}
                readOnly
                autoSize={{ minRows: 5, maxRows: 12 }}
                resize="none"
                aria-label={t("workItems.revisionConflict.mine")}
                data-testid="work-item-revision-conflict-mine"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-text-2">
              {t("workItems.revisionConflict.latest")}
              <Textarea
                value={conflict.latest}
                readOnly
                autoSize={{ minRows: 5, maxRows: 12 }}
                resize="none"
                aria-label={t("workItems.revisionConflict.latest")}
                data-testid="work-item-revision-conflict-latest"
              />
            </label>
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

export default RevisionConflictModal;
