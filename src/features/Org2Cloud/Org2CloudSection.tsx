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
import { Pencil } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { IdentityAccountStatus } from "@src/features/Identity/AccountCenter/IdentityAccountStatus";
import { signOutIdentity } from "@src/features/Identity/identityLifecycle";
import {
  useActiveIdentitySession,
  useIdentitySnapshot,
} from "@src/features/Identity/useIdentitySnapshot";
import CloudEndpointCard from "@src/features/Org2Cloud/CloudEndpointCard";
import CloudOnboardingGate from "@src/features/Org2Cloud/CloudOnboardingGate";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  ensureFreshSession,
  updateCloudProfileDisplayName,
} from "@src/features/Org2Cloud/org2CloudClient";
import { resetOrgEntitlementCoordinator } from "@src/features/Org2Cloud/org2CloudEntitlementCoordinator";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { createLogger } from "@src/hooks/logger";

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
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);
  const store = useStore();
  const identitySnapshot = useIdentitySnapshot();
  const brokerSession = useActiveIdentitySession("org2_cloud");
  const activeCloudFlow = identitySnapshot.flows.find(
    (flow) => flow.realm === "org2_cloud" && flow.phase !== "failed"
  );
  const displayedBrokerSession =
    brokerSession &&
    (!auth ||
      (brokerSession.subject === auth.userId &&
        brokerSession.issuer.replace(/\/+$/, "") ===
          auth.supabaseUrl.replace(/\/+$/, "")))
      ? brokerSession
      : null;
  const signedInIdentity =
    displayedBrokerSession?.displayName ??
    displayedBrokerSession?.primaryEmail ??
    auth?.profile?.displayName ??
    auth?.profile?.primaryEmail ??
    displayedBrokerSession?.subject ??
    auth?.userId ??
    "";
  const showSignInGate = !auth && !displayedBrokerSession;

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

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      if (brokerSession) {
        await signOutIdentity("org2_cloud", brokerSession);
      }
      resetOrgEntitlementCoordinator(store);
      setAuth(null);
    } catch (error: unknown) {
      log.error("failed to sign out of the identity Broker", error);
      Message.error(t("common:errors.unknownError"));
    } finally {
      setIsSigningOut(false);
    }
  }, [brokerSession, isSigningOut, setAuth, store, t]);

  if (activeTab === COLLABORATION_TAB_KEYS.SELF_HOSTED) {
    return <CloudEndpointCard />;
  }

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={
            <span className="flex items-center gap-2">
              <span>{t("cloud.title")}</span>
              <span className="rounded-full bg-primary-1 px-2 py-0.5 text-[11px] font-medium text-primary-6">
                {t("cloud.recommendedBadge")}
              </span>
            </span>
          }
          description={t("cloud.recommendedDesc")}
          align="start"
          layout={showSignInGate ? "vertical" : "horizontal"}
        >
          <div
            className={showSignInGate ? "w-full" : SECTION_ACTION_GAP_CLASSES}
          >
            {auth &&
            brokerSession?.status !== "reauth_required" &&
            renameDraft !== null ? (
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
                  loading={isSavingRename}
                  disabled={isSavingRename || !(renameDraft ?? "").trim()}
                  onClick={() => void handleSaveRename()}
                  data-testid="org2-cloud-rename-save"
                >
                  {t("common:actions.save")}
                </Button>
                <Button
                  size="default"
                  disabled={isSavingRename}
                  onClick={() => setRenameDraft(null)}
                  data-testid="org2-cloud-rename-cancel"
                >
                  {t("common:actions.cancel")}
                </Button>
              </div>
            ) : auth || displayedBrokerSession ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {displayedBrokerSession ? (
                  <IdentityAccountStatus
                    identityLabel={signedInIdentity}
                    session={displayedBrokerSession}
                    secureStoreStatus={identitySnapshot.secureStoreStatus}
                  />
                ) : (
                  <span
                    className="max-w-56 truncate text-sm text-text-2"
                    data-testid="org2-cloud-signed-in-identity"
                    title={signedInIdentity}
                    data-identity-source="legacy"
                  >
                    {t("cloud.signedInAs", { name: signedInIdentity })}
                  </span>
                )}
                {auth && brokerSession?.status !== "reauth_required" && (
                  <Button
                    size="default"
                    iconOnly
                    icon={<Pencil size={14} />}
                    aria-label={t("cloud.renameDisplayName")}
                    onClick={() =>
                      setRenameDraft(auth.profile?.displayName ?? "")
                    }
                    data-testid="org2-cloud-rename"
                  />
                )}
                <Button
                  size="default"
                  loading={Boolean(activeCloudFlow)}
                  loadingSpinIcon
                  disabled={Boolean(activeCloudFlow)}
                  onClick={handleSignIn}
                  data-testid={
                    brokerSession?.status === "reauth_required"
                      ? "org2-cloud-reconnect"
                      : "org2-cloud-switch-account"
                  }
                >
                  {brokerSession?.status === "reauth_required"
                    ? t("cloud.accountCenter.reconnect")
                    : t("cloud.accountCenter.switchAccount")}
                </Button>
                <Button
                  size="default"
                  loading={isSigningOut}
                  disabled={isSigningOut}
                  onClick={() => void handleSignOut()}
                  data-testid="org2-cloud-sign-out"
                >
                  {t("cloud.signOut")}
                </Button>
              </div>
            ) : (
              <CloudOnboardingGate
                onConnect={handleSignIn}
                isSigningIn={Boolean(activeCloudFlow)}
              />
            )}
          </div>
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default Org2CloudSection;
