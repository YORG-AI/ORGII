import { GitPullRequest, Loader2, SquareArrowOutUpRight } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import PrStatusBadge from "@src/components/PrStatusBadge";

import type { PrCreationState, PrSectionProps } from "./types";

const PrSection: React.FC<PrSectionProps> = ({
  prUrl,
  prStatus,
  branch,
  phase,
  autoCreatePr,
  onCreatePr,
}) => {
  const { t } = useTranslation("projects");
  const [prState, setPrState] = useState<PrCreationState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const autoTriggeredRef = useRef(false);

  const isRunning = phase === "sde" || phase === "review";
  const isFinished = phase === "completed" || phase === "failed";
  const readyToCreate = isFinished && !!branch && !prUrl;

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

  if (prUrl) {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-6 hover:underline"
            >
              <SquareArrowOutUpRight size={13} />
              {prUrl.replace(/^https?:\/\/[^/]+\//, "")}
            </a>
            <div className="mt-1 flex items-center gap-2">
              {prStatus && (
                <PrStatusBadge
                  status={prStatus}
                  label={t(
                    `workItems.outputTab.pr${prStatus.charAt(0).toUpperCase()}${prStatus.slice(1)}` as never,
                    {
                      defaultValue: prStatus,
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
    );
  }

  if (prState === "creating") {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-primary-6" />
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
            icon={<GitPullRequest size={13} />}
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
