/**
 * CloudSessionShareDialog — owner-side per-session sharing for MANAGED cloud
 * orgs (migration 0012). Mounted from the owner's OWN session surfaces
 * (sidebar context menu + chat panel header menu), same as the self-hosted
 * SessionShareDialog it is modeled on. One section per share-capable cloud
 * org: directed member shares and one-shot share links with revocation.
 * Access ladder + visibility live in CloudSyncLevelDialog, not here.
 */
import Modal from "@/src/scaffold/ModalSystem";
import type { TFunction } from "i18next";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import { Copy01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import type { Session } from "@src/store/session/sessionAtom/types";
import { formatSmartDateTime } from "@src/util/data/formatters/date";

import type { Org2CloudOrg } from "../org2CloudOrgsAtom";
import { useCloudShareOrgSectionModel } from "./useCloudShareOrgSectionModel";

function OrgShareSection({
  t,
  session,
  org,
}: {
  t: TFunction<"navigation">;
  session: Session;
  org: Org2CloudOrg;
}) {
  const model = useCloudShareOrgSectionModel({ session, org });

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border-2 bg-bg-2 p-3"
      data-testid={`cloud-session-share-org-section-${org.orgId}`}
    >
      <div className="text-[13px] font-semibold text-text-1">{org.name}</div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-medium text-text-2">
          {t("cloud.share.directedTitle")}
        </div>
        {model.membersLoading ? (
          <div
            className="text-[11px] text-text-3"
            data-testid="cloud-session-share-members-loading"
          >
            {t("cloud.orgPanel.loading")}
          </div>
        ) : model.grantableMembers.length === 0 ? (
          <div className="text-[11px] text-text-3">
            {t("cloud.share.directedEmpty")}
          </div>
        ) : (
          <>
            {model.grantableMembers.length > 1 ? (
              <div data-testid="cloud-session-share-select-all">
                <Checkbox
                  size="small"
                  className="w-full px-2.5 py-1.5 font-medium hover:bg-surface-hover"
                  checked={model.allGrantableSelected}
                  indeterminate={
                    !model.allGrantableSelected &&
                    model.selectedMemberIds.length > 0
                  }
                  onCheckedChange={model.handleToggleSelectAll}
                >
                  {t("cloud.share.selectAll", {
                    count: model.grantableMembers.length,
                  })}
                </Checkbox>
              </div>
            ) : null}
            <div className="flex flex-col divide-y divide-border-2 rounded-lg border border-border-2">
              {model.grantableMembers.map((member) => (
                <div
                  key={member.userId}
                  data-testid={`cloud-session-share-member-${member.userId}`}
                >
                  <Checkbox
                    size="small"
                    className="w-full px-2.5 py-1.5 hover:bg-surface-hover"
                    checked={model.selectedMemberIds.includes(member.userId)}
                    onCheckedChange={() =>
                      model.handleToggleMember(member.userId)
                    }
                  >
                    {member.displayName ?? member.userId}
                  </Checkbox>
                </div>
              ))}
            </div>
            <div>
              <Button
                htmlType="button"
                size="small"
                loading={model.busy}
                disabled={
                  !model.canShare || model.selectedMemberIds.length === 0
                }
                onClick={() => void model.handleCreateDirectedShares()}
                data-testid="cloud-session-share-create-directed"
              >
                {t("cloud.share.createDirected")}
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-medium text-text-2">
          {t("cloud.share.linkTitle")}
        </div>
        <div>
          <Button
            htmlType="button"
            size="small"
            loading={model.busy}
            disabled={!model.canShare}
            onClick={() => void model.handleCreateLinkShare()}
            data-testid="cloud-session-share-create-link"
          >
            {t("cloud.share.createLink")}
          </Button>
        </div>
        {model.createdLink ? (
          <div className="flex flex-col gap-2 rounded-lg bg-fill-1 px-3 py-2">
            <code
              className="text-[11px] break-all text-text-2 select-text"
              data-testid="cloud-session-share-created-link"
              data-share-id={model.createdLink.shareId}
            >
              {model.createdLink.link}
            </code>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-3">
                {model.createdLinkCopied
                  ? t("cloud.share.linkCopied")
                  : t("cloud.share.linkShownOnce")}
              </span>
              <Button
                htmlType="button"
                size="small"
                variant="primary"
                icon={
                  model.createdLinkCopied ? (
                    <HugeiconsIcon
                      icon={Tick01Icon}
                      data-icon="check"
                      size={12}
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={Copy01Icon}
                      data-icon="copy"
                      size={12}
                    />
                  )
                }
                onClick={() => void model.handleCopyCreatedLink()}
                data-testid="cloud-session-share-copy-link"
                data-copy-state={model.createdLinkCopied ? "copied" : "idle"}
              >
                {model.createdLinkCopied
                  ? t("cloud.orgManagement.invites.copied")
                  : t("cloud.orgManagement.invites.copyLink")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-medium text-text-2">
          {t("cloud.share.activeShares")}
        </div>
        {model.shares.length === 0 ? (
          <div className="text-[11px] text-text-3">
            {t("cloud.share.noShares")}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border-2 rounded-lg border border-border-2">
            {model.shares.map((share) => (
              <div
                key={share.id}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px]"
                data-testid="cloud-session-share-active-row"
                data-share-id={share.id}
              >
                <span className="min-w-0 truncate text-text-2">
                  {share.granteeUserId
                    ? (model.memberNameById.get(share.granteeUserId) ??
                      share.granteeUserId)
                    : `${t("cloud.share.linkShareLabel")} #${share.id.slice(-4)}`}
                  <span className="ml-2 text-[11px] text-text-4">
                    {formatSmartDateTime(share.createdAt)}
                  </span>
                </span>
                <Button
                  htmlType="button"
                  variant="secondary"
                  size="small"
                  disabled={model.busy}
                  onClick={() => void model.handleRevokeShare(share.id)}
                  data-testid={
                    model.createdLink?.shareId === share.id
                      ? "cloud-session-share-created-link-revoke"
                      : share.granteeUserId
                        ? `cloud-session-share-directed-revoke-${share.granteeUserId}`
                        : "cloud-session-share-link-revoke"
                  }
                  data-share-id={share.id}
                >
                  {t("cloud.share.revoke")}
                </Button>
              </div>
            ))}
          </div>
        )}
        {model.sharesError ? (
          <div
            className="rounded-lg bg-danger-1 px-3 py-2 text-[11px] text-danger-6"
            data-testid="cloud-session-share-error"
          >
            {t("cloud.share.sharesError")}: {model.sharesError}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface CloudSessionShareDialogProps {
  /** The owner's local session; null keeps the dialog closed. */
  session: Session | null;
  /** Share-capable cloud orgs for the session (see useCloudSessionShareDialog). */
  orgs: Org2CloudOrg[];
  onClose: () => void;
}

const CloudSessionShareDialog: React.FC<CloudSessionShareDialogProps> = ({
  session,
  orgs,
  onClose,
}) => {
  const { t } = useTranslation("navigation");

  return (
    <Modal
      visible={session !== null}
      title={t("cloud.share.dialogTitle")}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      {session ? (
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          <div className="text-[12px] text-text-3">
            {session.name || session.user_input || session.session_id}
          </div>
          {orgs.length === 0 ? (
            <div className="text-[12px] text-text-3">
              {t("cloud.share.noOrgs")}
            </div>
          ) : (
            orgs.map((org) => (
              <OrgShareSection
                key={org.orgId}
                t={t}
                session={session}
                org={org}
              />
            ))
          )}
        </div>
      ) : null}
    </Modal>
  );
};

export default CloudSessionShareDialog;
