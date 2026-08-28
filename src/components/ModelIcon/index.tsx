/**
 * ModelIcon Component
 *
 * Unified icon component for all AI model providers and agents.
 * Replaces both the old ModelIcon and ProviderIcon components.
 *
 * @example
 * ```tsx
 * // By ModelType (recommended for business logic)
 * <ModelIcon agentType="cursor_cli" />
 * <ModelIcon agentType="anthropic_api" />
 *
 * // By IconProvider (for UI layer)
 * <ModelIcon provider="openai" />
 * <ModelIcon provider="claude" size="large" />
 *
 * // By model name (auto-detection)
 * <ModelIcon modelName="gpt-4o" />
 * <ModelIcon modelName="claude-3-sonnet" />
 * ```
 */
import React, { memo, useMemo } from "react";

import type { ModelType } from "@src/api/types/keys";
import {
  getModelAliasIcon,
  useModelAliasRegistryVersion,
} from "@src/hooks/models/modelAliasRegistry";
import { BoxIcon, HugeiconsIcon } from "@src/icons";

import {
  ICON_MAP,
  type IconProvider,
  THEMEABLE_ICONS,
  getIconProviderFromModelName,
  getIconProviderFromType,
} from "./config";

// Re-export types and functions
export type { IconProvider } from "./config";
export {
  getIconProvider,
  getIconProviderFromModelName,
  hasModelIcon,
  THEMEABLE_ICONS,
} from "./config";

// ============================================
// Types
// ============================================

export interface ModelIconProps {
  /** ModelType for business logic lookups (preferred) */
  agentType?: ModelType | string;
  /** Direct icon provider type (UI layer) */
  provider?: IconProvider;
  /** Model name to auto-detect provider */
  modelName?: string;
  /** Icon size */
  size?: "small" | "medium" | "large" | number;
  /** Additional className */
  className?: string;
  /** Additional styles */
  style?: React.CSSProperties;
  /** Whether the icon is in selected/active state */
  isSelected?: boolean;
  /** Render brand icons as white monochrome (for dark tooltip surfaces) */
  monochrome?: boolean;
  /** Fallback content when icon not found */
  fallback?: React.ReactNode;
}

// Size mapping
const SIZE_MAP: Record<string, number> = {
  small: 14,
  medium: 20,
  large: 28,
};

// ============================================
// Component
// ============================================

const ModelIcon: React.FC<ModelIconProps> = memo(
  ({
    agentType,
    provider: propProvider,
    modelName,
    size = "medium",
    className = "",
    style,
    isSelected = false,
    monochrome = false,
    fallback,
  }) => {
    const modelAliasVersion = useModelAliasRegistryVersion();

    // Determine icon provider from props.
    // When both modelName and agentType are supplied, prefer the model-name
    // inference so that e.g. "gpt-5.4" shows the OpenAI icon even when
    // agentType is "cursor_cli". agentType is still passed as a hint for
    // ambiguous names like "auto".
    const iconProvider = useMemo((): IconProvider => {
      void modelAliasVersion;
      if (propProvider) return propProvider;

      if (modelName) {
        const aliasIcon = getModelAliasIcon(modelName);
        if (aliasIcon) return aliasIcon;
      }

      if (modelName) {
        const fromName = getIconProviderFromModelName(modelName, agentType);
        if (fromName !== "unknown") return fromName;
      }

      if (agentType) {
        return getIconProviderFromType(agentType);
      }

      return "unknown";
    }, [propProvider, agentType, modelName, modelAliasVersion]);

    // Get numeric size
    const numericSize = typeof size === "number" ? size : SIZE_MAP[size] || 20;

    // Get icon component
    const Icon = ICON_MAP[iconProvider];

    // Determine if icon uses currentColor (themeable)
    const isThemeable = THEMEABLE_ICONS.has(iconProvider);

    const colorClass =
      monochrome || className.includes("text-")
        ? ""
        : isThemeable
          ? isSelected
            ? "text-primary-6"
            : "text-text-1"
          : "";

    const monochromeClass = monochrome ? "brightness-0 invert" : "";

    // No icon found
    if (!Icon) {
      if (fallback) {
        return <>{fallback}</>;
      }
      // Default fallback: Box icon
      const fallbackColor = isSelected ? "text-primary-6" : "text-text-2";
      return (
        <HugeiconsIcon
          icon={BoxIcon}
          data-icon="box"
          size={numericSize}
          className={`${fallbackColor} ${className}`.trim()}
          style={style}
        />
      );
    }

    return (
      <Icon
        width={numericSize}
        height={numericSize}
        className={`${colorClass} ${monochromeClass} ${className}`.trim()}
        style={style}
      />
    );
  }
);

ModelIcon.displayName = "ModelIcon";

export default ModelIcon;
