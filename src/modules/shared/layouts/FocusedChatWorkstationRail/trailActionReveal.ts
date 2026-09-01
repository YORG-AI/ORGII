/**
 * Header action buttons in the trail (mini-terminal toggle, rail collapse)
 * stay invisible until the trail is hovered or the control is focused, so the
 * chrome does not compete with the section content at rest.
 */
export const WORKSTATION_TRAIL_ACTION_REVEAL_CLASS =
  "pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/workstation-trail:pointer-events-auto group-hover/workstation-trail:opacity-100";
