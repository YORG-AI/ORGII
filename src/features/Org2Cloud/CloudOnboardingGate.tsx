import { atom, useAtomValue } from "jotai";
import { Cloud, LockKeyhole, RefreshCw, UsersRound } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { identitySnapshotAtom } from "@src/features/Identity/identitySnapshotAtom";
import { usePersistedState } from "@src/hooks/storage/usePersistedState";

import {
  ORG2_CLOUD_ONBOARDING_STORAGE_KEY,
  ORG2_CLOUD_ONBOARDING_VERSION,
  isOrg2CloudOnboardingAcknowledged,
} from "./cloudOnboardingPreference";

interface CloudOnboardingGateProps {
  onConnect: () => void | boolean | Promise<void | boolean>;
  onContinueLocally?: () => void;
  isSigningIn?: boolean;
  /** Business intents start compact and let the user opt into the overview. */
  contextual?: boolean;
}

const VALUE_ITEMS = [
  { key: "sync", icon: RefreshCw },
  { key: "collaboration", icon: UsersRound },
  { key: "security", icon: LockKeyhole },
] as const;

/** Narrow projection: unrelated identity realms must not rerender every gate. */
const org2CloudSignInActiveAtom = atom((get) =>
  get(identitySnapshotAtom).flows.some(
    (flow) => flow.realm === "org2_cloud" && flow.phase !== "failed"
  )
);

/**
 * The shared local-first boundary for every signed-out ORG2 Cloud surface.
 * It introduces Cloud once, then becomes a compact contextual login block.
 */
export const CloudOnboardingGate: React.FC<CloudOnboardingGateProps> = ({
  onConnect,
  onContinueLocally,
  isSigningIn = false,
  contextual = false,
}) => {
  const { t } = useTranslation("navigation");
  const hasActiveBrokerFlow = useAtomValue(org2CloudSignInActiveAtom);
  const [storedVersion, setStoredVersion] = usePersistedState<unknown>(
    ORG2_CLOUD_ONBOARDING_STORAGE_KEY,
    0,
    { listener: true }
  );
  const [sessionAcknowledged, setSessionAcknowledged] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [isOpeningBrowser, setIsOpeningBrowser] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const connectInFlightRef = useRef(false);

  const connecting = isSigningIn || isOpeningBrowser || hasActiveBrokerFlow;
  const acknowledged =
    sessionAcknowledged || isOrg2CloudOnboardingAcknowledged(storedVersion);
  const expanded = (!acknowledged && !contextual) || showDetails;

  const acknowledge = useCallback(() => {
    setSessionAcknowledged(true);
    setStoredVersion(ORG2_CLOUD_ONBOARDING_VERSION);
  }, [setStoredVersion]);

  const handleContinueLocally = useCallback(() => {
    acknowledge();
    setShowDetails(false);
    setOpenFailed(false);
    onContinueLocally?.();
  }, [acknowledge, onContinueLocally]);

  const handleConnect = useCallback(async () => {
    if (connectInFlightRef.current || connecting) return;
    connectInFlightRef.current = true;
    acknowledge();
    setOpenFailed(false);
    setIsOpeningBrowser(true);
    try {
      const opened = await onConnect();
      if (opened === false) setOpenFailed(true);
    } catch {
      setOpenFailed(true);
    } finally {
      connectInFlightRef.current = false;
      setIsOpeningBrowser(false);
    }
  }, [acknowledge, connecting, onConnect]);

  if (!expanded) {
    return (
      <div
        className="w-full rounded-lg border border-border-1 bg-bg-2 p-4"
        data-testid="org2-cloud-auth-block"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-1 text-primary-6">
            <Cloud size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-1">
              {connecting
                ? t("cloud.onboarding.waitingTitle")
                : t("cloud.onboarding.blockedTitle")}
            </div>
            <p
              className="mt-1 text-xs leading-5 text-text-3"
              role={connecting ? "status" : undefined}
              aria-live={connecting ? "polite" : undefined}
            >
              {connecting
                ? t("cloud.onboarding.waitingDescription")
                : t("cloud.onboarding.blockedDescription")}
            </p>
            {openFailed ? (
              <p
                className="mt-2 text-xs text-danger-6"
                role="alert"
                data-testid="org2-cloud-sign-in-error"
              >
                {t("cloud.onboarding.openFailed")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {onContinueLocally ? (
            <Button
              size="small"
              variant="secondary"
              onClick={onContinueLocally}
              data-testid="org2-cloud-back-to-local"
            >
              {t("cloud.onboarding.backToLocal")}
            </Button>
          ) : null}
          <Button
            size="small"
            variant="tertiary"
            appearance="ghost"
            disabled={connecting}
            onClick={() => setShowDetails(true)}
            data-testid="org2-cloud-learn-more"
          >
            {t("cloud.onboarding.learnMore")}
          </Button>
          <Button
            size="small"
            variant="primary"
            loading={connecting}
            disabled={connecting}
            onClick={() => void handleConnect()}
            data-testid="org2-cloud-sign-in"
          >
            {t("cloud.signIn")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full rounded-lg border border-border-1 bg-bg-2 p-4"
      data-testid="org2-cloud-onboarding"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-1 text-primary-6">
          <Cloud size={20} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-1">
            {t("cloud.onboarding.title")}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-3">
            {t("cloud.onboarding.description")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {VALUE_ITEMS.map(({ key, icon: Icon }) => (
          <div key={key} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fill-2 text-text-2">
              <Icon size={14} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-text-1">
                {t(`cloud.onboarding.values.${key}.title`)}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-text-3">
                {t(`cloud.onboarding.values.${key}.description`)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {openFailed ? (
        <p
          className="mt-3 text-xs text-danger-6"
          role="alert"
          data-testid="org2-cloud-sign-in-error"
        >
          {t("cloud.onboarding.openFailed")}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="small"
          variant="secondary"
          onClick={handleContinueLocally}
          data-testid="org2-cloud-continue-local"
        >
          {t("cloud.onboarding.continueLocally")}
        </Button>
        <Button
          size="small"
          variant="primary"
          loading={connecting}
          disabled={connecting}
          onClick={() => void handleConnect()}
          data-testid="org2-cloud-connect"
        >
          {t("cloud.onboarding.connect")}
        </Button>
      </div>
    </div>
  );
};

export default CloudOnboardingGate;
