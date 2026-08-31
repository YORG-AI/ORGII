import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type PrReadiness,
  type PrStatus,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import PrStatusBadge from "@src/components/PrStatusBadge";
import {
  GitPullRequestIcon,
  HugeiconsIcon,
  Loading03Icon,
  SquareArrowUpRight02Icon,
} from "@src/icons";

import type { PrCreationState, PrSectionProps } from "./types";

const PrSection: React.FC<PrSectionProps> = ({
  prUrl,
  prStatus,
  branch,
  phase,
  autoCreatePr,
  onCreatePr,
  projectSlug,
  orgId,
  shortId,
}) => {
  const { t } = useTranslation("projects");
  const [prState, setPrState] = useState<PrCreationState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const readinessKey = `${projectSlug ?? "standalone"}:${orgId ?? "personal-org"}:${shortId ?? "none"}`;
  const [readinessState, setReadinessState] = useState<{
    key: string;
    value: PrReadiness | null;
  } | null>(null);
  const readiness =
    readinessState?.key === readinessKey ? readinessState.value : null;
  const autoTriggeredRef = useRef(false);

  const isRunning = phase === "sde" || phase === "review";
  const isFinished = phase === "completed" || phase === "failed";
  const readyToCreate = isFinished && !!branch && !prUrl;

  useEffect(() => {
    if (!shortId) {
      return;
    }
    let cancelled = false;
    projectApi
      .getWorkItemPrReadiness({
        projectSlug: projectSlug ?? null,
        orgId: orgId || "personal-org",
        workItemId: shortId,
      })
      .then((result) => {
        if (!cancelled) setReadinessState({ key: readinessKey, value: result });
      })
      .catch(() => {
        if (!cancelled) setReadinessState({ key: readinessKey, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [
    branch,
    orgId,
    phase,
    prStatus,
    prUrl,
    projectSlug,
    readinessKey,
    shortId,
  ]);

  const displayPrUrl = prUrl ?? readiness?.prUrl ?? undefined;
  const displayPrStatus = prStatus ?? readiness?.prStatus ?? undefined;
  const readinessAlert =
    readiness && readiness.prUrl ? (
      <InlineAlert
        type={readiness.canComplete ? "success" : "warning"}
        title={
          readiness.canComplete
            ? t("workItems.outputTab.prReady", {
                defaultValue: "Ready to complete",
              })
            : t("workItems.outputTab.prBlocked", {
                defaultValue: "Completion is blocked",
              })
        }
      >
        {readiness.blockers.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {readiness.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs">
            Merge state, checks, execution snapshot, and close intent are
            verified.
          </p>
        )}
      </InlineAlert>
    ) : null;

  const handleCreate = useCallback(async () => {
    if (!onCreatePr) return;
    setPrState("creating");
    setErrorMessage(null);
    const result = await onCreatePr();
    if (result.error) {
      setPrState("error");
      setErrorMessage(result.error);
    }
  }, [onCreatePr]);

  useEffect(() => {
    if (
      readyToCreate &&
      autoCreatePr &&
      !autoTriggeredRef.current &&
      onCreatePr
    ) {
      autoTriggeredRef.current = true;
      const timer = setTimeout(() => {
        handleCreate();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [readyToCreate, autoCreatePr, onCreatePr, handleCreate]);

  useEffect(() => {
    if (!readyToCreate) {
      autoTriggeredRef.current = false;
    }
  }, [readyToCreate]);

  if (displayPrUrl) {
    return (
      <div className="flex flex-col gap-2">
        <div className="rounded-lg bg-fill-2 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <a
                href={displayPrUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-6 hover:underline"
              >
                <HugeiconsIcon
                  icon={SquareArrowUpRight02Icon}
                  data-icon="square-arrow-out-up-right"
                  size={13}
                />
                {displayPrUrl.replace(/^https?:\/\/[^/]+\//, "")}
              </a>
              <div className="mt-1 flex items-center gap-2">
                {displayPrStatus && (
                  <PrStatusBadge
                    status={displayPrStatus as PrStatus}
                    label={t(
                      `workItems.outputTab.pr${displayPrStatus.charAt(0).toUpperCase()}${displayPrStatus.slice(1)}` as never,
                      {
                        defaultValue: displayPrStatus,
                      }
                    )}
                  />
                )}
                {branch && (
                  <code className="text-[11px] text-text-3">{branch}</code>
                )}
              </div>
            </div>
          </div>
        </div>
        {readinessAlert}
      </div>
    );
  }

  if (prState === "creating") {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={Loading03Icon}
            data-icon="loader-2"
            size={14}
            className="animate-spin text-primary-6"
          />
          <p className="text-sm text-text-2">
            {t("workItems.outputTab.prCreatingHint")}
          </p>
        </div>
        {branch && (
          <div className="mt-1.5">
            <code className="text-[11px] text-text-3">{branch}</code>
          </div>
        )}
      </div>
    );
  }

  if (prState === "error") {
    return (
      <InlineAlert
        type="danger"
        title={t("workItems.outputTab.prCreateError")}
        action={{
          label: t("common:actions.retry"),
          onClick: handleCreate,
        }}
      >
        {errorMessage && <p className="text-[13px]">{errorMessage}</p>}
        {branch && (
          <code className="mt-1 block text-[11px] text-text-3">{branch}</code>
        )}
      </InlineAlert>
    );
  }

  if (isRunning) {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-3">
        <p className="text-sm text-text-2">
          {t("workItems.outputTab.prNotAvailable")}
        </p>
        <p className="mt-0.5 text-xs text-text-4">
          {t("workItems.outputTab.prPendingHint")}
        </p>
      </div>
    );
  }

  if (readyToCreate && !autoCreatePr) {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-2">
              {t("workItems.outputTab.prNotAvailable")}
            </p>
            {branch && (
              <div className="mt-1">
                <code className="text-[11px] text-text-3">{branch}</code>
              </div>
            )}
          </div>
          <Button
            variant="primary"
            appearance="outline"
            size="small"
            icon={
              <HugeiconsIcon
                icon={GitPullRequestIcon}
                data-icon="git-pull-request"
                size={13}
              />
            }
            onClick={handleCreate}
            disabled={!onCreatePr}
          >
            {t("workItems.outputTab.prCreateButton")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-fill-2 px-4 py-3">
      <p className="text-sm text-text-2">
        {t("workItems.outputTab.prNotAvailable")}
      </p>
      <p className="mt-0.5 text-xs text-text-4">
        {t("workItems.outputTab.prNeutralHint")}
      </p>
      {branch && (
        <div className="mt-1.5">
          <code className="text-[11px] text-text-3">{branch}</code>
        </div>
      )}
    </div>
  );
};

export default PrSection;
