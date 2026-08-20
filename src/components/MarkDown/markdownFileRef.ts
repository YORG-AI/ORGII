export interface MarkdownFileRef {
  path: string;
  /** 1-based line parsed from a trailing `:line` or `:line:column`. */
  line?: number;
}

/**
 * Split the source location syntax used by agent-authored markdown links from
 * the filesystem path that the WorkStation must open.
 */
export function parseMarkdownFileRef(ref: string): MarkdownFileRef {
  const trimmed = ref.trim();
  const locationMatch = /:([0-9]+)(?::[0-9]+)?$/.exec(trimmed);
  if (!locationMatch || locationMatch.index === 0) return { path: trimmed };

  const line = Number(locationMatch[1]);
  if (!Number.isSafeInteger(line) || line < 1) return { path: trimmed };

  return {
    path: trimmed.slice(0, locationMatch.index),
    line,
  };
}
