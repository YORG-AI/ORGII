/**
 * ClaimIdentityModal — Confirmation dialog for claiming a git identity.
 *
 * Shared between RepoMembersSection and MyProfileSection.
 */
import type { TFunction } from "i18next";
import React from "react";

import type { MemberEntry } from "@src/api/http/project";
import InlineAlert from "@src/components/InlineAlert";
import { HugeiconsIcon, Mail01Icon } from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";

export interface ClaimIdentityModalProps {
  visible: boolean;
  member: MemberEntry | null;
  onClose: () => void;
  onConfirm: () => void;
  t: TFunction;
}

const ClaimIdentityModal: React.FC<ClaimIdentityModalProps> = ({
  visible,
  member,
  onClose,
  onConfirm,
  t,
}) => {
  if (!member) return null;

  return (
    <Modal
      visible={visible}
      title={t("settings.claimIdentityTitle")}
      onClose={onClose}
      onOk={onConfirm}
      okText={t("settings.confirmClaim")}
      cancelText={t("common:actions.cancel")}
      width={420}
    >
      <div className="space-y-4 px-2 py-1">
        <div>
          <div className="text-[13px] text-text-2">
            {t("settings.claimIdentityYoureClaming")}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <HugeiconsIcon
              icon={Mail01Icon}
              data-icon="mail"
              size={16}
              className="text-text-3"
            />
            <span className="text-[14px] font-medium text-text-1">
              {member.email}
            </span>
          </div>
        </div>

        <div>
          <div className="text-[13px] text-text-2">
            {t("settings.claimIdentityThisWill")}
          </div>
          <ul className="mt-1 list-inside list-disc space-y-1 text-[13px] text-text-2">
            <li>{t("settings.claimIdentityLinkEmail")}</li>
            <li>{t("settings.claimIdentityCombineStats")}</li>
            <li>{t("settings.claimIdentityShowAsAuthor")}</li>
          </ul>
        </div>

        <InlineAlert type="warning">
          {t("settings.claimIdentityWarning")}
        </InlineAlert>
      </div>
    </Modal>
  );
};

export default ClaimIdentityModal;
