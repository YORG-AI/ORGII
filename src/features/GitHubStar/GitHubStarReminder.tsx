import { useAtom, useAtomValue } from "jotai";
import { ExternalLink, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import Button from "@src/components/Button";
import { ROUTES } from "@src/config/routes";
import Modal from "@src/scaffold/ModalSystem";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";

import {
  deferGitHubStarPrompt,
  githubStarPromptSettingsAtom,
  isGitHubStarPromptEligible,
} from "./promptSettings";
import { useGitHubStarController } from "./useGitHubStarController";

export const GITHUB_STAR_VALUE_MOMENT_EVENT = "orgii:github-star-value-moment";
const GITHUB_STAR_PENDING_VALUE_COUNT_KEY =
  "orgii.githubStar.pendingValueCount";

export function canConsumeGitHubStarValueMoment(pathname: string): boolean {
  return pathname !== ROUTES.auth.setup.path;
}

export function signalGitHubStarValueMoment(valueCount = 1): void {
  const normalizedValueCount = Math.max(1, Math.floor(valueCount));
  sessionStorage.setItem(
    GITHUB_STAR_PENDING_VALUE_COUNT_KEY,
    String(normalizedValueCount)
  );
  window.dispatchEvent(
    new CustomEvent(GITHUB_STAR_VALUE_MOMENT_EVENT, {
      detail: { valueCount: normalizedValueCount },
    })
  );
}

interface GitHubStarReminderDialogProps {
  onClose: () => void;
  onCompleted: () => void;
  onDisable: () => void;
  onLater: () => void;
}

function GitHubStarReminderDialog({
  onClose,
  onCompleted,
  onDisable,
  onLater,
}: GitHubStarReminderDialogProps) {
  const { t } = useTranslation("settings");
  const { state, confirmStar, openFallback } = useGitHubStarController({
    source: "reminder",
    onConfirmedStarred: onCompleted,
  });
  const isBusy = state.status === "loading" || state.status === "starring";
  const needsBrowser = state.status === "web-fallback";

  return (
    <Modal
      visible
      title={t("general.githubStar.reminderTitle")}
      width={420}
      onCancel={onClose}
      footerTopBorder={false}
      footer={
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2">
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            disabled={isBusy}
            onClick={onDisable}
          >
            {t("general.githubStar.neverAskAgain")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={isBusy}
              onClick={onLater}
            >
              {t("general.githubStar.later")}
            </Button>
            <Button
              variant="primary"
              size="small"
              loading={isBusy}
              disabled={isBusy}
              icon={
                needsBrowser ? (
                  <ExternalLink size={14} aria-hidden="true" />
                ) : (
                  <Star size={14} aria-hidden="true" />
                )
              }
              onClick={() =>
                void (needsBrowser ? openFallback() : confirmStar())
              }
            >
              {needsBrowser
                ? t("general.githubStar.openGitHub")
                : t("general.githubStar.star")}
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm leading-5 text-text-3">
        {t("general.githubStar.reminderDescription")}
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {state.status}
      </span>
    </Modal>
  );
}

export function GitHubStarReminderHost() {
  const { pathname } = useLocation();
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const [settings, updateSettings] = useAtom(githubStarPromptSettingsAtom);
  const settingsRef = useRef(settings);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!settingsLoaded || !canConsumeGitHubStarValueMoment(pathname)) return;

    const showIfEligible = (valueCount: number) => {
      const now = Date.now();
      if (!isGitHubStarPromptEligible(settingsRef.current, now, valueCount)) {
        return;
      }
      sessionStorage.removeItem(GITHUB_STAR_PENDING_VALUE_COUNT_KEY);
      updateSettings({ lastShownAt: now });
      setVisible(true);
    };

    const pendingValueCount = Number(
      sessionStorage.getItem(GITHUB_STAR_PENDING_VALUE_COUNT_KEY)
    );
    if (Number.isFinite(pendingValueCount) && pendingValueCount > 0) {
      showIfEligible(pendingValueCount);
    }

    const handleValueMoment = (event: Event) => {
      const valueCount =
        event instanceof CustomEvent &&
        typeof event.detail?.valueCount === "number"
          ? event.detail.valueCount
          : 1;
      showIfEligible(valueCount);
    };

    window.addEventListener(GITHUB_STAR_VALUE_MOMENT_EVENT, handleValueMoment);
    return () =>
      window.removeEventListener(
        GITHUB_STAR_VALUE_MOMENT_EVENT,
        handleValueMoment
      );
  }, [pathname, settingsLoaded, updateSettings]);

  const complete = useCallback(() => {
    sessionStorage.removeItem(GITHUB_STAR_PENDING_VALUE_COUNT_KEY);
    updateSettings({ completed: true, deferredUntil: 0 });
    setVisible(false);
  }, [updateSettings]);

  const disable = useCallback(() => {
    sessionStorage.removeItem(GITHUB_STAR_PENDING_VALUE_COUNT_KEY);
    updateSettings({ disabled: true });
    setVisible(false);
  }, [updateSettings]);

  const later = useCallback(() => {
    sessionStorage.removeItem(GITHUB_STAR_PENDING_VALUE_COUNT_KEY);
    updateSettings(deferGitHubStarPrompt(settingsRef.current));
    setVisible(false);
  }, [updateSettings]);

  if (!visible) return null;

  return (
    <GitHubStarReminderDialog
      onClose={later}
      onCompleted={complete}
      onDisable={disable}
      onLater={later}
    />
  );
}
