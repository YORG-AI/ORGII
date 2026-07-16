/**
 * User Presence Atom
 *
 * QQ-style availability the user toggles from the sidebar footer. Persisted
 * to `localStorage` so the chosen mode survives reloads. Read by:
 *
 * - `SidebarBottomBar` → renders the presence pill + menu.
 * - `AdeContextCollector` → ships the wire snapshot with every agent turn.
 *
 * The atom holds the local-only `UserPresenceState` (mode + back-at + label);
 * conversion to the wire shape happens in `selectUserPresenceWire` so the
 * Rust agent never sees the convenience fields.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { settingsAtom } from "@src/store/settings/settingsAtom";
import {
  BUILT_IN_PRESENCE_POLICY,
  type BuiltInPresenceMode,
  PRESENCE_STANCE,
  type PresenceModeSpec,
  USER_PRESENCE_MODE,
  type UserPresenceMode,
  type UserPresenceState,
  type UserPresenceWire,
  isBuiltInPresenceMode,
  parseCustomRoleId,
} from "@src/types/userPresence";

import { customRoleByIdAtom } from "./userRolesAtom";

const STORAGE_KEY = "orgii:userPresence";

const DEFAULT_PRESENCE: UserPresenceState = {
  mode: USER_PRESENCE_MODE.ONLINE,
};

export const userPresenceAtom = atomWithStorage<UserPresenceState>(
  STORAGE_KEY,
  DEFAULT_PRESENCE
);

/**
 * Derived: writable convenience for changing just the mode. Clears Away
 * bookkeeping when leaving Away so a subsequent Away pick starts fresh.
 */
export const userPresenceModeAtom = atom(
  (get) => get(userPresenceAtom).mode,
  (get, set, next: UserPresenceMode) => {
    const current = get(userPresenceAtom);
    if (next === USER_PRESENCE_MODE.AWAY) {
      set(userPresenceAtom, { ...current, mode: next });
      return;
    }
    set(userPresenceAtom, {
      mode: next,
      backAtMs: undefined,
      awayDurationLabel: undefined,
    });
  }
);

function builtInGuidanceKey(mode: BuiltInPresenceMode): string {
  switch (mode) {
    case USER_PRESENCE_MODE.ONLINE:
      return "general.presenceGuidanceOnline";
    case USER_PRESENCE_MODE.INVISIBLE:
      return "general.presenceGuidanceInvisible";
    case USER_PRESENCE_MODE.AWAY:
      return "general.presenceGuidanceAway";
  }
}

const BUILT_IN_LABELS: Record<BuiltInPresenceMode, string> = {
  [USER_PRESENCE_MODE.ONLINE]: "Online",
  [USER_PRESENCE_MODE.INVISIBLE]: "Invisible",
  [USER_PRESENCE_MODE.AWAY]: "Away",
};

type PresencePolicyByMode = Partial<Record<string, number>>;
type PresenceBooleanPolicyByMode = Partial<Record<string, boolean>>;

