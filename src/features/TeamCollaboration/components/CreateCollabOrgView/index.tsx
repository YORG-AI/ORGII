import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { CREATOR_COMPOSER_POSITION } from "@src/config/sessionCreatorConfig";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { cloudManagementErrorMessage } from "@src/features/Org2Cloud/org2CloudOrgManagement";
import {
  CloudOrgMembershipActionFailure,
  useCloudOrgMembershipActions,
} from "@src/features/Org2Cloud/useCloudOrgMembershipActions";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { Add01Icon, CloudIcon, LaptopIcon, Login01Icon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import SelectionGrid from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import { openOrganizationInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { creatorComposerPositionAtom } from "@src/store/session/creatorComposerPositionAtom";
import {
  CHAT_PANEL_COLLAB_ORG_MODE,
  CHAT_PANEL_COLLAB_ORG_SOURCE,
  type ChatPanelCollabOrgMode,
  type ChatPanelCollabOrgSource,
  chatPanelCollabOrgCreateIntentAtom,
} from "@src/store/ui/chatPanelAtom";
import { clearGuideHighlightTargetAtom } from "@src/store/ui/guideHighlightAtom";

const LOCAL_SOURCE = CHAT_PANEL_COLLAB_ORG_SOURCE.LOCAL;
// Managed ORG2 Cloud org (create_org / accept_invite against the managed
// backend — identity comes from the cloud account).
const CLOUD_SOURCE = CHAT_PANEL_COLLAB_ORG_SOURCE.CLOUD;
const CREATE_MODE = CHAT_PANEL_COLLAB_ORG_MODE.CREATE;
const JOIN_MODE = CHAT_PANEL_COLLAB_ORG_MODE.JOIN;

const COLLAB_FORM_CONTROL_STYLE = {
  width: "100%",
  maxWidth: "100%",
} as const;

type CreateOrgSource = ChatPanelCollabOrgSource;
type CreateCollabOrgMode = ChatPanelCollabOrgMode;

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
  const composerPosition = useAtomValue(creatorComposerPositionAtom);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const createIntent = useAtomValue(chatPanelCollabOrgCreateIntentAtom);
  const setCreateIntent = useSetAtom(chatPanelCollabOrgCreateIntentAtom);
  const clearGuideHighlightTarget = useSetAtom(clearGuideHighlightTargetAtom);
  const { createOrganization, joinOrganization } =
    useCloudOrgMembershipActions();

  const [source, setSource] = useState<CreateOrgSource | null>(
    () => createIntent?.source ?? null
  );
  const [mode, setMode] = useState<CreateCollabOrgMode>(
    () => createIntent?.mode ?? CREATE_MODE
  );
  const [orgName, setOrgName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const openCloudSignIn = useOrg2CloudSignIn();
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const orgNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!createIntent) return;
    setSource(createIntent.source);
    setMode(createIntent.mode);
    setError(null);
  }, [createIntent]);

  useEffect(() => {
    if (
      !createIntent ||
      source !== createIntent.source ||
      mode !== createIntent.mode
    ) {
      return;
    }
    const input = orgNameInputRef.current;
    if (!input) return;
    input.focus();
    setCreateIntent(null);
  }, [createIntent, mode, setCreateIntent, source]);

  const clearOrgNameGuide = useCallback(() => {
    clearGuideHighlightTarget(GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT);
  }, [clearGuideHighlightTarget]);

  const handleCancel = useCallback(() => {
    clearOrgNameGuide();
    onCancel();
  }, [clearOrgNameGuide, onCancel]);

  const sourceOptions = useMemo<SelectionGridOption<CreateOrgSource>[]>(
    () => [
      {
        key: LOCAL_SOURCE,
        label: t("navigation:collaboration.localOrg"),
        icon: LaptopIcon,
      },
      {
        key: CLOUD_SOURCE,
        label: t("navigation:cloud.orgManagement.create.sourceCloud"),
        icon: CloudIcon,
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
        icon: Add01Icon,
        dataTestId: "create-collab-org-mode-create",
      },
      {
        key: JOIN_MODE,
        label: t("navigation:collaboration.joinOrg"),
        icon: Login01Icon,
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
    if (mode === CREATE_MODE) {
      const created = await createOrganization(orgName);
      Message.success(t("navigation:cloud.orgManagement.create.createdToast"));
      // Land straight in the org management panel (invites, members, repo
      // scopes) instead of a dead-end success screen.
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: created.orgId },
        },
        title: t("navigation:collaboration.manageOrg"),
      });
      clearOrgNameGuide();
      return;
    }

    const joined = await joinOrganization(inviteInput);
    Message.success(
      t("navigation:cloud.orgManagement.join.joinedToast", {
        org: joined.name,
      })
    );
    onCancel();
  }, [
    createOrganization,
    clearOrgNameGuide,
    inviteInput,
    joinOrganization,
    mode,
    onCancel,
    openOrganizationTab,
    orgName,
    t,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      if (source === LOCAL_SOURCE) {
        const org = await projectApi.createOrg({ name: orgName });
        clearOrgNameGuide();
        onCreated?.({ source: LOCAL_SOURCE, org });
        return;
      }

      await handleCloudSubmit();
    } catch (err) {
      // Cloud failures carry §22 ORG2_* codes (ORG2_INVITE_EXPIRED,
      // ORG2_QUOTA_EXCEEDED, …) — surface the specific translated message.
      if (
        source === CLOUD_SOURCE &&
        err instanceof CloudOrgMembershipActionFailure
      ) {
        setError(
          err.code === "invalid_invite"
            ? t("navigation:cloud.orgManagement.errors.inviteInvalid")
            : err.code === "session_expired"
              ? t("navigation:cloud.sessionExpired")
              : t("navigation:cloud.orgPanel.loadError")
        );
      } else {
        setError(
          source === CLOUD_SOURCE
            ? cloudManagementErrorMessage(err, t)
            : err instanceof Error
              ? err.message
              : String(err)
        );
      }
    } finally {
      setLoading(false);
    }
  }, [
    canSubmit,
    clearOrgNameGuide,
    handleCloudSubmit,
    onCreated,
    orgName,
    source,
    t,
  ]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className={`${DETAIL_PANEL_TOKENS.headerWidth} flex h-full flex-col gap-4 overflow-y-auto px-4`}
          data-testid="create-collab-org-body"
        >
          <SectionContainer
            className={
              composerPosition === CREATOR_COMPOSER_POSITION.MIDDLE
                ? "my-auto shrink-0"
                : undefined
            }
          >
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
                  <span className="min-w-0 flex-1 text-xs leading-[18px] text-text-2">
                    {t("navigation:cloud.orgManagement.create.signInFirst")}
                  </span>
                  <Button size="small" onClick={openCloudSignIn}>
                    {t("navigation:cloud.signIn")}
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
                  <div
                    className="w-full"
                    data-guide-target={GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT}
                  >
                    <Input
                      ref={orgNameInputRef}
                      data-testid="create-collab-org-name"
                      aria-label={t("navigation:collaboration.orgName")}
                      value={orgName}
                      onChange={setOrgName}
                      placeholder={t(
                        "navigation:collaboration.orgNamePlaceholder"
                      )}
                      style={COLLAB_FORM_CONTROL_STYLE}
                    />
                  </div>
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
              <Button variant="secondary" size="small" onClick={handleCancel}>
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
