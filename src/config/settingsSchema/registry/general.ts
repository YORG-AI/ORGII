import { z } from "zod";

import {
  APPLICATION_UI_FONT_DEFAULT_ID,
  APPLICATION_UI_FONT_IDS,
} from "@src/config/appearance/applicationUiFonts";
import { GLOBAL_THEME_PREFERENCES } from "@src/config/appearance/globalThemes";
import { DEFAULT_PRIMARY_COLOR_PRESET } from "@src/config/appearance/primaryColors";
import {
  FAMILIAR_LANGUAGE_TECH_STACKS,
  TECH_SAVVY_LEVELS,
} from "@src/config/profile/userProfile";
import type { SettingDefinition } from "@src/config/settingsSchema/types";

const USER_PROFILE_PRESET_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  techSavvy: z.enum(["", ...TECH_SAVVY_LEVELS]),
  jobRoles: z.array(z.string()),
  familiarTechStacks: z.array(z.enum(FAMILIAR_LANGUAGE_TECH_STACKS)),
  description: z.string(),
});

export const GENERAL_SETTINGS_REGISTRY = {
  "general.language": {
    // Keep in sync with SUPPORTED_LANGUAGES in src/i18n/index.ts. Any value
    // missing here is silently coerced to the default by validateSettings(),
    // which manifests as the language picker snapping back to English.
    schema: z.enum([
      "system",
      "en",
      "fr",
      "zh",
      "zh-Hant",
      "es",
      "ru",
      "pt",
      "de",
      "ja",
      "ko",
      "tr",
      "vi",
      "pl",
    ]),
    default: "system",
    description:
      "Application display language, or system to follow the OS/browser preference",
    category: "general",
    enumLabels: {
      system: "Follow system",
      en: "English",
      fr: "Français",
      zh: "简体中文",
      "zh-Hant": "繁體中文",
      es: "Español",
      ru: "Русский",
      pt: "Português",
      de: "Deutsch",
      ja: "日本語",
      ko: "한국어",
      tr: "Türkçe",
      vi: "Tiếng Việt",
      pl: "Polski",
    },
  },
  "general.theme": {
    schema: z.enum(GLOBAL_THEME_PREFERENCES),
    default: "system",
    description:
      "Global UI theme preference, or system to follow the OS color scheme",
    category: "general",
    enumLabels: {
      system: "Follow system",
      "github-light": "ORGII Light",
      "github-dark": "ORGII Dark",
      "orgii-high-contrast": "ORGII High Contrast",
    },
  },
  "general.primaryColor": {
    schema: z.enum([
      "blue",
      "violet",
      "green",
      "teal",
      "orange",
      "gold",
      "red",
      "rose",
      "mono",
    ]),
    default: DEFAULT_PRIMARY_COLOR_PRESET,
    description: "Primary accent color preset for interactive UI elements",
    category: "general",
    enumLabels: {
      blue: "Blue",
      violet: "Violet",
      green: "Green",
      teal: "Teal",
      orange: "Orange",
      gold: "Gold",
      red: "Red",
      rose: "Rose",
      mono: "Mono",
    },
  },
  "general.uiScale": {
    schema: z.number().min(75).max(150),
    default: 100,
    description: "UI scale percentage (75-150)",
    category: "general",
  },
  "general.applicationUiFont": {
    schema: z.enum(APPLICATION_UI_FONT_IDS),
    default: APPLICATION_UI_FONT_DEFAULT_ID,
    description:
      "Interface font stack for the main app (code surfaces keep editor monospace)",
    category: "general",
    enumLabels: {
      default: "Default (PingFang)",
      systemUi: "Follow OS system",
      vscodeMac: "VS Code (macOS)",
      vscodeWindows: "VS Code (Windows)",
      vscodeLinux: "VS Code (Linux)",
      helveticaNeue: "Helvetica Neue style",
    },
  },
  "general.spotlightPlacement": {
    schema: z.enum(["top", "center"]),
    default: "top" as const,
    description:
      'Spotlight placement: "top" keeps the command palette near the top edge; "center" places it in the center of the page',
    category: "general",
    enumLabels: {
      top: "Top",
      center: "Page center",
    },
  },
  "layout.sidebarSelectedRowOpacity": {
    schema: z.number().min(0).max(20),
    default: 5,
    description: "Selected sidebar row highlight intensity percentage",
    category: "general",
  },
  "layout.sidebarEdgeDepthEnabled": {
    schema: z.boolean(),
    default: true,
    description:
      "Show a theme-aware depth edge between the macOS sidebar and content panel",
    category: "general",
  },
  "general.workStationChatPosition": {
    schema: z.enum(["left", "right"]),
    default: "left" as const,
    description: "Chat panel side for My Station layouts",
    category: "general",
    enumLabels: {
      left: "Left",
      right: "Right",
    },
  },
  "general.sessionChatPosition": {
    schema: z.enum(["left", "right"]),
    default: "left" as const,
    description: "Chat panel side for Agent Station layouts",
    category: "general",
    enumLabels: {
      left: "Left",
      right: "Right",
    },
  },
  "general.chatTurnPaginationEnabled": {
    schema: z.boolean(),
    default: false,
    description:
      "Show chat history as turn-based rounds instead of one continuous list",
    category: "general",
  },
  "general.modelPickerStyle": {
    schema: z.enum(["spotlight", "dropdown"]),
    default: "spotlight" as const,
    description:
      "Presentation style for the chat panel model picker: a full Spotlight palette or a compact anchored dropdown",
    category: "general",
    enumLabels: {
      spotlight: "Spotlight",
      dropdown: "Menu",
    },
  },
  "general.userDisplayName": {
    schema: z.string(),
    default: "",
    description: "User display name shown in the app",
    category: "general",
  },
  "general.profileTechSavvy": {
    schema: z.enum(["", ...TECH_SAVVY_LEVELS]),
    default: "" as const,
    description:
      "User's technical familiarity level for calibrating agent explanations",
    category: "general",
    enumLabels: {
      beginner: "Beginner",
      intermediate: "Intermediate",
      advanced: "Advanced",
      expert: "Expert",
    },
  },
  "general.profileJobRoles": {
    schema: z.array(z.string()),
    default: [],
    description: "Job-role labels that describe the user's work",
    category: "general",
  },
  "general.profileFamiliarTechStacks": {
    schema: z.array(z.enum(FAMILIAR_LANGUAGE_TECH_STACKS)),
    default: [],
    description:
      "Programming languages and technology stacks familiar to the user",
    category: "general",
  },
  "general.profileDescription": {
    schema: z.string(),
    default: "",
    description: "Short user profile background for agent context",
    category: "general",
  },
  "general.activeProfileId": {
    schema: z.string(),
    default: "default",
    description: "ID of the user profile preset currently sent to agents",
    category: "general",
  },
  "general.profilePresets": {
    schema: z.array(USER_PROFILE_PRESET_SCHEMA),
    default: [],
    description: "Named user profile presets for manual profile switching",
    category: "general",
  },
  "general.timezone": {
    schema: z.string(),
    default: "auto",
    description:
      'Timezone for date/time display: "auto" (system default), "utc", or an IANA timezone name (e.g. "America/New_York")',
    category: "general",
  },
  "general.preventSleepWhileRunning": {
    schema: z.boolean(),
    default: false,
    description:
      "Prevent the system from sleeping while any agent session is actively working. Releases automatically when all sessions finish or the toggle is turned off",
    category: "general",
  },
  "general.autoUpdateEnabled": {
    schema: z.boolean(),
    default: true,
    description:
      "Automatically check for app updates, install them during startup, and download them silently while the app is running",
    category: "general",
  },
  "general.updateChannel": {
    schema: z.enum(["auto", "stable", "beta"]),
    default: "auto",
    description:
      "Release channel for app updates. auto follows the installed build (prerelease builds track beta, release builds track stable); stable and beta pin the channel explicitly. Switching from beta to stable never downgrades — it takes effect at the next stable release",
    category: "general",
  },
  "general.setupWalkthroughOutcome": {
    schema: z.enum(["open", "completed", "dismissed"]),
    default: "open",
    description:
      "First-use setup walkthrough outcome. Open shows the walkthrough automatically; completed and dismissed keep it closed",
    category: "general",
  },
  "general.githubStarPromptCompleted": {
    schema: z.boolean(),
    default: false,
    description:
      "Whether GitHub has confirmed that the current user starred the canonical ORG2 repository",
    category: "general",
  },
  "general.githubStarPromptDisabled": {
    schema: z.boolean(),
    default: false,
    description: "Permanently disable the optional GitHub Star reminder",
    category: "general",
  },
  "general.githubStarPromptDeferredUntil": {
    schema: z.number().nonnegative(),
    default: 0,
    description:
      "Unix timestamp in milliseconds before the GitHub Star reminder may appear again",
    category: "general",
  },
  "general.githubStarPromptLastShownAt": {
    schema: z.number().nonnegative(),
    default: 0,
    description:
      "Unix timestamp in milliseconds when the GitHub Star reminder was last shown",
    category: "general",
  },
  "general.githubStarPromptNextEligibleValueCount": {
    schema: z.number().int().positive(),
    default: 1,
    description:
      "Value-moment count required before the optional GitHub Star reminder is eligible",
    category: "general",
  },
  "general.voiceInputEnabled": {
    schema: z.boolean(),
    default: true,
    description:
      "Show the microphone button in composer toolbars and bind the Ctrl+M shortcut for push-to-talk dictation. Disabling hides the button everywhere",
    category: "general",
  },
  "general.secretScanEnabled": {
    schema: z.boolean(),
    default: true,
    description:
      "Scan composer input (new session prompts and follow-up messages) for API keys, tokens, and passwords, and ask for confirmation before sending them to the model",
    category: "general",
  },
  "general.secretScanEntropyEnabled": {
    schema: z.boolean(),
    default: false,
    description:
      "In addition to known key formats, flag long high-entropy (random-looking) strings as possible secrets. Catches more but may occasionally flag hashes or IDs",
    category: "general",
  },
  "general.secretScanCustomPatterns": {
    schema: z.array(z.string()),
    default: [],
    description:
      "User-defined regular expressions (one per entry) whose matches are treated as secrets by the composer secret scanner. Invalid expressions are ignored",
    category: "general",
  },
  "general.presenceGuidanceOnline": {
    schema: z.string(),
    default:
      "I am at the keyboard. Feel free to ask me clarifying questions at any time and confirm any destructive actions with me before running them",
    description:
      "Per-mode prompt addendum injected when the user's presence is set to Online",
    category: "general",
  },
  "general.presenceGuidanceInvisible": {
    schema: z.string(),
    default:
      "I am around but appearing offline. Default to autonomous execution and only notify me for high-risk actions or significant refactoring work; batch any other questions into a single summary instead of asking one by one",
    description:
      "Per-mode prompt addendum injected when the user's presence is set to Invisible",
    category: "general",
  },
  "general.presenceGuidanceAway": {
    schema: z.string(),
    default:
      "I am away from the keyboard. Do not block on me — make the best decision you can with the information you have, finish what you can finish, and leave a concise summary of what happened and any open questions for when I return",
    description:
      "Per-mode prompt addendum injected when the user's presence is set to Away",
    category: "general",
  },
} as const satisfies Record<string, SettingDefinition>;
