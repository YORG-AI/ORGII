import { useAtom, useSetAtom } from "jotai";
import { Cloud, Laptop, LogIn, Plus } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import {
  acceptCloudInvite,
  createCloudOrg,
} from "@src/features/Org2Cloud/org2CloudManagementClient";
import {
  cloudManagementErrorMessage,
  parseCloudInviteInput,
} from "@src/features/Org2Cloud/org2CloudOrgManagement";
import { useRefetchOrg2CloudOrgs } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "@src/features/Org2Cloud/org2CloudProjectOrgAlias";
import { useAppNavigation } from "@src/hooks/navigation";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import SelectionGrid from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import { openCloudOrgManagementInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";

const LOCAL_SOURCE = "local";
// Managed ORG2 Cloud org (create_org / accept_invite against the managed
// backend — identity comes from the cloud account).
const CLOUD_SOURCE = "cloud";
const CREATE_MODE = "create";
const JOIN_MODE = "join";

const COLLAB_FORM_CONTROL_STYLE = {
  width: "100%",
  maxWidth: "100%",
} as const;

type CreateOrgSource = typeof LOCAL_SOURCE | typeof CLOUD_SOURCE;
type CreateCollabOrgMode = typeof CREATE_MODE | typeof JOIN_MODE;

export type CreatedOrgResult = {
  source: typeof LOCAL_SOURCE;
  org: ProjectOrg;
};

export interface CreateCollabOrgViewProps {
  onCancel: () => void;
  onCreated?: (result: CreatedOrgResult) => void;
}

const CreateCollabOrgView: React.FC<CreateCollabOrgViewProps> = ({
  onCancel,
  onCreated,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const [cloudAuth, setCloudAuth] = useAtom(org2CloudAuthAtom);
  const refetchCloudOrgs = useRefetchOrg2CloudOrgs();

  const [source, setSource] = useState<CreateOrgSource | null>(null);
  const [mode, setMode] = useState<CreateCollabOrgMode>(CREATE_MODE);
  const [orgName, setOrgName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { goToSettings } = useAppNavigation();
  const openCloudOrgManagementTab = useSetAtom(
    openCloudOrgManagementInChatPanelTabAtom
  );

  // "Use ORG2 Cloud" opens the Collaboration section where managed sign-in lives.
  const handleUseOrg2Cloud = useCallback(() => {
    goToSettings({ section: "collaboration" });
  }, [goToSettings]);

  const sourceOptions = useMemo<SelectionGridOption<CreateOrgSource>[]>(
    () => [
      {
        key: LOCAL_SOURCE,
        label: t("navigation:collaboration.localOrg"),
        icon: Laptop,
      },
      {
        key: CLOUD_SOURCE,
        label: t("navigation:cloud.orgManagement.create.sourceCloud"),
        icon: Cloud,
        dataTestId: "create-collab-org-source-cloud",
      },
    ],
    [t]
  );

  const modeOptions = useMemo<SelectionGridOption<CreateCollabOrgMode>[]>(
    () => [
      {
        key: CREATE_MODE,
        label: t("navigation:collaboration.createOrg"),
        icon: Plus,
        dataTestId: "create-collab-org-mode-create",
      },
      {
        key: JOIN_MODE,
        label: t("navigation:collaboration.joinOrg"),
        icon: LogIn,
        dataTestId: "create-collab-org-mode-join",
      },
    ],
    [t]
  );

  // Labels of the required fields still empty — the submit button must never
  // be SILENTLY disabled (the classic report: "Create org can't be clicked"
  // with no clue that the field below the fold is empty).
  const missingRequiredFields = useMemo(() => {
    if (source === null) return [];
    const missing: string[] = [];
    if (source === LOCAL_SOURCE) {
      if (!orgName.trim()) missing.push(t("navigation:collaboration.orgName"));
      return missing;
    }
    // Cloud identity comes from the ORG2 Cloud account — no display name.
    if (mode === CREATE_MODE && !orgName.trim()) {
      missing.push(t("navigation:collaboration.orgName"));
    }
    if (mode === JOIN_MODE && !inviteInput.trim()) {
      missing.push(t("navigation:collaboration.inviteCode"));
    }
    return missing;
  }, [inviteInput, mode, orgName, source, t]);

  const canSubmit = useMemo(() => {
    if (loading || source === null) return false;
    // Managed cloud calls carry the account JWT — signed-out users see the
    // sign-in hint instead of a silently disabled button.
    if (source === CLOUD_SOURCE && !cloudAuth) return false;
    return missingRequiredFields.length === 0;
  }, [cloudAuth, loading, missingRequiredFields, source]);

  // Managed ORG2 Cloud create/join: create_org / accept_invite via the
  // management client (JWT from the cloud account), then refresh
  // org2CloudOrgsAtom so the sidebar selector picks the org up immediately.
  const handleCloudSubmit = useCallback(async () => {
    const current = cloudAuth;
    if (!current) return;
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error(t("navigation:cloud.orgPanel.loadError"));
    commitRefreshedAuth(setCloudAuth, current, fresh);

    if (mode === CREATE_MODE) {
      const { orgId } = await createCloudOrg(fresh.accessToken, orgName.trim());
      // Project-org alias (cloud-parity Phase B): local project/work-item
      // mutations under this org route into the collab outbox from the very
      // first edit. Best-effort — the sync engine re-ensures it per start.
      try {
        await ensureProjectOrgForCloudOrg({ orgId, name: orgName.trim() });
      } catch {
        // Non-fatal: the engine's per-org pass self-heals the alias.
      }
      await refetchCloudOrgs({
        until: (orgs) => orgs.some((org) => org.orgId === orgId),
      });
      Message.success(t("navigation:cloud.orgManagement.create.createdToast"));
      // Land straight in the org management panel (invites, members, repo
      // scopes) instead of a dead-end success screen.
      openCloudOrgManagementTab({
        cloudOrg: { orgId },
        title: t("navigation:collaboration.manageOrg"),
      });
      return;
    }

    const inviteCode = parseCloudInviteInput(inviteInput);
    if (!inviteCode) {
      throw new Error(t("navigation:cloud.orgManagement.errors.inviteInvalid"));
    }
    const result = await acceptCloudInvite(fresh.accessToken, inviteCode);
    const orgs = await refetchCloudOrgs({
      until: (items) => items.some((org) => org.orgId === result.orgId),
    });
    const joined = orgs.find((org) => org.orgId === result.orgId);
    if (!joined) {
      // Do not close the form or show a success toast unless the refreshed
      // roster confirms that the invite produced an active membership.
      throw new Error(t("navigation:cloud.orgPanel.loadError"));
    }
    // Project-org alias on join (cloud-parity Phase B); best-effort, the
    // engine re-ensures it per start.
    try {
      await ensureProjectOrgForCloudOrg(joined);
    } catch {
      // Non-fatal: the engine's per-org pass self-heals the alias.
    }
    Message.success(
      t("navigation:cloud.orgManagement.join.joinedToast", {
        org: joined.name,
      })
    );
    onCancel();
  }, [
    cloudAuth,
    inviteInput,
    mode,
    onCancel,
    openCloudOrgManagementTab,
    orgName,
    refetchCloudOrgs,
    setCloudAuth,
    t,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      if (source === LOCAL_SOURCE) {
        const org = await projectApi.createOrg({ name: orgName });
        onCreated?.({ source: LOCAL_SOURCE, org });
        return;
      }

      await handleCloudSubmit();
    } catch (err) {
      // Cloud failures carry §22 ORG2_* codes (ORG2_INVITE_EXPIRED,
      // ORG2_QUOTA_EXCEEDED, …) — surface the specific translated message.
      setError(
        source === CLOUD_SOURCE
          ? cloudManagementErrorMessage(err, t)
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setLoading(false);
    }
  }, [canSubmit, handleCloudSubmit, onCreated, orgName, source, t]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className="mx-auto flex h-full w-full max-w-[932px] flex-col gap-4 overflow-y-auto px-4"
          data-testid="create-collab-org-body"
        >
          <SectionContainer>
            <SectionRow
              label={t("navigation:collaboration.orgSource")}
              required
              equalColumns
            >
              <SelectionGrid
                options={sourceOptions}
                selected={source}
                columns={2}
                cardVariant="subtle"
                compactCards
                onSelect={setSource}
              />
            </SectionRow>

            {source === CLOUD_SOURCE && (
              <SectionRow
                label={t("navigation:collaboration.setupMode")}
                equalColumns
              >
                <SelectionGrid
                  options={modeOptions}
                  selected={mode}
                  columns={2}
                  cardVariant="subtle"
                  compactCards
                  onSelect={setMode}
                />
              </SectionRow>
            )}

            {source === CLOUD_SOURCE && !cloudAuth && (
              <SectionRow showHeader={false}>
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-fill-2 px-3 py-2"
                  data-testid="create-cloud-org-sign-in-hint"
                >
                  <span className="min-w-0 flex-1 text-[12px] leading-[18px] text-text-2">
                    {t("navigation:cloud.orgManagement.create.signInFirst")}
                  </span>
                  <Button size="small" onClick={handleUseOrg2Cloud}>
                    {t("navigation:cloud.orgManagement.create.openSettings")}
                  </Button>
                </div>
              </SectionRow>
            )}

            {source !== null &&
              (mode === CREATE_MODE || source === LOCAL_SOURCE ? (
                <SectionRow
                  label={t("navigation:collaboration.orgName")}
                  layout="vertical"
                  required
                >
                  <Input
                    data-testid="create-collab-org-name"
                    value={orgName}
                    onChange={setOrgName}
                    placeholder={t(
                      "navigation:collaboration.orgNamePlaceholder"
                    )}
                    style={COLLAB_FORM_CONTROL_STYLE}
                  />
                </SectionRow>
              ) : (
                <SectionRow
                  label={t("navigation:collaboration.inviteCode")}
                  layout="vertical"
                  required
                >
                  <Input
                    data-testid="create-collab-org-invite"
                    value={inviteInput}
                    onChange={setInviteInput}
                    placeholder={t(
                      "navigation:collaboration.inviteCodePlaceholder"
                    )}
                    style={COLLAB_FORM_CONTROL_STYLE}
                  />
                </SectionRow>
              ))}

            {error && (
              <SectionRow showHeader={false}>
                <p className="text-sm text-danger-6">{error}</p>
              </SectionRow>
            )}

            <SectionRow
              showHeader={false}
              className={`${SECTION_ACTION_GAP_CLASSES} justify-end`}
            >
              <Button variant="secondary" size="small" onClick={onCancel}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="primary"
                size="small"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                loading={loading}
                data-testid="create-collab-org-submit"
              >
                {source === LOCAL_SOURCE || mode === CREATE_MODE
                  ? t("navigation:collaboration.createOrg")
                  : t("navigation:collaboration.joinOrg")}
              </Button>
            </SectionRow>
          </SectionContainer>
        </div>
      </div>
    </div>
  );
};

export default CreateCollabOrgView;
