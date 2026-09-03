import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AgentOrgFinalSummaryReceipt,
  retryAgentOrgFinalSummary,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { createLogger } from "@src/hooks/logger";
import { Alert01Icon, HugeiconsIcon } from "@src/icons";

const logger = createLogger("AgentOrgFinalSummaryCard");

function createRetryRequestId(_receiptIdentity: string): string {
  return crypto.randomUUID();
}

interface AgentOrgFinalSummaryCardProps {
  receipt: AgentOrgFinalSummaryReceipt;
  sessionId: string;
  onRetried: () => Promise<void>;
}

const AgentOrgFinalSummaryCard: React.FC<AgentOrgFinalSummaryCardProps> = memo(
  ({ receipt, sessionId, onRetried }) => {
    const { t } = useTranslation("sessions");
    const [retrying, setRetrying] = useState(false);
    const [error, setError] = useState(false);
    const receiptIdentity = `${receipt.certificateId}:${receipt.attempt}`;
    const retryRequestId = useMemo(
      () => createRetryRequestId(receiptIdentity),
      [receiptIdentity]
    );

    const handleRetry = useCallback(async () => {
      if (!receipt.canRetry || retrying) return;
      setRetrying(true);
      setError(false);
      try {
        await retryAgentOrgFinalSummary({
          sessionId,
          certificateId: receipt.certificateId,
          failedAttempt: receipt.attempt,
          requestId: retryRequestId,
        });
        await onRetried();
      } catch (nextError: unknown) {
        logger.error("Failed to retry the Agent Org final report:", nextError);
        setError(true);
      } finally {
        setRetrying(false);
      }
    }, [onRetried, receipt, retrying, retryRequestId, sessionId]);

    return (
      <div
        className="rounded-md border border-warning-6/30 bg-warning-6/5 p-3"
        data-testid="agent-org-final-summary-failed"
        data-summary-attempt={receipt.attempt}
        data-certificate-id={receipt.certificateId}
      >
        <div className="flex items-start gap-2">
          <HugeiconsIcon
            icon={Alert01Icon}
            data-icon="alert"
            className="mt-0.5 shrink-0 text-warning-6"
            size={14}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text-1">
              {t("planner.agentOrgOverview.finalSummary.failedTitle", {
                defaultValue: "Final report was not saved",
              })}
            </div>
            <div className="mt-1 text-[11px] text-text-3">
              {t("planner.agentOrgOverview.finalSummary.evidencePreserved", {
                defaultValue:
                  "The completion evidence and Task outputs are preserved.",
              })}
            </div>
          </div>
        </div>
        {error ? (
          <div className="text-error-6 mt-2 text-xs" role="alert">
            {t("planner.agentOrgOverview.finalSummary.retryFailed", {
              defaultValue: "The final report retry could not be started.",
            })}
          </div>
        ) : null}
        {receipt.canRetry ? (
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              size="mini"
              loading={retrying}
              disabled={retrying}
              onClick={() => void handleRetry()}
              data-testid="agent-org-final-summary-retry"
            >
              {t("planner.agentOrgOverview.finalSummary.retry", {
                defaultValue: "Retry final report",
              })}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
);

AgentOrgFinalSummaryCard.displayName = "AgentOrgFinalSummaryCard";

export default AgentOrgFinalSummaryCard;