function policyNumber(
  byPresence: unknown,
  mode: BuiltInPresenceMode,
  fallback: number
): number {
  if (byPresence && typeof byPresence === "object") {
    const value = (byPresence as PresencePolicyByMode)[mode];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return fallback;
}

function policyBoolean(
  byPresence: unknown,
  mode: BuiltInPresenceMode,
  fallback: boolean
): boolean {
  if (byPresence && typeof byPresence === "object") {
    const value = (byPresence as PresenceBooleanPolicyByMode)[mode];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return fallback;
}

/**
 * Derived: the fully-resolved spec for any mode id. Built-in modes draw
 * guidance from Settings → My Role textareas and policy numbers from the
 * three by-presence settings objects; custom-role modes draw everything
 * from the role definition (with conservative interactive/0/0/0 defaults
 * for roles created before the spec redesign).
 *
 * Returns `undefined` only for a stale `role:<id>` whose role was
 * deleted — callers then treat the presence as unset.
 */
export const presenceModeSpecResolverAtom = atom(
  (get) =>
    (mode: UserPresenceMode): PresenceModeSpec | undefined => {
      if (isBuiltInPresenceMode(mode)) {
        const settings = get(settingsAtom);
        const raw = settings[builtInGuidanceKey(mode) as keyof typeof settings];
        const guidance = typeof raw === "string" ? raw.trim() : "";
        const policy = BUILT_IN_PRESENCE_POLICY[mode];
        const questionByPresence =
          settings["agent.sde.questionAutoSkipTimeoutByPresence"];
        const planByPresence =
          settings["agent.sde.planAutoApproveTimeoutByPresence"];
        const modeSwitchByPresence =
          settings["agent.sde.modeSwitchAutoPlanByPresence"];
        const goalByPresence = settings["agent.sde.goalMaxTurnsByPresence"];
        return {
          id: mode,
          label: BUILT_IN_LABELS[mode],
          guidance,
          stance: policy.stance,
          questionAutoResolveSecs: policyNumber(
            questionByPresence,
            mode,
            policy.questionAutoResolveSecs
          ),
          planAutoApproveSecs: policyNumber(
            planByPresence,
            mode,
            policy.planAutoApproveSecs
          ),
          modeSwitchAutoPlan: policyBoolean(
            modeSwitchByPresence,
            mode,
            policy.modeSwitchAutoPlan
          ),
          goalMaxTurns: policyNumber(goalByPresence, mode, policy.goalMaxTurns),
          builtIn: true,
        };
      }

      const roleId = parseCustomRoleId(mode);
      if (!roleId) return undefined;
      const role = get(customRoleByIdAtom).get(roleId);
      if (!role) return undefined;
      return {
        id: mode,
        label: role.label,
        iconId: role.iconId,
        guidance: role.guidance.trim(),
        stance: role.stance ?? PRESENCE_STANCE.INTERACTIVE,
        questionAutoResolveSecs: role.questionAutoResolveSecs ?? 0,
        planAutoApproveSecs: role.planAutoApproveSecs ?? 0,
        modeSwitchAutoPlan: role.modeSwitchAutoPlan ?? false,
        goalMaxTurns: role.goalMaxTurns ?? 0,
        builtIn: false,
      };
    }
);

/** Derived: the resolved spec for the currently active mode. */
export const activePresenceModeSpecAtom = atom(
  (get): PresenceModeSpec | undefined => {
    const presence = get(userPresenceAtom);
    return get(presenceModeSpecResolverAtom)(presence.mode);
  }
);

/**
 * Derived: wire snapshot for the agent runtime. Ships the fully-resolved
 * mode spec (label + guidance + stance + policy numbers) so the Rust
 * side never needs to know about settings or custom-role storage —
 * any custom mode gets full runtime behavior with zero backend changes.
 *
 * Returns `undefined` only when the active mode resolves to nothing
 * (stale `role:<id>` whose role was deleted) — the consumer then skips
 * the `user_presence` system-prompt section entirely.
 */
export const userPresenceWireAtom = atom<UserPresenceWire | undefined>(
  (get) => {
    const presence = get(userPresenceAtom);
    const spec = get(presenceModeSpecResolverAtom)(presence.mode);
    if (!spec) return undefined;

    const wire: UserPresenceWire = {
      mode: presence.mode,
      label: spec.label,
      stance: spec.stance,
      questionAutoResolveSecs: spec.questionAutoResolveSecs,
      planAutoApproveSecs: spec.planAutoApproveSecs,
      modeSwitchAutoPlan: spec.modeSwitchAutoPlan,
      goalMaxTurns: spec.goalMaxTurns,
    };

    if (presence.mode === USER_PRESENCE_MODE.AWAY && presence.backAtMs) {
      wire.backAt = new Date(presence.backAtMs).toISOString();
    }

    if (spec.guidance) {
      wire.guidance = spec.guidance;
    }

    return wire;
  }
);
