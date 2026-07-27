/**
 * Builder Profile client (chat pane → Runtime → Profile).
 *
 * Rust emits camelCase, so an invoke result IS the typed shape — no wire
 * mapping layer, same convention as `usageDashboard`.
 */
import { invoke } from "@tauri-apps/api/core";

/** Keys of the four letter-bearing axes, in code order. */
export const AXIS_ORDER = ["ME", "DA", "FW", "SH"] as const;
export type AxisKey = (typeof AXIS_ORDER)[number];

export interface AxisEvidence {
  label: string;
  signal: string;
  /** Mean per-session contribution, -1..+1. */
  contribution: number;
  median: number;
  anchor: number;
  towardPositive: boolean;
}

/** How firmly a letter is held — the letter itself is never withheld. */
export type Clarity = "slight" | "moderate" | "clear" | "veryClear";

export interface AxisScore {
  key: string;
  question: string;
  positiveName: string;
  negativeName: string;
  /** -100..+100; positive leans to the positive pole. */
  score: number;
  /** The letter. Always present — an axis always picks a side. */
  letter: string;
  /** How firmly that letter is held. */
  clarity: Clarity;
  sessions: number;
  consistency: number;
  stability: number;
  /** Multiple the anchors must move to flip the letter; null = never flips. */
  flipFactor: number | null;
  /** Why the letter is soft, when it is. Shown beside it, not instead of it. */
  caveat: string | null;
  evidence: AxisEvidence[];
}

export interface BuilderProfile {
  code: string;
  archetype: string | null;
  blurbs: string[];
  confidence: number;
  sessions: number;
  hasEnoughSessions: boolean;
  axes: AxisScore[];
  secondary: AxisScore[];
  subagentSessionShare: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface ProfileCoverage {
  extracted: number;
  known: number;
  stale: number;
}

export interface SourceProfile {
  source: string;
  sessions: number;
  code: string;
  confidence: number;
  scores: [string, number][];
}

export interface DriftPoint {
  endedAtMs: number;
  sessions: number;
  code: string;
  scores: [string, number][];
}

/** Card family — used to vary presentation and to interleave the deck. */
export type HighlightKind = "scale" | "extreme" | "rhythm" | "style" | "craft";

export interface Highlight {
  id: string;
  kind: HighlightKind;
  /** The question the card answers. */
  question: string;
  /** The answer, large. */
  headline: string;
  /** One line of context under it. */
  detail: string;
}

export interface BuilderProfileOverview {
  profile: BuilderProfile;
  bySource: SourceProfile[];
  drift: DriftPoint[];
  coverage: ProfileCoverage;
  /** Readable one-fact-per-card deck, families already interleaved. */
  highlights: Highlight[];
}

export interface ExtractProgress {
  extractedNow: number;
  coverage: ProfileCoverage;
  more: boolean;
}

export interface ExemplarSession {
  sessionId: string;
  source: string;
  startedAtMs: number;
  score: number;
}

export interface AxisExemplars {
  axis: string;
  positive: ExemplarSession[];
  negative: ExemplarSession[];
}

export interface ProfileScope {
  sources?: string[];
  sinceMs?: number | null;
}

/** Score the cached signal rows. Cheap — never parses a transcript. */
export async function builderProfileOverview(
  scope: ProfileScope = {},
  includeDrift = false
): Promise<BuilderProfileOverview> {
  return invoke<BuilderProfileOverview>("builder_profile_overview", {
    sources: scope.sources?.length ? scope.sources : null,
    sinceMs: scope.sinceMs ?? null,
    includeDrift,
  });
}

/**
 * Analyse one bounded batch of not-yet-read sessions. Call repeatedly while the
 * panel is open; stop when `more` is false.
 */
export async function builderProfileExtract(
  limit?: number
): Promise<ExtractProgress> {
  return invoke<ExtractProgress>("builder_profile_extract", {
    limit: limit ?? null,
  });
}

/** Sessions at each end of one axis, so a verdict can be checked. */
export async function builderProfileExemplars(
  axis: AxisKey | string,
  scope: ProfileScope = {},
  limit = 5
): Promise<AxisExemplars> {
  return invoke<AxisExemplars>("builder_profile_exemplars", {
    axis,
    sources: scope.sources?.length ? scope.sources : null,
    sinceMs: scope.sinceMs ?? null,
    limit,
  });
}
