/**
 * "Session Sync" Settings section (cloud design §20.1 + §4.2).
 *
 * Two tabs:
 *  1. Cloud — ORG2 Cloud (managed) with the existing sign-in /
 *     sign-out control. Sign-in opens the managed cloud login page in the
 *     SYSTEM browser; the login page finishes through an ephemeral localhost
 *     receiver, which the OAuth plugin delivers to useDeepLinkHandler at the
 *     always-mounted app root. Installed-app custom-scheme callbacks remain
 *     supported for cold-start compatibility.
 *  2. Self-hosted — the custom ORG2 Cloud backend card (`CloudEndpointCard`,
 *     cloud-parity Phase C): self-hosting means deploying the SAME stack
 *     and pointing the app at it.
 */
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { useAtom, useStore } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { REFRESH_ICON_TOKENS } from "@src/components/RefreshIcon/tokens";
import CloudEndpointCard from "@src/features/Org2Cloud/CloudEndpointCard";
import { importBundledOrg2CloudAuthForDev } from "@src/features/Org2Cloud/devBundledAuthImport";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  ensureFreshSession,
  updateCloudProfileDisplayName,
} from "@src/features/Org2Cloud/org2CloudClient";
import { resetOrgEntitlementCoordinator } from "@src/features/Org2Cloud/org2CloudEntitlementCoordinator";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { createLogger } from "@src/hooks/logger";
import {
  Cancel01Icon,
  HugeiconsIcon,
  Pen01Icon,
  Refresh04Icon,
  Tick01Icon,
} from "@src/icons";

const log = createLogger("Org2CloudSection");

export const COLLABORATION_TAB_KEYS = {
  CLOUD: "cloud",
  SELF_HOSTED: "self-hosted",
} as const;

interface Org2CloudSectionProps {
  activeTab?: string;
}

