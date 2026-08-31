import {
  BotIcon,
  CpuIcon,
  FlashIcon,
  type IconSvgElement,
  ToolboxIcon,
  Wrench01Icon,
} from "@src/icons";
import type { SlashItemCategory } from "@src/types/extensions";

export const FLYOUT_CATEGORIES = new Set<SlashItemCategory>(["skill", "tool"]);

export const CATEGORY_ORDER: SlashItemCategory[] = ["skill", "action", "tool"];

export const CATEGORY_LABELS: Record<SlashItemCategory, string> = {
  skill: "Skills",
  action: "Actions",
  tool: "MCP Servers",
};

export const MODE_FLYOUT_LABEL = "Mode";
export const MODELS_FLYOUT_LABEL = "Models";

export const ModeIcon = BotIcon;
export const ModelsIcon = CpuIcon;

export function categoryIcon(category: SlashItemCategory): IconSvgElement {
  switch (category) {
    case "skill":
      return ToolboxIcon;
    case "action":
      return FlashIcon;
    case "tool":
      return Wrench01Icon;
  }
}
