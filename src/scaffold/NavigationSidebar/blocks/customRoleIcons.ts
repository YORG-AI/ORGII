/**
 * Curated icon palette for custom presence roles.
 *
 * Stored as a string id (`CustomRoleIconId`) in user data so the
 * persisted shape doesn't carry a component reference. Every visual
 * surface that needs to render the icon (presence pill, dropdown menu,
 * Settings → My Role list, role editor) resolves the glyph
 * through `resolveCustomRoleIcon`.
 */
import {
  Book01Icon,
  Briefcase01Icon,
  CodeIcon,
  Coffee01Icon,
  CompassIcon,
  FeatherIcon,
  FireIcon,
  HeadphonesIcon,
  type IconSvgElement,
  RocketIcon,
  Shield01Icon,
  SparklesIcon,
  UserIcon,
} from "@src/icons";
import type { CustomRoleIconId } from "@src/types/userPresence";

export const CUSTOM_ROLE_ICONS: Record<CustomRoleIconId, IconSvgElement> = {
  user: UserIcon,
  briefcase: Briefcase01Icon,
  code: CodeIcon,
  rocket: RocketIcon,
  coffee: Coffee01Icon,
  headphones: HeadphonesIcon,
  book: Book01Icon,
  compass: CompassIcon,
  feather: FeatherIcon,
  flame: FireIcon,
  shield: Shield01Icon,
  sparkles: SparklesIcon,
};

export const CUSTOM_ROLE_ICON_IDS: readonly CustomRoleIconId[] = [
  "user",
  "briefcase",
  "code",
  "rocket",
  "coffee",
  "headphones",
  "book",
  "compass",
  "feather",
  "flame",
  "shield",
  "sparkles",
] as const;

export function resolveCustomRoleIcon(id: CustomRoleIconId): IconSvgElement {
  return CUSTOM_ROLE_ICONS[id] ?? UserIcon;
}
