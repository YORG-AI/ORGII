/**
 * ProblemRow — one outbox-problem entry for the "Failed entries"
 * panel inside `SyncSection`.
 *
 * State lives entirely inside the row (discard-armed timer, payload
 * toggle); the parent only owns the busy/pending row marker and the
 * retry/discard handlers. See the `SyncSection` file for the parent
 * orchestration.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  EntityType,
  OutboxOp,
  OutboxProblemRow,
} from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File02Icon,
  FolderClosedIcon,
  HugeiconsIcon,
  RoadLocation01Icon,
  Tag01Icon,
  UserIcon,
} from "@src/icons";
import { SECTION_ACTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

/**
 * Render a 16-px glyph for an entity type. Mapping is fixed
 * (entity → icon); changing it should require a follow-up design
 * pass since the icons set the visual hierarchy of the panel.
 *
 * Inlined as a render-time component (rather than returning the
 * `IconSvgElement` type) so the `react-hooks/static-components` rule
 * stays happy — assigning a component value into a local then
 * rendering it would otherwise count as "create component during
 * render".
 */
const ENTITY_ICON_CLASS = "mt-0.5 flex-none text-text-3";

const EntityIcon: React.FC<{ entityType: EntityType }> = ({ entityType }) => {
  switch (entityType) {
    case "work_item":
      return (
        <HugeiconsIcon
          icon={File02Icon}
          data-icon="file-text"
          size={16}
          className={ENTITY_ICON_CLASS}
        />
      );
    case "label":
      return (
        <HugeiconsIcon
          icon={Tag01Icon}
          data-icon="tag"
          size={16}
          className={ENTITY_ICON_CLASS}
        />
      );
    case "milestone":
      return (
        <HugeiconsIcon
          icon={RoadLocation01Icon}
          data-icon="milestone-icon"
          size={16}
          className={ENTITY_ICON_CLASS}
        />
      );
    case "member":
      return (
        <HugeiconsIcon
          icon={UserIcon}
          data-icon="user"
          size={16}
          className={ENTITY_ICON_CLASS}
        />
      );
    case "project":
      return (
        <HugeiconsIcon
          icon={FolderClosedIcon}
          data-icon="folder"
          size={16}
          className={ENTITY_ICON_CLASS}
        />
      );
  }
};

/**
 * i18n key suffix for an entity-type chip. Keeps `<ProblemRow>` clear
 * of the keypath gymnastics (the alternative — interpolating the
 * `EntityType` snake_case directly into a translation key — would
 * require synthetic camelCase keys per locale).
 */
function entityChipKey(entityType: EntityType): string {
  switch (entityType) {
    case "work_item":
      return "settings.sync.problems.entity.workItem";
    case "label":
      return "settings.sync.problems.entity.label";
    case "milestone":
      return "settings.sync.problems.entity.milestone";
    case "member":
      return "settings.sync.problems.entity.member";
    case "project":
      return "settings.sync.problems.entity.project";
  }
}

/**
 * i18n key suffix for an op chip. Same rationale as above; the wire
 * format `merge_external` becomes the camelCase key `mergeExternal`
 * to keep JSON keys consistently camelCase.
 */
function opChipKey(op: OutboxOp): string {
  switch (op) {
    case "create":
      return "settings.sync.problems.op.create";
    case "update":
      return "settings.sync.problems.op.update";
    case "delete":
      return "settings.sync.problems.op.delete";
    case "merge_external":
      return "settings.sync.problems.op.mergeExternal";
  }
}

/** Soft cap on rendered payload length (~2 KB) to keep the DOM cheap. */
const PAYLOAD_PREVIEW_CAP = 2048;
/** Discard "armed" window: second click within this many ms commits. */
const DISCARD_CONFIRM_WINDOW_MS = 3_000;

export interface ProblemRowProps {
  row: OutboxProblemRow;
  busy: { kind: "retry" | "discard" } | null;
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
}

/**
 * One outbox-problem entry rendered as a card-style row inside the
 * "Failed entries" `SectionContainer`. Encapsulates per-row state
 * (discard confirm armed timer, payload toggle) so the parent stays
 * stateless w.r.t. individual rows.
 *
 * Discard confirmation uses the in-component "two-click + timeout"
 * pattern documented in the Track C plan: first click flips the
 * label to "Confirm discard?" and arms a 3-second window; a second
 * click within the window commits, anything else (timeout, retry
 * click, scroll) cancels.
 */
