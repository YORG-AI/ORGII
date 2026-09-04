/**
 * SlashCommandPortal — public entry point.
 *
 * Thin wrapper that returns null when not visible. The menu must keep a stable
 * component identity while visible because first-open data hydration can change
 * the slash item list immediately after the panel appears.
 */
import React from "react";

import SlashCommandMenu from "./SlashCommandMenu";
import type { SlashCommandPortalProps } from "./types";

export type { SlashCommandPortalProps } from "./types";

const SlashCommandPortal: React.FC<SlashCommandPortalProps> = (props) => {
  const { visible } = props;

  if (!visible) return null;

  return <SlashCommandMenu {...props} />;
};

SlashCommandPortal.displayName = "SlashCommandPortal";

export default SlashCommandPortal;
