/**
 * User Presence Types
 *
 * QQ-style availability the user controls from the sidebar footer. The
 * value travels with every agent turn (piggy-backing on the ADE context
 * payload) and surfaces in the system prompt via the
 * `user_presence` section so the agent can adapt its behavior to whether
 * the human is watching, hiding, or away.
 *
 * The three built-in modes (`online`, `invisible`, `away`) are always
 * present and have first-class UI affordances (icon, color, away-back-at
 * scheduling). On top of those, the user can define any number of
 * **custom roles** in Settings → My Role; each custom role is identified
 * by a `role:<slug>` mode id, carries its own guidance text, and is
 * surfaced in the same presence pill dropdown.
 */

export const USER_PRESENCE_MODE = {
  ONLINE: "online",
  INVISIBLE: "invisible",
  AWAY: "away",
} as const;

export type BuiltInPresenceMode =
  (typeof USER_PRESENCE_MODE)[keyof typeof USER_PRESENCE_MODE];

/**
 * Active presence mode. Either one of the three built-in modes above or a
 * custom-role mode id of the form `role:<slug>` (slug must be lowercase
 * alphanumerics + dashes; see `CUSTOM_ROLE_MODE_PREFIX`).
 */
export type UserPresenceMode = BuiltInPresenceMode | string;

export const USER_PRESENCE_MODES: BuiltInPresenceMode[] = [
  USER_PRESENCE_MODE.ONLINE,
  USER_PRESENCE_MODE.INVISIBLE,
  USER_PRESENCE_MODE.AWAY,
];

export const CUSTOM_ROLE_MODE_PREFIX = "role:";

export function isBuiltInPresenceMode(
  mode: UserPresenceMode
): mode is BuiltInPresenceMode {
  return (USER_PRESENCE_MODES as readonly string[]).includes(mode);
}

export function isCustomRoleMode(mode: UserPresenceMode): boolean {
  return mode.startsWith(CUSTOM_ROLE_MODE_PREFIX);
}

export function buildCustomRoleMode(roleId: string): UserPresenceMode {
  return `${CUSTOM_ROLE_MODE_PREFIX}${roleId}`;
}

export function parseCustomRoleId(mode: UserPresenceMode): string | null {
  return isCustomRoleMode(mode)
    ? mode.slice(CUSTOM_ROLE_MODE_PREFIX.length)
    : null;
}

// ────────────────────────────────────────────────────────────────────
// Presence mode spec — mode as a full data record
// ────────────────────────────────────────────────────────────────────
//
// Every mode — built-in or user-created — is a complete record carrying
// both its prompt identity (label + guidance) and its runtime behavior
// policy (stance + auto-resolve timers + goal budget). Built-in modes
// are three non-deletable preset records; custom modes are ordinary
// rows. New modes need zero backend code: the frontend resolves the
// spec and ships the full result on the wire.

/**
 * Behavior stance — the closed set of runtime semantics a mode maps to.
 * Behavior is code; prompt copy is data. A mode's "personality" lives
 * in its guidance text, while its runtime behavior is one of these.
 */
export const PRESENCE_STANCE = {
  /** User at keyboard: ask freely, confirm destructive actions, block forever. */
  INTERACTIVE: "interactive",
  /** User stepped away: work first, batch questions, hold irreversibles. */
  DEFER_AND_BATCH: "defer_and_batch",
  /** Goal mode: never ask, auto-resolve blockers, keep going until done. */
  AUTONOMOUS: "autonomous",
} as const;

export type PresenceStance =
  (typeof PRESENCE_STANCE)[keyof typeof PRESENCE_STANCE];

export const PRESENCE_STANCES: PresenceStance[] = [
  PRESENCE_STANCE.INTERACTIVE,
  PRESENCE_STANCE.DEFER_AND_BATCH,
  PRESENCE_STANCE.AUTONOMOUS,
];

export function isPresenceStance(value: string): value is PresenceStance {
  return (PRESENCE_STANCES as readonly string[]).includes(value);
}

/** Full per-mode record: prompt identity + runtime behavior policy. */
export interface PresenceModeSpec {
  /** "online" | "invisible" | "away" | "role:<slug>" */
  id: UserPresenceMode;
  /** Display name shown in the pill, dropdown, and prompt. */
  label: string;
  /** Icon id (custom roles only; built-ins have fixed icons). */
  iconId?: CustomRoleIconId;
  /** The mode's prompt addendum (user-editable textarea). */
  guidance: string;
  /** Runtime behavior class. */
  stance: PresenceStance;
  /** Seconds until a pending ask_user_questions batch auto-skips. 0 = off. */
  questionAutoResolveSecs: number;
  /** Seconds until a pending plan approval auto-approves. 0 = off. */
  planAutoApproveSecs: number;
  /** Whether pending mode-switch suggestions auto-switch to Plan on timeout. */
  modeSwitchAutoPlan: boolean;
  /** Goal-loop continuation budget (Ralph loop). 0 = loop disabled. */
  goalMaxTurns: number;
  /** Built-in modes cannot be deleted and keep fixed ids/icons. */
  builtIn: boolean;
}

/**
 * Behavior-policy defaults per built-in mode. These are also the
 * fallback the Rust side derives when an old wire payload arrives
 * without explicit policy fields.
 */
export const BUILT_IN_PRESENCE_POLICY: Record<
  BuiltInPresenceMode,
  Pick<
    PresenceModeSpec,
    | "stance"
    | "questionAutoResolveSecs"
    | "planAutoApproveSecs"
    | "modeSwitchAutoPlan"
    | "goalMaxTurns"
  >
