/**
 * ConflictRow — one `outbox_conflicts` audit entry for the Phase 7
 * "Sync conflicts" panel inside `SyncSection`.
 *
 * The Rust merge cycle records a row here whenever the field-level
 * resolver chose to keep a local value over an inbound remote one
 * because the local watermark recorded a user-driven edit (`source =
 * "local"`) with a strictly newer mtime than the inbound payload.
 * The user resolves it with one of three actions:
 *
 *   - **Use local**  → re-push the captured local value as a fresh
 *                       `update` outbox row. Drives remote back to
 *                       the local writer's intent on the next push.
 *   - **Use remote** → overwrite the local field with the captured
 *                       remote value and stamp the remote watermark.
 *   - **Dismiss**    → close the audit row without touching any
 *                       field. Accepts the resolver's verdict as-is.
 *
 * State lives entirely inside the row (diff toggle); the parent only
 * owns the busy/pending row marker and the per-action handlers. See
 * `SyncSection` for the parent orchestration.
 */
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CONFLICT_RESOLUTION,
  type ConflictFieldDelta,
  type ConflictRow,
  type EntityType,
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

const ENTITY_ICON_CLASS = "mt-0.5 flex-none text-text-3";

/**
 * Render a 16-px glyph for an entity type — same mapping as
 * `ProblemRow.EntityIcon`, kept duplicated rather than extracted so
 * the two row components stay independent (a future redesign of one
 * shouldn't drag the other).
 */
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
 * i18n key for the human label of a known field name. Unknown field
 * names render as their raw key — falling back rather than throwing
 * keeps the panel forward-compatible with new fields the resolver
 * starts producing before the UI ships their translations.
 */
function fieldLabelKey(field: string): string | null {
  switch (field) {
    case "title":
      return "settings.sync.conflicts.field.title";
    case "description":
      return "settings.sync.conflicts.field.description";
    case "status":
      return "settings.sync.conflicts.field.status";
    case "priority":
      return "settings.sync.conflicts.field.priority";
    case "type":
      return "settings.sync.conflicts.field.type";
    case "due_at":
      return "settings.sync.conflicts.field.dueAt";
    case "assignee_ids":
      return "settings.sync.conflicts.field.assigneeIds";
    case "label_ids":
      return "settings.sync.conflicts.field.labelIds";
    default:
      return null;
  }
}

/** Soft cap on JSON-stringified value rendering to keep the DOM cheap. */
const VALUE_PREVIEW_CAP = 512;

/**
 * Render any conflict-side JSON value as a compact human preview.
 *
 * - `null` / `undefined` / `""` → "(empty)" (i18n).
 * - `string`                    → inline single line.
 * - everything else             → JSON.stringify, capped at 512 chars.
 *
 * Returned as a string so the caller can decide layout (chip vs
 * code block); the wire types make `unknown` mandatory.
 */
function formatValue(value: unknown, emptyLabel: string): string {
  if (value === null || value === undefined) return emptyLabel;
  if (typeof value === "string") {
    return value.length === 0 ? emptyLabel : value;
  }
  try {
    const pretty = JSON.stringify(value);
    if (pretty === undefined) return emptyLabel;
    return pretty.length > VALUE_PREVIEW_CAP
      ? `${pretty.slice(0, VALUE_PREVIEW_CAP)}\u2026`
      : pretty;
  } catch {
    return String(value);
  }
}

/**
 * i18n key for an entity-type chip — same rationale as
 * `ProblemRow.entityChipKey`; locale JSON keeps everything
 * camelCase so the wire snake_case is mapped here.
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

export interface ConflictRowProps {
  row: ConflictRow;
  busy: { kind: "useLocal" | "useRemote" | "dismiss" } | null;
  onUseLocal: (id: number) => void;
  onUseRemote: (id: number) => void;
  onDismiss: (id: number) => void;
}

/**
 * One `outbox_conflicts` entry rendered as a card-style row inside
 * the "Sync conflicts" `SectionContainer`. Encapsulates per-row
 * diff-toggle state so the parent stays stateless w.r.t. individual
 * rows.
 *
 * Three action buttons map 1:1 to `projectSyncApi.conflictUseLocal`
 * / `conflictUseRemote` / `conflictDismiss`. Open rows show all
 * three; resolved rows render a status chip and no action buttons
 * (the parent paginates the recently-resolved tail in the same
 * panel for context).
 */
