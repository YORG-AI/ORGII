import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { createLogger } from "@src/hooks/logger";
import {
  Cancel01Icon,
  HugeiconsIcon,
  InboxIcon,
  Link02Icon,
  LinkSquare02Icon,
  RotateLeft01Icon,
} from "@src/icons";
import type { SessionReferenceOpen } from "@src/shared/dnd/sessionTabDrag";
import { useSessionDropTarget } from "@src/shared/dnd/useSessionDropTarget";

import type {
  TeamInboxCreatedWorkItem,
  TeamInboxDataSource,
  TeamInboxNavigationIntent,
  TeamInboxSessionHandoffDraft,
} from "../domain";
import { sessionHandoffPreparationErrorCode } from "../sessionHandoffError";
import {
  type SessionHandoffForm,
  createSessionHandoffForm,
  normalizedSessionHandoffForm,
  sessionHandoffFormError,
} from "../sessionHandoffForm";
import {
  consumeTeamInboxSessionHandoffRequestAtom,
  teamInboxSessionHandoffRequestAtom,
} from "../store";
import SessionHandoffComposer from "./SessionHandoffComposer";

type Operation =
  | { status: "idle" }
  | {
      status: "preparing";
      owner: TeamInboxDataSource;
      reference: SessionReferenceOpen;
    }
  | {
      status: "configuring" | "submitting";
      owner: TeamInboxDataSource;
      reference: SessionReferenceOpen;
      draft: TeamInboxSessionHandoffDraft;
      form: SessionHandoffForm;
      message: string | null;
    }
  | {
      status: "success";
      owner: TeamInboxDataSource;
      reference: SessionReferenceOpen;
      result: TeamInboxCreatedWorkItem;
    }
  | {
      status: "error";
      owner: TeamInboxDataSource;
      reference: SessionReferenceOpen;
      message: string;
    };

const IDLE_OPERATION: Operation = { status: "idle" };
const log = createLogger("TeamInboxSessionDropSurface");

interface TeamInboxSessionDropSurfaceProps {
  dataSource: TeamInboxDataSource;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  children?: React.ReactNode;
}

const TeamInboxSessionDropSurface: React.FC<
  TeamInboxSessionDropSurfaceProps
