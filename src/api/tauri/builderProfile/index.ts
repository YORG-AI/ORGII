/**
 * Builder Profile client (chat pane → Runtime → Profile).
 *
 * Rust emits camelCase, so an invoke result IS the typed shape — no wire
 * mapping layer, same convention as `usageDashboard`.
 */
import { invoke } from "@tauri-apps/api/core";

/** Keys of the four letter-bearing axes, in code order. */
export const AXIS_ORDER = ["ME", "DA", "FW", "SH"] as const;

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
type Clarity = "slight" | "moderate" | "clear" | "veryClear";

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
  /** Sessions processed: extracted plus unreadable tombstones. */
  extracted: number;
  known: number;
  stale: number;
  /** Sessions whose transcript could not be read; parked, never scored. */
  unreadable: number;
}

export interface SourceProfile {
  source: string;
  sessions: number;
  code: string;
  confidence: number;
  scores: [string, number][];
}

export interface DriftPoint {
  /**
   * Window bounds. `sessions` is a fixed window size and therefore the same on
   * every row — what varies is how long the window took to accumulate.
   */
  startedAtMs: number;
  endedAtMs: number;
  sessions: number;
  code: string;
  scores: [string, number][];
}

/** Card family — used to vary presentation and to interleave the deck. */
export type HighlightKind = "scale" | "extreme" | "rhythm" | "style" | "craft";

export interface Highlight {
  /** Selects `cards.<id>.question` and `cards.<id>.headline`. */
  id: string;
  /** Selects `cards.<id>.detail` — a few cards swap only their closing line. */
  detailId: string;
  kind: HighlightKind;
  /**
   * Raw interpolation values. Formatting is the panel's job: thousands
   * separators, date format and clock format are locale decisions the backend
   * cannot make.
   */
  params: Record<string, number>;
}

export interface BuilderProfileOverview {
  profile: BuilderProfile;
  /** Number of per-tool rows available; rows are omitted until requested. */
  bySourceCount: number;
  bySource: SourceProfile[];
  /** Number of rolling-window rows available; rows are omitted until requested. */
  driftCount: number;
  drift: DriftPoint[];
  coverage: ProfileCoverage;
  /** Readable one-fact-per-card deck, families already interleaved. */
  highlights: Highlight[];
}

interface ExtractProgress {
  extractedNow: number;
  coverage: ProfileCoverage;
  more: boolean;
}

interface ProfileScope {
  sources?: string[];
  sinceMs?: number | null;
}

interface BuilderProfileOverviewOptions {
  includeBySource?: boolean;
  includeDrift?: boolean;
}

/** Score the cached signal rows. Cheap — never parses a transcript. */
export async function builderProfileOverview(
  scope: ProfileScope = {},
  options: BuilderProfileOverviewOptions = {}
): Promise<BuilderProfileOverview> {
  return invoke<BuilderProfileOverview>("builder_profile_overview", {
    sources: scope.sources?.length ? scope.sources : null,
    sinceMs: scope.sinceMs ?? null,
    includeBySource: options.includeBySource ?? false,
    includeDrift: options.includeDrift ?? false,
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
