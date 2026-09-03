import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { cloudManagementErrorMessage } from "@src/features/Org2Cloud/org2CloudOrgManagement";
import {
  CloudOrgMembershipActionFailure,
  useCloudOrgMembershipActions,
} from "@src/features/Org2Cloud/useCloudOrgMembershipActions";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { Add01Icon, CloudIcon, LaptopIcon, Login01Icon } from "@src/icons";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import SelectionGrid from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import { openOrganizationInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { clearGuideHighlightTargetAtom } from "@src/store/ui/guideHighlightAtom";
import type {
  SpotlightCollabOrgMode,
  SpotlightCollabOrgSource,
} from "@src/store/ui/uiAtom";

import { SpotlightSearchBar } from "../../components";
import { ICONS } from "../../config";
import type { PathSegment } from "../../types";
import { SpotlightFormBody, SpotlightFormShell } from "../shared";

const LOCAL_SOURCE: SpotlightCollabOrgSource = "local";
const CLOUD_SOURCE: SpotlightCollabOrgSource = "cloud";
const CREATE_MODE: SpotlightCollabOrgMode = "create";
const JOIN_MODE: SpotlightCollabOrgMode = "join";

interface CollabOrgFormProps {
  initialSource?: SpotlightCollabOrgSource;
  initialMode?: SpotlightCollabOrgMode;
  onCancel: () => void;
  onCompleted: () => void;
}

const CollabOrgForm: React.FC<CollabOrgFormProps> = ({
  initialSource,
  initialMode,
  onCancel,
  onCompleted,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const clearGuideHighlightTarget = useSetAtom(clearGuideHighlightTargetAtom);
  const { createOrganization, joinOrganization } =
    useCloudOrgMembershipActions();
  const openCloudSignIn = useOrg2CloudSignIn();

  const [source, setSource] = useState<SpotlightCollabOrgSource | null>(
    initialSource ?? null
  );
  const [mode, setMode] = useState<SpotlightCollabOrgMode>(
    initialMode ?? CREATE_MODE
  );
  const [orgName, setOrgName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const title =
    initialMode === CREATE_MODE
      ? t("common:selectors.spotlight.actions.createOrganization.label")
      : initialMode === JOIN_MODE
        ? t("common:selectors.spotlight.actions.joinOrganization.label")
        : t("navigation:collaboration.addOrg");
  const path = useMemo<PathSegment[]>(
    () => [
      {
        type: "action",
        id: "add-collab-org",
        label: title,
        icon: ICONS.organization,
        color: "primary",
      },
    ],
    [title]
  );
  const sourceOptions = useMemo<
    SelectionGridOption<SpotlightCollabOrgSource>[]
  >(
    () => [
      {
        key: LOCAL_SOURCE,
        label: t("navigation:collaboration.localOrg"),
        icon: LaptopIcon,
        dataTestId: "create-collab-org-source-local",
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
  const modeOptions = useMemo<SelectionGridOption<SpotlightCollabOrgMode>[]>(
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

  const canSubmit = Boolean(
    !loading &&
    source &&
    (source !== CLOUD_SOURCE || cloudAuth) &&
    (source === LOCAL_SOURCE || mode === CREATE_MODE
      ? orgName.trim()
      : inviteInput.trim())
  );

  const clearGuide = useCallback(() => {
    clearGuideHighlightTarget(GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT);
  }, [clearGuideHighlightTarget]);

  const handleCancel = useCallback(() => {
    clearGuide();
    onCancel();
  }, [clearGuide, onCancel]);

  const handleClear = useCallback(() => {
    setSource(null);
    setMode(CREATE_MODE);
    setOrgName("");
    setInviteInput("");
    setError(null);
    clearGuide();
  }, [clearGuide]);

  const handleCloudSubmit = useCallback(async () => {
    if (mode === CREATE_MODE) {
      const created = await createOrganization(orgName);
      Message.success(t("navigation:cloud.orgManagement.create.createdToast"));
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: created.orgId },
        },
        title: t("navigation:collaboration.manageOrg"),
      });
      return;
    }

    const joined = await joinOrganization(inviteInput);
    Message.success(
      t("navigation:cloud.orgManagement.join.joinedToast", {
        org: joined.name,
      })
    );
  }, [
    createOrganization,
    inviteInput,
    joinOrganization,
    mode,
    openOrganizationTab,
    orgName,
    t,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !source) return;
    setError(null);
    setLoading(true);
    try {
      if (source === LOCAL_SOURCE) {
        await projectApi.createOrg({ name: orgName });
        bumpProjectListRefresh((previous) => previous + 1);
      } else {
        await handleCloudSubmit();
      }
      clearGuide();
      onCompleted();
    } catch (caught) {
      if (
        source === CLOUD_SOURCE &&
        caught instanceof CloudOrgMembershipActionFailure
      ) {
        setError(
          caught.code === "invalid_invite"
            ? t("navigation:cloud.orgManagement.errors.inviteInvalid")
            : caught.code === "session_expired"
              ? t("navigation:cloud.sessionExpired")
              : t("navigation:cloud.orgPanel.loadError")
        );
      } else {
        setError(
          source === CLOUD_SOURCE
            ? cloudManagementErrorMessage(caught, t)
            : caught instanceof Error
              ? caught.message
              : String(caught)
        );
      }
    } finally {
      setLoading(false);
    }
  }, [
    bumpProjectListRefresh,
    canSubmit,
    clearGuide,
    handleCloudSubmit,
    onCompleted,
    orgName,
    source,
    t,
  ]);

  const submitLabel =
    source === LOCAL_SOURCE || mode === CREATE_MODE
      ? t("navigation:collaboration.createOrg")
      : t("navigation:collaboration.joinOrg");
  const showOrgName =
    source !== null && (source === LOCAL_SOURCE || mode === CREATE_MODE);
  const showInvite = source === CLOUD_SOURCE && mode === JOIN_MODE;

  return (
    <div data-testid="collab-org-spotlight">
      <SpotlightSearchBar
        inputRef={hiddenInputRef}
        searchQuery=""
        onSearchQueryChange={() => undefined}
        onKeyDown={() => undefined}
        placeholder=""
        path={path}
        onRemoveSegment={handleCancel}
        hideInput
      />
      <form
        data-testid="collab-org-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <SpotlightFormShell>
          <SpotlightFormBody>
            <div className="flex flex-col gap-4">
              <fieldset className="min-w-0">
                <legend className="mb-2 text-sm text-text-2">
                  {t("navigation:collaboration.orgSource")}
                  <span className="text-danger-6" aria-hidden>
                    *
                  </span>
                </legend>
                <SelectionGrid
                  options={sourceOptions}
                  selected={source}
                  columns={2}
                  cardVariant="subtle"
                  compactCards
                  onSelect={(nextSource) => {
                    setSource(nextSource);
                    setError(null);
                  }}
                />
              </fieldset>

              {source === CLOUD_SOURCE ? (
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-sm text-text-2">
                    {t("navigation:collaboration.setupMode")}
                  </legend>
                  <SelectionGrid
                    options={modeOptions}
                    selected={mode}
                    columns={2}
                    cardVariant="subtle"
                    compactCards
                    onSelect={(nextMode) => {
                      setMode(nextMode);
                      setError(null);
                    }}
                  />
                </fieldset>
              ) : null}

              {source === CLOUD_SOURCE && !cloudAuth ? (
                <InlineAlert
                  type="info"
                  action={{
                    label: t("navigation:cloud.signIn"),
                    onClick: openCloudSignIn,
                  }}
                  dataTestId="create-cloud-org-sign-in-hint"
                >
                  {t("navigation:cloud.orgManagement.create.signInFirst")}
                </InlineAlert>
              ) : null}

              {showOrgName ? (
                <label className="flex flex-col gap-2 text-sm text-text-2">
                  <span>
                    {t("navigation:collaboration.orgName")}
                    <span className="text-danger-6" aria-hidden>
                      *
                    </span>
                  </span>
                  <div
                    className="w-full"
                    data-guide-target={GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT}
                  >
                    <Input
                      data-testid="create-collab-org-name"
                      aria-label={t("navigation:collaboration.orgName")}
                      value={orgName}
                      onChange={setOrgName}
                      placeholder={t(
                        "navigation:collaboration.orgNamePlaceholder"
                      )}
                      autoFocus
                      required
                    />
                  </div>
                </label>
              ) : null}

              {showInvite ? (
                <label className="flex flex-col gap-2 text-sm text-text-2">
                  <span>
                    {t("navigation:collaboration.inviteCode")}
                    <span className="text-danger-6" aria-hidden>
                      *
                    </span>
                  </span>
                  <Input
                    data-testid="create-collab-org-invite"
                    aria-label={t("navigation:collaboration.inviteCode")}
                    value={inviteInput}
                    onChange={setInviteInput}
                    placeholder={t(
                      "navigation:collaboration.inviteCodePlaceholder"
                    )}
                    autoFocus
                    required
                  />
                </label>
              ) : null}

              {error ? (
                <InlineAlert
                  type="danger"
                  role="alert"
                  dataTestId="create-collab-org-error"
                >
                  {error}
                </InlineAlert>
              ) : null}
            </div>
          </SpotlightFormBody>
          <PanelFooter
            secondaryActions={[
              {
                label: t("common:actions.clear"),
                onClick: handleClear,
                disabled: loading,
                htmlType: "button",
              },
            ]}
            primaryAction={{
              label: submitLabel,
              disabled: !canSubmit,
              loading,
              htmlType: "submit",
              dataTestId: "create-collab-org-submit",
            }}
          />
        </SpotlightFormShell>
      </form>
    </div>
  );
};

export default CollabOrgForm;