> = ({ children, dataSource, onNavigate }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const requestedHandoff = useAtomValue(teamInboxSessionHandoffRequestAtom);
  const consumeRequestedHandoff = useSetAtom(
    consumeTeamInboxSessionHandoffRequestAtom
  );
  const [operation, setOperation] = useState<Operation>(IDLE_OPERATION);
  const currentOperation =
    operation.status !== "idle" && operation.owner !== dataSource
      ? IDLE_OPERATION
      : operation;

  const prepare = useCallback(
    (reference: SessionReferenceOpen) => {
      const prepareHandoff = dataSource.prepareSessionHandoff;
      if (!prepareHandoff) return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setOperation({ status: "preparing", owner: dataSource, reference });

      void prepareHandoff({
        sessionId: reference.sessionId,
        title: reference.title,
        signal: controller.signal,
      })
        .then((draft) => {
          if (
            controller.signal.aborted ||
            generationRef.current !== generation
          ) {
            return;
          }
          setOperation({
            status: "configuring",
            owner: dataSource,
            reference,
            draft,
            form: createSessionHandoffForm(draft),
            message: null,
          });
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            generationRef.current !== generation
          ) {
            return;
          }
          setOperation({
            status: "error",
            owner: dataSource,
            reference,
            message: t(
              `teamInbox.handoff.preparationError.${
                sessionHandoffPreparationErrorCode(error) ?? "unknown"
              }`
            ),
          });
        });
    },
    [dataSource, t]
  );

  const drop = useSessionDropTarget({
    containerRef,
    disabled:
      !dataSource.createWorkItemFromSession ||
      !dataSource.prepareSessionHandoff ||
      currentOperation.status === "preparing" ||
      currentOperation.status === "configuring" ||
      currentOperation.status === "submitting",
    onDrop: prepare,
  });

  useEffect(() => {
    if (!requestedHandoff || !dataSource.prepareSessionHandoff) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      consumeRequestedHandoff(requestedHandoff.requestId);
      prepare(requestedHandoff);
    });
    return () => {
      active = false;
    };
  }, [
    consumeRequestedHandoff,
    dataSource.prepareSessionHandoff,
    prepare,
    requestedHandoff,
  ]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
  }, [dataSource]);

  const dismiss = () => {
    generationRef.current += 1;
    abortRef.current?.abort();
    setOperation(IDLE_OPERATION);
  };

  const updateForm = (form: SessionHandoffForm) => {
    if (
      currentOperation.status !== "configuring" &&
      currentOperation.status !== "submitting"
    ) {
      return;
    }
    setOperation({ ...currentOperation, status: "configuring", form });
  };

  const submit = () => {
    if (
      currentOperation.status !== "configuring" ||
      sessionHandoffFormError(currentOperation.form, currentOperation.draft)
    ) {
      return;
    }
    const create = dataSource.createWorkItemFromSession;
    if (!create) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const form = normalizedSessionHandoffForm(currentOperation.form);
    const { draft, reference } = currentOperation;
    setOperation({
      ...currentOperation,
      status: "submitting",
      form,
      message: null,
    });

    void create({
      sessionId: reference.sessionId,
      title: form.title,
      destinationKey: form.destinationKey,
      assigneeMemberId: form.assigneeMemberId,
      status: form.status,
      priority: form.priority,
      targetDate: form.targetDate || undefined,
      handoffNote: form.note || undefined,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        setOperation({
          status: "success",
          owner: dataSource,
          reference,
          result,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || generationRef.current !== generation) {
          return;
        }
        log.error("Session handoff Work Item creation failed", error);
        setOperation({
          status: "configuring",
          owner: dataSource,
          reference,
          draft,
          form,
          message: t("teamInbox.handoff.submitError"),
        });
      });
  };

  const openCreated = () => {
    if (currentOperation.status !== "success") return;
    onNavigate?.({
      kind: "open_work_item",
      orgId: currentOperation.result.orgId,
      projectId: currentOperation.result.projectId,
      workItemId: currentOperation.result.workItemId,
    });
  };

  const showDragOverlay = drop.active;
  const showResult =
    currentOperation.status === "success" ||
    currentOperation.status === "error";

  return (
    <div ref={containerRef} className="relative h-full min-h-0">
      {children}

      {showDragOverlay ? (
        <div
          data-testid="team-inbox-session-drop-zone"
          className={`pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-xl border-2 border-dashed bg-bg-1/95 backdrop-blur-xs transition-colors ${
            drop.over ? "border-primary-6" : "border-border-3"
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
            <span
              className={`flex size-10 items-center justify-center rounded-full ${
                drop.over
                  ? "bg-primary-6/15 text-primary-6"
                  : "bg-bg-3 text-text-2"
              }`}
            >
              <HugeiconsIcon
                icon={InboxIcon}
                data-icon="inbox"
                size={20}
                aria-hidden
              />
            </span>
            <p className="text-sm font-medium text-text-1">
              {t("teamInbox.drop.title")}
            </p>
            <p className="text-xs text-text-3">
              {t("teamInbox.drop.subtitle")}
            </p>
          </div>
        </div>
      ) : null}

      {currentOperation.status === "preparing" ? (
        <div
          data-testid="team-inbox-session-drop-processing"
          className="absolute inset-x-4 top-4 z-40 flex items-center gap-3 rounded-lg border border-border-2 bg-bg-2 px-4 py-3 shadow-lg"
          role="status"
          aria-live="polite"
        >
          <HugeiconsIcon
            icon={Link02Icon}
            data-icon="link-2"
            size={16}
            className="shrink-0 animate-pulse text-primary-6"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-1">
              {t("teamInbox.handoff.preparing", {
                title: currentOperation.reference.title,
              })}
            </p>
            <p className="text-xs text-text-3">
              {t("teamInbox.drop.processingHint")}
            </p>
          </div>
        </div>
      ) : null}

      {currentOperation.status === "configuring" ||
      currentOperation.status === "submitting" ? (
        <SessionHandoffComposer
          draft={currentOperation.draft}
          form={currentOperation.form}
          error={currentOperation.message}
          submitting={currentOperation.status === "submitting"}
          onCancel={dismiss}
          onChange={updateForm}
          onSubmit={submit}
        />
      ) : null}

      {showResult ? (
        <div
          data-testid={`team-inbox-session-drop-${currentOperation.status}`}
          className="absolute inset-x-4 top-4 z-40 flex items-center gap-3 rounded-lg border border-border-2 bg-bg-2 px-4 py-3 shadow-lg"
          role={currentOperation.status === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-1">
              {currentOperation.status === "success"
                ? t(
                    currentOperation.result.reused
                      ? "teamInbox.drop.reused"
                      : "teamInbox.drop.success"
                  )
                : t("teamInbox.drop.failed")}
            </p>
            <p className="truncate text-xs text-text-3">
              {currentOperation.status === "success"
                ? currentOperation.reference.title
                : currentOperation.message}
            </p>
          </div>
          {currentOperation.status === "success" && onNavigate ? (
            <Button
              variant="secondary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={LinkSquare02Icon}
                  data-icon="link-square-02"
                  size={14}
                  aria-hidden
                />
              }
              onClick={openCreated}
            >
              {t("common:actions.openInNewTab")}
            </Button>
          ) : null}
          {currentOperation.status === "error" ? (
            <Button
              variant="secondary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={RotateLeft01Icon}
                  data-icon="rotate-ccw"
                  size={14}
                  aria-hidden
                />
              }
              onClick={() => prepare(currentOperation.reference)}
            >
              {t("common:actions.retry")}
            </Button>
          ) : null}
          <Button
            variant="tertiary"
            appearance="ghost"
            size="mini"
            iconOnly
            aria-label={t("teamInbox.drop.dismiss")}
            icon={
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={14}
                aria-hidden
              />
            }
            onClick={dismiss}
          />
        </div>
      ) : null}
    </div>
  );
};

export default TeamInboxSessionDropSurface;
