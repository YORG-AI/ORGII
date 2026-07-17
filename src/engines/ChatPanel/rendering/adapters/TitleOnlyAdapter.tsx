/**
 * TitleOnlyAdapter — `ChatBlock::TitleOnly` sink.
 *
 * Responsibilities beyond looking up the state-aware label:
 *
 * 1. **`await_output` aggregation.** `wait_for` and `monitor` accept one or
 *    many handles. Rust returns `awaitMeta::{count, items: [{handle, jobKind,
 *    status, ...}]}`. We tally item kinds, format a localised `{{summary}}`
 *    string ("1 terminal process, 2 subagents"), and feed it to the label.
 *
 * 2. **Live `wait_for` countdown.** The adapter (not the block) runs a
 *    per-second ticker based on the event timestamp + `block_until_ms`, and
 *    injects a `{{countdown}}` var into the running title so the block
 *    itself stays a dumb renderer.
 *
 * 3. **Per-status subtitles.** Exit code / killed / pattern-matched / still-
 *    running status lines come from the Rust registry's `status_labels`.
 */
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getEventIcon } from "@src/config/toolIcons";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import { getToolLabel } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";

import TitleOnlyBlock from "../../blocks/TitleOnlyBlock";
import {
  type AwaitJobItem,
  type AwaitMeta,
  formatDurationShort,
  readAwaitMetaFromResult,
  tallyItems,
} from "./awaitMeta";

interface AwaitExtras {
  vars: Record<string, unknown>;
  subtitle?: string;
}

/**
 * Resolve `await_output`'s effective `command` value from `args`.
 *
 * Mirrors Rust `await_tool::execute` defaulting policy:
 * - explicit `command` wins
 * - missing `command` + `pattern` or `wait_mode` set → infer `"wait_for"`
 *   (the only command those params apply to)
 * - missing `command` + nothing else suggesting blocking → `"monitor"`
 *
 * The Rust side now rejects the ambiguous `pattern`/`wait_mode`-without-command
 * case before the event is ever broadcast, so this client-side inference is
 * here as a defensive belt for events generated before that change shipped or
 * by upstream proxies that bypass validation.
 */
function resolveAwaitCommand(
  args: Record<string, unknown> | undefined
): string {
  const explicit = args?.command;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  // Treat `null` and `undefined` the same here — both mean "caller didn't set
  // it". Only a non-null present value counts as "wait_for intent".
  const hasPattern = args?.pattern !== undefined && args?.pattern !== null;
  const hasWaitMode = args?.wait_mode !== undefined && args?.wait_mode !== null;
  const isCodexWait =
    args?.cell_id !== undefined || args?.yield_time_ms !== undefined;
  if (hasPattern || hasWaitMode || isCodexWait) {
    return "wait_for";
  }
  return "monitor";
}

/** Read Codex's wall-time line, falling back to the requested yield window. */
function readCodexWaitedMs(
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): number | undefined {
  if (args?.cell_id === undefined && args?.yield_time_ms === undefined) {
    return undefined;
  }

  for (const value of [result?.output, result?.content, result?.observation]) {
    if (typeof value !== "string") continue;
    const match = value.match(/Wall time\s+([\d.]+)\s+seconds?/i);
    if (match) return Number.parseFloat(match[1]) * 1000;
  }

  return typeof args?.yield_time_ms === "number"
    ? args.yield_time_ms
    : undefined;
}

/** Format a remaining-ms value for `Waiting {{countdown}} ...` titles. */
function formatRemaining(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  if (secs >= 60) {
    const mins = Math.floor(secs / 60);
    const remainder = secs % 60;
    return remainder > 0 ? `${mins}m ${remainder}s` : `${mins}m`;
  }
  return `${secs}s`;
}

/**
 * Re-render once per second while `enabled` is true, returning the formatted
 * countdown string for `deadline = startedAt + blockUntilMs`. Returns an
 * empty string when disabled or when either input is missing — callers feed
 * the result into ICU interpolation so missing countdowns degrade gracefully.
 *
 * `startedAt` defaults to component mount time when `timestamp` isn't set.
 * That fallback is captured in `useState` initialiser to keep this hook
 * pure across re-renders (calling `Date.now()` directly during render is a
 * React purity violation).
 */
function useCountdownString(
  timestamp: string | undefined,
  blockUntilMs: number | undefined,
  enabled: boolean
): string {
  // Lock down the start-time on first render so subsequent re-renders don't
  // wobble. `Date.parse` of a stable ISO string is pure; `Date.now()` is
  // only called once via the lazy initialiser.
  const [startedAt] = useState<number>(() =>
    timestamp ? Date.parse(timestamp) : Date.now()
  );
  const deadlineMs =
    typeof blockUntilMs === "number" && Number.isFinite(startedAt)
      ? startedAt + blockUntilMs
      : undefined;

  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!enabled || !deadlineMs) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled, deadlineMs]);

  if (!enabled || !deadlineMs) return "";
  return formatRemaining(deadlineMs - now);
}

/**
 * Build a localised summary fragment like "1 terminal process, 2 subagents",
 * "3 background tasks" (unknown kinds), or an empty string when nothing is
 * aggregatable. Defers all plural / word-order decisions to i18n keys.
 */
