/**
 * MyRoles constants
 *
 * Shared tab identifiers and presence-guidance defaults for the My Roles
 * section.
 */
import { CircleIcon, HatGlassesIcon, MoonIcon } from "@src/icons";
import { USER_PRESENCE_MODE } from "@src/types/userPresence";

export const MY_ROLES_TAB = {
  PRESENCE: "presence",
  PROFILE: "profile",
} as const;

export type MyRolesTab = (typeof MY_ROLES_TAB)[keyof typeof MY_ROLES_TAB];

export type PresenceGuidanceKey =
  | "general.presenceGuidanceOnline"
  | "general.presenceGuidanceInvisible"
  | "general.presenceGuidanceAway";

export const PRESENCE_GUIDANCE_DEFAULT_VALUES: Record<
  PresenceGuidanceKey,
  string[]
> = {
  "general.presenceGuidanceOnline": [
    "I am at the keyboard. Feel free to ask me clarifying questions at any time and confirm any destructive actions with me before running them.",
    "I am at the keyboard. Feel free to ask me clarifying questions at any time and confirm any destructive actions with me before running them",
  ],
  "general.presenceGuidanceInvisible": [
    "I am around but appearing offline. Default to autonomous execution and only notify me for high-risk actions or significant refactoring work; batch any other questions into a single summary instead of asking one by one.",
    "I am around but appearing offline. Default to autonomous execution and only notify me for high-risk actions or significant refactoring work; batch any other questions into a single summary instead of asking one by one",
  ],
  "general.presenceGuidanceAway": [
    "I am away from the keyboard. Do not block on me — make the best decision you can with the information you have, finish what you can finish, and leave a concise summary of what happened and any open questions for when I return.",
    "I am away from the keyboard. Do not block on me — make the best decision you can with the information you have, finish what you can finish, and leave a concise summary of what happened and any open questions for when I return",
  ],
};

export const PRESENCE_GUIDANCE_DEFAULT_I18N_KEYS: Record<
  PresenceGuidanceKey,
  string
> = {
  "general.presenceGuidanceOnline": "general.presenceGuidanceOnlineDefault",
  "general.presenceGuidanceInvisible":
    "general.presenceGuidanceInvisibleDefault",
  "general.presenceGuidanceAway": "general.presenceGuidanceAwayDefault",
};

export const CUSTOM_ROLE_COLOR_CLASS = "text-primary-6";

export const BUILT_IN_STATUS_OPTIONS = [
  {
    mode: USER_PRESENCE_MODE.ONLINE,
    labelKey: "sidebar.presence.online",
    icon: CircleIcon,
    colorClass: "text-success-6",
  },
  {
    mode: USER_PRESENCE_MODE.INVISIBLE,
    labelKey: "sidebar.presence.invisible",
    icon: HatGlassesIcon,
    colorClass: "text-text-3",
  },
  {
    mode: USER_PRESENCE_MODE.AWAY,
    labelKey: "sidebar.presence.away",
    icon: MoonIcon,
    colorClass: "text-warning-6",
  },
] as const;
