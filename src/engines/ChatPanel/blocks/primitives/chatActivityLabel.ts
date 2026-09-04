/**
 * chatActivityLabel
 *
 * What the agent is doing right now, as one phrase — "Agent is typing...",
 * "Compacting context...", or one of the localized planning variants.
 *
 * This used to be its own row (`PlanningFooter`) sitting above the status
 * trail, which meant a working session showed two stacked lines saying
 * related things. The phrase is now the trail's second segment
 * (`Agent working for 31s · Agent is typing...`), so the transcript ends with
 * exactly one live row.
 *
 * The variant index comes from `usePlanningIndicator` and is stable for the
 * whole visible span, re-rolling only on a hidden -> visible transition, so
 * the wording varies between waits but never shuffles mid-wait.
 */

export type PlanningIndicatorMode = "planning" | "agentTyping" | "compacting";

/**
 * Pick one phrasing from a localized variant array.
 *
 * `t(..., { returnObjects: true })` is typed as `unknown` and can come back
 * as a string, a missing-key marker, or an array with holes depending on how
 * complete a locale is — so every shape but "array of non-empty strings"
 * falls through to the caller's fallback rather than rendering `undefined`.
 */
export function pickPlanningVariant(
  variants: unknown,
  index: number,
  fallback: string
): string {
  if (!Array.isArray(variants) || variants.length === 0) return fallback;
  const safe = variants.filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (safe.length === 0) return fallback;
  return safe[index % safe.length] ?? fallback;
}
