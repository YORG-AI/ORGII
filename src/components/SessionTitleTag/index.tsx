import React from "react";

import Tag, { type TagProps } from "@src/components/Tag";

/**
 * Compact annotation tag rendered beside a session title.
 *
 * Session headers carry more than one kind of annotation — where a transcript
 * came from (`ClientOriginBadge`) and what the session is (`SubagentBadge`) —
 * and they sit side by side on the same row. Their shared sizing lives here so
 * they cannot drift apart one caller at a time.
 *
 * `Tag`'s smallest size (`mini`: 12px text, 2px/8px padding) still reads as a
 * control next to a session name, where these are annotations. Tighten it here
 * rather than adding a size to the shared component for these callers — `!`
 * overrides win against the SCSS size class regardless of sheet order.
 */
const COMPACT_TAG_CLASS = "!px-1.5 !py-0 !text-[10px] !leading-4";

export interface SessionTitleTagProps {
  color?: TagProps["color"];
  size?: "mini" | "small";
  /** Native tooltip. `Tag` exposes no `title`, so the wrapper carries it. */
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export default function SessionTitleTag({
  color = "default",
  size = "mini",
  title,
  className,
  children,
}: SessionTitleTagProps) {
  return (
    <span title={title}>
      <Tag
        color={color}
        size={size}
        className={
          className ? `${COMPACT_TAG_CLASS} ${className}` : COMPACT_TAG_CLASS
        }
      >
        {children}
      </Tag>
    </span>
  );
}
