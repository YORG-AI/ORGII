import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Modal from "@src/scaffold/ModalSystem";
import type { InstalledSkill } from "@src/types/extensions";

export interface ShareSkillDialogProps {
  skill: InstalledSkill | null;
  onClose: () => void;
}

export const ShareSkillDialog: React.FC<ShareSkillDialogProps> = ({
  skill,
  onClose,
}) => {
  const { t } = useTranslation("integrations");
  const [orgs, setOrgs] = useState<ProjectOrg[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    if (!skill) return;
    projectApi
      .readOrgs()
      .then((rows) => {
        setOrgs(rows);
        setOrgId(
          (current) =>
            current ?? rows.find((org) => org.id !== "personal-org")?.id ?? null
        );
      })
      .catch(() => undefined);
  }, [skill]);

  const orgOptions = useMemo(
    () =>
      orgs.map((org) => ({
        value: org.id,
        label: org.name,
      })),
    [orgs]
  );

  const handleShare = async () => {
    if (!skill || !orgId) return;
    setSharing(true);
    try {
      await invoke("skills_share_to_org", {
        skillPath: skill.path,
        orgId,
        description: skill.description ?? "",
        sharedBy: null,
      });
      Message.success(
        t("skills.sharedToOrg", {
          defaultValue: "Skill shared with the organization",
        })
      );
      onClose();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSharing(false);
    }
  };

  return (
    <Modal
      visible={skill !== null}
      title={t("skills.shareToOrg", {
        defaultValue: "Share to organization",
      })}
      width={400}
      onCancel={onClose}
      onOk={() => void handleShare()}
      okText={t("skills.share", { defaultValue: "Share" })}
      cancelText={t("common:actions.cancel", { defaultValue: "Cancel" })}
      okButtonProps={{ disabled: !orgId, loading: sharing }}
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-text-3">
          {t("skills.shareToOrgHint", {
            defaultValue:
              "Members of the organization receive this skill's current snapshot; share again after editing to publish an update.",
          })}
        </p>
        <Select
          value={orgId ?? undefined}
          options={orgOptions}
          onChange={(value) => setOrgId(value as string)}
          placeholder={t("skills.shareOrgPlaceholder", {
            defaultValue: "Organization",
          })}
          size="small"
          dataTestId="skills-share-org-select"
        />
      </div>
    </Modal>
  );
};

export default ShareSkillDialog;