const ProblemRow: React.FC<ProblemRowProps> = ({
  row,
  busy,
  onRetry,
  onDiscard,
}) => {
  const { t } = useTranslation("projects");
  const [discardArmed, setDiscardArmed] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const armedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null) {
        window.clearTimeout(armedTimerRef.current);
      }
    };
  }, []);

  const isFailed = row.status === "failed";

  const lastAttemptedLabel = useMemo(() => {
    if (row.last_attempted_at === null) {
      return t("settings.sync.problems.lastAttemptedNever");
    }
    const relative = formatRelativeTime(row.last_attempted_at, "long");
    return t("settings.sync.problems.lastAttempted", { time: relative });
  }, [row.last_attempted_at, t]);

  const payloadPreview = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      const pretty = JSON.stringify(parsed, null, 2);
      return pretty.length > PAYLOAD_PREVIEW_CAP
        ? `${pretty.slice(0, PAYLOAD_PREVIEW_CAP)}\u2026`
        : pretty;
    } catch {
      // Fall back to raw payload when it isn't valid JSON — discard
      // is still actionable, the preview just becomes a single
      // string. Capped same way.
      return row.payload_json.length > PAYLOAD_PREVIEW_CAP
        ? `${row.payload_json.slice(0, PAYLOAD_PREVIEW_CAP)}\u2026`
        : row.payload_json;
    }
  }, [row.payload_json]);

  const handleDiscardClick = () => {
    if (discardArmed) {
      if (armedTimerRef.current !== null) {
        window.clearTimeout(armedTimerRef.current);
        armedTimerRef.current = null;
      }
      setDiscardArmed(false);
      onDiscard(row.id);
      return;
    }
    setDiscardArmed(true);
    armedTimerRef.current = window.setTimeout(() => {
      setDiscardArmed(false);
      armedTimerRef.current = null;
    }, DISCARD_CONFIRM_WINDOW_MS);
  };

  const isRetrying = busy?.kind === "retry";
  const isDiscarding = busy?.kind === "discard";

  return (
    <div className="border-line-2 flex flex-col gap-2 rounded-lg border bg-fill-1 p-3">
      <div className="flex items-start gap-3">
        <EntityIcon entityType={row.entity_type} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-text-1">
              {row.entity_id}
            </span>
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-text-3 uppercase">
              {t(entityChipKey(row.entity_type))}
            </span>
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-text-3 uppercase">
              {t(opChipKey(row.op))}
            </span>
            {row.field_path && (
              <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] text-text-3">
                {row.field_path}
              </span>
            )}
            <span
              className={
                isFailed
                  ? "rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-danger-6 uppercase"
                  : "rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-warning-6 uppercase"
              }
            >
              {isFailed
                ? t("settings.sync.problems.chip.failed")
                : t("settings.sync.problems.chip.abandoned")}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-text-3">
            <span>
              {t("settings.sync.problems.retryCount", {
                count: row.retry_count,
              })}
            </span>
            <span>{lastAttemptedLabel}</span>
          </div>
        </div>
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <Button
            size="small"
            onClick={() => onRetry(row.id)}
            loading={isRetrying}
            disabled={isRetrying || isDiscarding}
          >
            {t("settings.sync.problems.retryButton")}
          </Button>
          <Button
            variant="danger"
            appearance="outline"
            size="small"
            onClick={handleDiscardClick}
            loading={isDiscarding}
            disabled={isRetrying || isDiscarding}
          >
            {discardArmed
              ? t("settings.sync.problems.discardConfirm")
              : t("settings.sync.problems.discardButton")}
          </Button>
        </div>
      </div>
      {row.last_error && (
        <div className="rounded-lg bg-fill-2 px-3 py-2 text-[12px] wrap-break-word whitespace-pre-wrap text-text-3">
          {row.last_error}
        </div>
      )}
      <button
        type="button"
        onClick={() => setShowPayload((prev) => !prev)}
        className="flex items-center gap-1 self-start text-[12px] text-text-3 hover:text-text-2"
      >
        {showPayload ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={12}
          />
        ) : (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            data-icon="chevron-right"
            size={12}
          />
        )}
        <span>
          {showPayload
            ? t("settings.sync.problems.hidePayload")
            : t("settings.sync.problems.showPayload")}
        </span>
      </button>
      {showPayload && (
        <pre className="max-h-[280px] overflow-auto rounded-lg bg-fill-2 px-3 py-2 text-[11px] wrap-break-word whitespace-pre-wrap text-text-3">
          {payloadPreview}
        </pre>
      )}
    </div>
  );
};

export default ProblemRow;