const Org2CloudSection: React.FC<Org2CloudSectionProps> = ({
  activeTab = COLLABORATION_TAB_KEYS.CLOUD,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const [isRefreshingDevAuth, setIsRefreshingDevAuth] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);
  const store = useStore();
  const signedInIdentity =
    auth?.profile?.displayName ??
    auth?.profile?.primaryEmail ??
    auth?.userId ??
    "";

  const handleSignIn = useOrg2CloudSignIn();

  const handleSaveRename = useCallback(async () => {
    const trimmed = (renameDraft ?? "").trim();
    if (!auth || !trimmed || trimmed.length > 64 || isSavingRename) return;
    setIsSavingRename(true);
    try {
      const fresh = await ensureFreshSession(auth);
      if (!fresh) {
        Message.error(t("cloud.renameFailed"));
        return;
      }
      commitRefreshedAuth(setAuth, auth, fresh);
      const stored = await updateCloudProfileDisplayName(
        fresh.accessToken,
        trimmed
      );
      if (stored === null) {
        Message.error(t("cloud.renameFailed"));
        return;
      }
      setAuth((current) =>
        current
          ? {
              ...current,
              profile: { ...current.profile, displayName: stored },
            }
          : current
      );
      setRenameDraft(null);
      Message.success(t("cloud.renameSaved"));
    } finally {
      setIsSavingRename(false);
    }
  }, [auth, isSavingRename, renameDraft, setAuth, t]);

  const handleSignOut = useCallback(() => {
    resetOrgEntitlementCoordinator(store);
    setAuth(null);
  }, [setAuth, store]);

  const handleRefreshDevAuth = useCallback(async () => {
    if (isRefreshingDevAuth) return;
    setIsRefreshingDevAuth(true);
    try {
      const bundledAuth = await importBundledOrg2CloudAuthForDev();
      const currentIdentity = auth ? org2CloudAuthIdentityKey(auth) : null;
      const bundledIdentity = bundledAuth
        ? org2CloudAuthIdentityKey(bundledAuth)
        : null;
      if (currentIdentity !== bundledIdentity) {
        resetOrgEntitlementCoordinator(store);
      }
      setAuth(bundledAuth);
      if (bundledAuth) {
        Message.success(t("cloud.signedInToast"));
      } else {
        Message.info(t("common:errors.notFound"));
      }
    } catch (error: unknown) {
      log.error("failed to refresh ORG2 Cloud auth from bundled app", error);
      Message.error(t("common:errors.unknownError"));
    } finally {
      setIsRefreshingDevAuth(false);
    }
  }, [auth, isRefreshingDevAuth, setAuth, store, t]);

  if (activeTab === COLLABORATION_TAB_KEYS.SELF_HOSTED) {
    return <CloudEndpointCard />;
  }

  const refreshDevAuthButton = process.env.NODE_ENV === "development" && (
    <Button
      size="default"
      iconOnly
      icon={
        <HugeiconsIcon
          icon={Refresh04Icon}
          data-icon="refresh-cw"
          size={14}
          className={isRefreshingDevAuth ? REFRESH_ICON_TOKENS.spin : ""}
        />
      }
      loading={isRefreshingDevAuth}
      loadingSpinIcon
      disabled={isRefreshingDevAuth}
      aria-label={t("common:actions.refresh")}
      onClick={handleRefreshDevAuth}
      data-testid="org2-cloud-refresh-dev-auth"
    />
  );

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("cloud.title")}
          description={t("cloud.recommendedDesc")}
          align="start"
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            {auth ? (
              <>
                {refreshDevAuthButton}
                <Button
                  size="default"
                  onClick={handleSignOut}
                  data-testid="org2-cloud-sign-out"
                >
                  {t("cloud.signOut")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="default"
                  onClick={handleSignIn}
                  data-testid="org2-cloud-sign-in"
                >
                  {t("cloud.signIn")}
                </Button>
                {refreshDevAuthButton}
              </>
            )}
          </div>
        </SectionRow>
        {auth && (
          <SectionRow label={t("cloud.userName")}>
            {renameDraft !== null ? (
              <div className="flex items-center gap-2">
                <Input
                  value={renameDraft}
                  onChange={(value) => setRenameDraft(value)}
                  maxLength={64}
                  autoFocus
                  className="w-48"
                  data-testid="org2-cloud-rename-input"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSaveRename();
                    if (event.key === "Escape") setRenameDraft(null);
                  }}
                />
                <Button
                  size="default"
                  iconOnly
                  icon={
                    <HugeiconsIcon
                      icon={Tick01Icon}
                      data-icon="check"
                      size={14}
                    />
                  }
                  loading={isSavingRename}
                  disabled={isSavingRename || !(renameDraft ?? "").trim()}
                  onClick={() => void handleSaveRename()}
                  aria-label={t("common:actions.save")}
                  title={t("common:actions.save")}
                  data-testid="org2-cloud-rename-save"
                />
                <Button
                  size="default"
                  iconOnly
                  icon={
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      data-icon="x"
                      size={14}
                    />
                  }
                  disabled={isSavingRename}
                  onClick={() => setRenameDraft(null)}
                  aria-label={t("common:actions.cancel")}
                  title={t("common:actions.cancel")}
                  data-testid="org2-cloud-rename-cancel"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span
                  className="max-w-56 truncate text-sm text-text-2"
                  data-testid="org2-cloud-signed-in-identity"
                  title={signedInIdentity}
                >
                  {signedInIdentity}
                </span>
                <Button
                  size="default"
                  iconOnly
                  icon={
                    <HugeiconsIcon
                      icon={Pen01Icon}
                      data-icon="pencil"
                      size={14}
                    />
                  }
                  aria-label={t("cloud.renameDisplayName")}
                  onClick={() =>
                    setRenameDraft(auth.profile?.displayName ?? "")
                  }
                  data-testid="org2-cloud-rename"
                />
              </div>
            )}
          </SectionRow>
        )}
      </SectionContainer>
    </>
  );
};

export default Org2CloudSection;
