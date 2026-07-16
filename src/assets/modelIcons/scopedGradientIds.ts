import { useId } from "react";

/**
 * Allocate document-unique SVG gradient IDs for model icons.
 *
 * Imported .svg files with static url(#…) refs share IDs across every instance
 * on the page. Icons that use linearGradient defs must live as .tsx in this
 * folder and scope their IDs through this helper.
 */
export function useScopedGradientIds<const T extends readonly string[]>(
  baseNames: T
): Record<T[number], string> {
  const uid = useId().replace(/:/g, "");
  const scopedIds = {} as Record<T[number], string>;

  for (const baseName of baseNames) {
    scopedIds[baseName as T[number]] = `${baseName}-${uid}`;
  }

  return scopedIds;
}
