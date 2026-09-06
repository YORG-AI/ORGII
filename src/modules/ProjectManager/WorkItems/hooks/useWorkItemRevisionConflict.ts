import {
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { parseRevisionConflict } from "@src/api/http/project";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";

const logger = createLogger("useWorkItemRevisionConflict");

export interface WorkItemTextRevisionConflictState {
  field: "title" | "description";
  mine: string;
  latest: string;
  expectedRevision: number;
  actualRevision: number;
}

type TextUpdates = {
  name?: string;
  spec?: string;
};

interface PendingConflict<TAttempt> extends WorkItemTextRevisionConflictState {
  identityKey: string;
  attempt: TAttempt;
}

interface ConflictHookState<TAttempt> {
  identityKey: string;
  pending: PendingConflict<TAttempt> | null;
}

interface WorkItemRevisionConflictOptions<
  TAttempt extends TextUpdates,
  TRecord,
> {
  /** Clears an open conflict when the surface starts representing another item. */
  identityKey: string;
  readLatest: (attempt: TAttempt) => Promise<TRecord | null>;
  retry: (attempt: TAttempt, actualRevision: number) => Promise<TRecord>;
  acceptRecord: (record: TRecord) => void;
  recordTitle: (record: TRecord) => string;
  recordDescription: (record: TRecord) => string;
  recordRevision: (record: TRecord) => number | undefined;
  onReloadFailure?: () => void | Promise<void>;
  onNonTextConflict?: () => void;
  onRetrySuccess?: (record: TRecord) => void | Promise<void>;
}

/**
 * Single owner for the Work Item text-edit CAS conflict lifecycle.
 *
 * Surfaces provide only their read/write projection. Detection, latest-row
 * reload, use-latest dismissal, keep-mine retry, and a second-CAS refresh all
 * follow the same state machine here.
 */
export function useWorkItemRevisionConflict<
  TAttempt extends TextUpdates,
  TRecord,
>({
  identityKey,
  readLatest,
  retry,
  acceptRecord,
  recordTitle,
  recordDescription,
  recordRevision,
  onReloadFailure,
  onNonTextConflict,
  onRetrySuccess,
}: WorkItemRevisionConflictOptions<TAttempt, TRecord>) {
  const { t } = useTranslation("projects");
  const [state, setState] = useState<ConflictHookState<TAttempt>>({
    identityKey,
    pending: null,
  });
  if (state.identityKey !== identityKey) {
    setState({ identityKey, pending: null });
  }
  const pending = state.identityKey === identityKey ? state.pending : null;
  const setPending = useCallback(
    (update: SetStateAction<PendingConflict<TAttempt> | null>): void => {
      setState((current) => {
        if (current.identityKey !== identityKey) return current;
        const next =
          typeof update === "function" ? update(current.pending) : update;
        return { ...current, pending: next };
      });
    },
    [identityKey]
  );
  const identityRef = useRef(identityKey);
  const operationGenerationRef = useRef(0);

  useLayoutEffect(() => {
    identityRef.current = identityKey;
    operationGenerationRef.current += 1;
  }, [identityKey]);

  const loadLatest = useCallback(
    async (attempt: TAttempt): Promise<TRecord | null> => {
      try {
        const latest = await readLatest(attempt);
        if (!latest) await onReloadFailure?.();
        return latest;
      } catch (error) {
        logger.error("Failed to reload conflicted Work Item", error);
        Message.error(String(error));
        await onReloadFailure?.();
        return null;
      }
    },
    [onReloadFailure, readLatest]
  );

  const handleRevisionConflict = useCallback(
    async (error: unknown, attempt: TAttempt): Promise<boolean> => {
      const details = parseRevisionConflict(error);
      if (!details) return false;

      const operationGeneration = operationGenerationRef.current + 1;
      operationGenerationRef.current = operationGeneration;
      const operationIdentity = identityRef.current;
      const latest = await loadLatest(attempt);
      if (
        !latest ||
        operationGenerationRef.current !== operationGeneration ||
        identityRef.current !== operationIdentity
      ) {
        return true;
      }

      acceptRecord(latest);
      const field =
        attempt.name !== undefined
          ? "title"
          : attempt.spec !== undefined
            ? "description"
            : null;
      if (!field) {
        onNonTextConflict?.();
        Message.warning(t("workItems.revisionConflict.reloadNotice"), 5000);
        return true;
      }

      setPending({
        identityKey: operationIdentity,
        attempt,
        field,
        mine: field === "title" ? (attempt.name ?? "") : (attempt.spec ?? ""),
        latest:
          field === "title" ? recordTitle(latest) : recordDescription(latest),
        expectedRevision: details.expected,
        actualRevision: recordRevision(latest) ?? details.actual,
      });
      return true;
    },
    [
      acceptRecord,
      loadLatest,
      onNonTextConflict,
      recordDescription,
      recordRevision,
      recordTitle,
      setPending,
      t,
    ]
  );

  const useLatest = useCallback(() => {
    operationGenerationRef.current += 1;
    setPending(null);
  }, [setPending]);

  const keepMine = useCallback(async () => {
    const conflict = pending?.identityKey === identityKey ? pending : null;
    if (!conflict) return;
    const operationGeneration = operationGenerationRef.current + 1;
    operationGenerationRef.current = operationGeneration;
    const operationIdentity = identityRef.current;
    try {
      const updated = await retry(conflict.attempt, conflict.actualRevision);
      if (
        operationGenerationRef.current !== operationGeneration ||
        identityRef.current !== operationIdentity
      ) {
        return;
      }
      acceptRecord(updated);
      setPending(null);
      await onRetrySuccess?.(updated);
    } catch (error) {
      const details = parseRevisionConflict(error);
      if (!details) {
        logger.error("Failed to retry conflicted Work Item edit", error);
        Message.error(String(error));
        return;
      }
      const latest = await loadLatest(conflict.attempt);
      if (
        !latest ||
        operationGenerationRef.current !== operationGeneration ||
        identityRef.current !== operationIdentity
      ) {
        return;
      }
      acceptRecord(latest);
      setPending((current) =>
        current?.identityKey === operationIdentity &&
        current.attempt === conflict.attempt
          ? {
              ...current,
              latest:
                current.field === "title"
                  ? recordTitle(latest)
                  : recordDescription(latest),
              expectedRevision: details.expected,
              actualRevision: recordRevision(latest) ?? details.actual,
            }
          : current
      );
      Message.warning(t("workItems.revisionConflict.retryFailed"), 5000);
    }
  }, [
    acceptRecord,
    identityKey,
    loadLatest,
    onRetrySuccess,
    pending,
    recordDescription,
    recordRevision,
    recordTitle,
    retry,
    setPending,
    t,
  ]);

  return {
    revisionConflict:
      pending?.identityKey === identityKey
        ? ({
            field: pending.field,
            mine: pending.mine,
            latest: pending.latest,
            expectedRevision: pending.expectedRevision,
            actualRevision: pending.actualRevision,
          } satisfies WorkItemTextRevisionConflictState)
        : null,
    handleRevisionConflict,
    useLatestRevisionConflict: useLatest,
    keepMineRevisionConflict: keepMine,
  };
}