> = {
  [USER_PRESENCE_MODE.ONLINE]: {
    stance: PRESENCE_STANCE.INTERACTIVE,
    questionAutoResolveSecs: 0,
    planAutoApproveSecs: 0,
    modeSwitchAutoPlan: false,
    goalMaxTurns: 0,
  },
  [USER_PRESENCE_MODE.AWAY]: {
    stance: PRESENCE_STANCE.DEFER_AND_BATCH,
    questionAutoResolveSecs: 180,
    planAutoApproveSecs: 0,
    modeSwitchAutoPlan: false,
    goalMaxTurns: 0,
  },
  [USER_PRESENCE_MODE.INVISIBLE]: {
    stance: PRESENCE_STANCE.AUTONOMOUS,
    questionAutoResolveSecs: 30,
    planAutoApproveSecs: 120,
    modeSwitchAutoPlan: false,
    goalMaxTurns: 20,
  },
};

/**
 * Wire shape sent to the Rust runtime. Matches `UserPresence` in
 * `src-tauri/crates/agent-core/src/core/session/types/context.rs`.
 *
 * Carries the fully-resolved mode spec so the backend never needs to
 * know about settings or custom-role storage — any custom mode gets
 * full runtime behavior with zero backend changes.
 */
export interface UserPresenceWire {
  mode: UserPresenceMode;
  /** Display label of the mode ("Online", "Angry", …). */
  label?: string;
  /** ISO-8601 timestamp the user expects to be back (Away only). */
  backAt?: string;
  /** Per-mode prompt addendum configured in Settings → My Role. */
  guidance?: string;
  /** Runtime behavior class. */
  stance?: PresenceStance;
  /** Seconds until pending questions auto-skip. 0 = off. */
  questionAutoResolveSecs?: number;
  /** Seconds until pending plan approvals auto-approve. 0 = off. */
  planAutoApproveSecs?: number;
  /** Whether pending mode-switch suggestions auto-switch to Plan on timeout. */
  modeSwitchAutoPlan?: boolean;
  /** Goal-loop continuation budget. 0 = off. */
  goalMaxTurns?: number;
}

/**
 * Local state shape persisted in the user presence atom. Carries the
 * extra UI bookkeeping (selected away duration) that the wire form
 * doesn't need.
 */
export interface UserPresenceState {
  mode: UserPresenceMode;
  /** Epoch milliseconds when the user expects to be back (Away only). */
  backAtMs?: number;
  /** Convenience label for the Away duration ("30m", "2h", "tomorrow"). */
  awayDurationLabel?: string;
}

export const AWAY_DURATIONS: ReadonlyArray<{
  id: string;
  labelKey: string;
  minutes: number;
}> = [
  {
    id: "15m",
    labelKey: "navigation:sidebar.presence.duration15m",
    minutes: 15,
  },
  {
    id: "30m",
    labelKey: "navigation:sidebar.presence.duration30m",
    minutes: 30,
  },
  { id: "1h", labelKey: "navigation:sidebar.presence.duration1h", minutes: 60 },
  {
    id: "2h",
    labelKey: "navigation:sidebar.presence.duration2h",
    minutes: 120,
  },
  {
    id: "tomorrow",
    labelKey: "navigation:sidebar.presence.durationTomorrow",
    minutes: -1,
  },
];

export function computeBackAtMs(
  durationId: string,
  fromMs = Date.now()
): number {
  const found = AWAY_DURATIONS.find((entry) => entry.id === durationId);
  if (!found) return fromMs + 30 * 60_000;
  if (found.minutes >= 0) {
    return fromMs + found.minutes * 60_000;
  }
  const next = new Date(fromMs);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}

// ────────────────────────────────────────────────────────────────────
// Custom roles
// ────────────────────────────────────────────────────────────────────
//
// Custom roles are an open-ended extension of the built-in three modes
// (Online / Invisible / Away). The user manages them in Settings →
// My Role. Each role gets its own guidance string that's shipped to
// the agent in place of the built-in guidance when that role is the
// active presence mode.

/**
 * Picker palette for custom-role icons. Stored as a string id so the
 * persisted shape doesn't depend on a component reference. The pill /
 * dropdown look up the actual lucide component via `CUSTOM_ROLE_ICONS`
 * in `src/scaffold/NavigationSidebar/blocks/customRoleIcons.ts`.
 */
export type CustomRoleIconId =
  | "user"
  | "briefcase"
  | "code"
  | "rocket"
  | "coffee"
  | "headphones"
  | "book"
  | "compass"
  | "feather"
  | "flame"
  | "shield"
  | "sparkles";

export interface CustomRoleDefinition {
  /** Stable id (slug). Used to build the wire mode `role:<id>`. */
  id: string;
  /** Display name shown in the pill + dropdown. */
  label: string;
  /** Icon id from the curated palette. */
  iconId: CustomRoleIconId;
  /** Per-mode prompt addendum shipped to the agent. */
  guidance: string;
  /** Epoch ms — `Date.now()` at creation; used to keep the list stable. */
  createdAtMs: number;
  /**
   * Behavior policy. Optional for backward compatibility with roles
   * created before the spec redesign — absent fields resolve to the
   * conservative interactive/0/0/0 defaults (same behavior as before).
   */
  stance?: PresenceStance;
  questionAutoResolveSecs?: number;
  planAutoApproveSecs?: number;
  modeSwitchAutoPlan?: boolean;
  goalMaxTurns?: number;
}