function buildSummary(
  items: AwaitJobItem[] | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const tally = tallyItems(items);
  if (tally.total === 0) {
    return t("tools.awaitOutputSummaryUnknown", { count: 1 });
  }
  if (tally.shell > 0 && tally.subagent > 0) {
    // Build each side through its own plural rule, then join with the
    // locale-specific mixed template ("{{shell}}, {{subagent}}" in EN;
    // languages with different conjunctions adjust the template itself).
    return t("tools.awaitOutputSummaryMixed", {
      shell: t("tools.awaitOutputSummaryShell", { count: tally.shell }),
      subagent: t("tools.awaitOutputSummarySubagent", {
        count: tally.subagent,
      }),
    });
  }
  if (tally.shell > 0) {
    return t("tools.awaitOutputSummaryShell", { count: tally.shell });
  }
  if (tally.subagent > 0) {
    return t("tools.awaitOutputSummarySubagent", { count: tally.subagent });
  }
  return t("tools.awaitOutputSummaryUnknown", { count: tally.total });
}

/**
 * Resolve await-specific vars (`summary`, `waited`, `countdown`) and an
 * optional `subtitle`. Returns empty extras for non-await tools so the
 * adapter can call this unconditionally.
 *
 * Subtitle text comes from the Rust registry's `status_labels` so all locales
 * share the same wording keys (`tools.awaitOutputExitCode`, `...Killed`, etc).
 */
function useAwaitExtras(
  props: UniversalEventProps,
  awaitCommand: string | undefined,
  lifecycle: "running" | "done" | "failed"
): AwaitExtras {
  const { t } = useTranslation("sessions");

  // Countdown must be called unconditionally (rules of hooks), so pull the
  // inputs before the early return for non-await tools. Only `wait_for`
  // shows a countdown — for other commands we pass `undefined` to no-op.
  const blockUntilMs = (props.args?.block_until_ms ??
    props.args?.yield_time_ms) as number | undefined;
  const countdownActive =
    awaitCommand === "wait_for" && lifecycle === "running";
  const countdown = useCountdownString(
    props.timestamp,
    countdownActive ? blockUntilMs : undefined,
    countdownActive
  );

  if (props.eventType !== "await_output") {
    return { vars: {} };
  }

  const meta: AwaitMeta | null = readAwaitMetaFromResult(props.result);
  const items = meta?.items ?? [];
  const representative =
    items.find((it) => it.status !== "running") ?? items[0];
  const waitedMs =
    representative?.waitedMs ?? readCodexWaitedMs(props.args, props.result);

  const summary = buildSummary(items, t);

  const vars: Record<string, unknown> = {
    summary,
    countdown,
    waited: formatDurationShort(waitedMs),
    exitCode: representative?.exitCode ?? "",
  };

  // Resolve `status_labels` subtitles via the Rust registry; returning null
  // from `getToolLabel` means that state isn't configured → we drop the
  // subtitle rather than fabricate wording.
  const translateStatus = (stateName: string): string => {
    const key = getToolLabel("await_output", stateName, awaitCommand);
    return key ? t(key, { exitCode: representative?.exitCode ?? "" }) : "";
  };

  let subtitle: string | undefined;
  if (lifecycle !== "running" && representative) {
    if (representative.status === "succeeded") {
      subtitle = representative.patternMatched
        ? translateStatus("pattern_matched")
        : translateStatus("exit_code");
    } else if (representative.status === "failed") {
      subtitle = representative.killed
        ? translateStatus("killed")
        : translateStatus("exit_code");
    }
  } else if (awaitCommand === "monitor" && lifecycle === "running") {
    subtitle = translateStatus("still_running");
  }

  return { vars, subtitle };
}

export const TitleOnlyAdapter: React.FC<UniversalEventProps> = (props) => {
  const action = (props.args?.action as string) || undefined;
  // Mirrors Rust's `await_tool::execute` strictness — `command` defaults to
  // "monitor" only when the call has no wait_for-only intent. If `pattern` or
  // `wait_mode` is set without an explicit `command`, use "wait_for" for the
  // header (matches what the agent meant) so we don't render a misleading
  // "monitor" lifecycle. Avoids the previous silent fallback that produced
  // the wrong icon + label for a wait_for call missing its `command`.
  const awaitCommand =
    props.eventType === "await_output"
      ? resolveAwaitCommand(props.args)
      : undefined;
  const lifecycleAction = awaitCommand ?? action;

  const state = statusToLifecycle(props.status);
  const extras = useAwaitExtras(props, awaitCommand, state);
  const labels = useLifecycleLabels(props.eventType, lifecycleAction, {
    ...(props.args ?? {}),
    ...extras.vars,
  });

  // Pass the await_output subcommand as `action` so Rust's `action_icons`
  // mapping kicks in (`monitor` → focus, `list` → list-tree).
  const icon = getEventIcon(props.eventType, { action: lifecycleAction });

  const toolName = props.functionName || props.eventType;

  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <TitleOnlyBlock
        title={labels[state]}
        icon={icon}
        subtitle={extras.subtitle}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        isFailed={state === "failed"}
        eventId={props.eventId}
        toolUsage={props.toolUsage}
      />
    </div>
  );
};

TitleOnlyAdapter.displayName = "TitleOnlyAdapter";

export default TitleOnlyAdapter;
