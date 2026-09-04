/**
 * FloatingExpandPill
 *
 * Reusable hover-visible pill for expand / collapse toggling inside
 * overflow containers.  Render it:
 *   - Inside a `overflow-y: auto` parent with `position: sticky; bottom`
 *     so it anchors to the visible bottom edge (expanded state).
 *   - As an `absolute`-positioned overlay on a clipped container
 *     (collapsed state).
 *
 * The pill itself is purely visual — positioning is the caller's job.
 * Visibility is driven by a parent with the Tailwind `group` class
 * (opacity-0 → group-hover:opacity-100).
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import { ChevronsDownUpIcon, UnfoldMoreIcon } from "@src/icons";

interface FloatingExpandPillProps {
  expanded: boolean;
  onClick: (e: React.MouseEvent) => void;
  label?: string;
  showLabel?: boolean;
}

const FloatingExpandPill: React.FC<FloatingExpandPillProps> = ({
  expanded,
  onClick,
  label,
  showLabel = false,
}) => {
  const { t } = useTranslation();
  const text =
    label ?? (expanded ? t("common:showLess") : t("common:showMore"));

  const Icon = expanded ? ChevronsDownUpIcon : UnfoldMoreIcon;

  return (
    <Button
      variant="secondary"
      appearance="solid"
      size="mini"
      shape={showLabel ? "round" : "circle"}
      iconOnly={!showLabel}
      icon={<AnyIcon icon={Icon} size={16} strokeWidth={2.25} />}
      className="pointer-events-auto shadow-xs backdrop-blur-xs"
      onClick={onClick}
      aria-label={text}
      title={text}
    >
      {showLabel ? text : null}
    </Button>
  );
};

export default React.memo(FloatingExpandPill);