const ConflictRowComponent: React.FC<ConflictRowProps> = ({
  row,
  busy,
  onUseLocal,
  onUseRemote,
  onDismiss,
}) => {
  const { t } = useTranslation("projects");
  const [showDiff, setShowDiff] = useState(false);

  const fieldEntries = useMemo(
    () => Object.entries(row.fields.fields),
    [row.fields.fields]
  );
  const fieldCount = fieldEntries.length;

  const isOpen = row.resolved_at === null;
  const isBusy = busy !== null;

  const detectedLabel = useMemo(() => {
    const relative = formatRelativeTime(row.detected_at, "long");
    return t("settings.sync.conflicts.detectedAt", { time: relative });
  }, [row.detected_at, t]);

  const resolvedLabel = useMemo(() => {
    if (row.resolved_at === null) return null;
    const relative = formatRelativeTime(row.resolved_at, "long");
    return t("settings.sync.conflicts.resolvedAt", { time: relative });
  }, [row.resolved_at, t]);

  const statusChip = renderStatusChip(row.resolution, isOpen, t);

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
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] text-text-3">
              {t("settings.sync.conflicts.fields", { count: fieldCount })}
            </span>
            {statusChip}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-text-3">
            <span>{detectedLabel}</span>
            {resolvedLabel && <span>{resolvedLabel}</span>}
          </div>
        </div>
        {isOpen && (
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <Button
              size="small"
              onClick={() => onUseLocal(row.id)}
              loading={busy?.kind === "useLocal"}
              disabled={isBusy}
            >
              {t("settings.sync.conflicts.actions.useLocal")}
            </Button>
            <Button
              size="small"
              onClick={() => onUseRemote(row.id)}
              loading={busy?.kind === "useRemote"}
              disabled={isBusy}
            >
              {t("settings.sync.conflicts.actions.useRemote")}
            </Button>
            <Button
              variant="danger"
              appearance="outline"
              size="small"
              onClick={() => onDismiss(row.id)}
              loading={busy?.kind === "dismiss"}
              disabled={isBusy}
            >
              {t("settings.sync.conflicts.actions.dismiss")}
            </Button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setShowDiff((prev) => !prev)}
        className="flex items-center gap-1 self-start text-[12px] text-text-3 hover:text-text-2"
      >
        {showDiff ? (
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
          {showDiff
            ? t("settings.sync.conflicts.actions.hideDiff")
            : t("settings.sync.conflicts.actions.showDiff")}
        </span>
      </button>
      {showDiff && (
        <div className="flex flex-col gap-2">
          {fieldEntries.map(([fieldName, delta]) => (
            <FieldDiff
              key={fieldName}
              fieldName={fieldName}
              delta={delta}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface FieldDiffProps {
  fieldName: string;
  delta: ConflictFieldDelta;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Two-column local-vs-remote preview for one field. Renders the
 * field's i18n label (or raw key when unknown) followed by the
 * formatted local + remote values stacked side-by-side. The
 * `applied` chip surfaces which side actually landed in the local
 * DB after the resolver's verdict — today always `"local"`, but the
 * Rust enum carries both for forward-compat.
 */
const FieldDiff: React.FC<FieldDiffProps> = ({ fieldName, delta, t }) => {
  const labelKey = fieldLabelKey(fieldName);
  const label = labelKey ? t(labelKey) : fieldName;
  const emptyLabel = t("settings.sync.conflicts.valueEmpty");
  const localValue = formatValue(delta.local_value, emptyLabel);
  const remoteValue = formatValue(delta.remote_value, emptyLabel);
  const appliedKey =
    delta.applied === "local"
      ? "settings.sync.conflicts.side.local"
      : "settings.sync.conflicts.side.remote";

  return (
    <div className="border-line-2 flex flex-col gap-1 rounded-md border bg-fill-2 p-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-text-2">{label}</span>
        <span className="rounded bg-fill-3 px-1.5 py-0.5 text-[10px] tracking-wide text-text-3 uppercase">
          {t(appliedKey)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ValuePane
          sideLabel={t("settings.sync.conflicts.side.local")}
          value={localValue}
        />
        <ValuePane
          sideLabel={t("settings.sync.conflicts.side.remote")}
          value={remoteValue}
        />
      </div>
    </div>
  );
};

interface ValuePaneProps {
  sideLabel: string;
  value: string;
}

const ValuePane: React.FC<ValuePaneProps> = ({ sideLabel, value }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] tracking-wide text-text-3 uppercase">
      {sideLabel}
    </span>
    <pre className="max-h-[140px] overflow-auto rounded bg-fill-1 px-2 py-1 text-[11px] wrap-break-word whitespace-pre-wrap text-text-2">
      {value}
    </pre>
  </div>
);

/**
 * Status chip for resolved rows. Open rows render a neutral "Open"
 * chip; resolved rows render the picked resolution's label. Returns
 * `null` only as a defensive fallback (`resolved_at` set without a
 * `resolution` enum), which the Rust side never produces.
 */
function renderStatusChip(
  resolution: ConflictRow["resolution"],
  isOpen: boolean,
  t: (key: string) => string
): React.ReactNode {
  if (isOpen) {
    return (
      <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-warning-6 uppercase">
        {t("settings.sync.conflicts.status.open")}
      </span>
    );
  }
  if (resolution === CONFLICT_RESOLUTION.USE_LOCAL) {
    return (
      <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-success-6 uppercase">
        {t("settings.sync.conflicts.status.resolvedUseLocal")}
      </span>
    );
  }
  if (resolution === CONFLICT_RESOLUTION.USE_REMOTE) {
    return (
      <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-success-6 uppercase">
        {t("settings.sync.conflicts.status.resolvedUseRemote")}
      </span>
    );
  }
  if (resolution === CONFLICT_RESOLUTION.DISMISSED) {
    return (
      <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[11px] tracking-wide text-text-3 uppercase">
        {t("settings.sync.conflicts.status.resolvedDismissed")}
      </span>
    );
  }
  return null;
}

export default ConflictRowComponent;
