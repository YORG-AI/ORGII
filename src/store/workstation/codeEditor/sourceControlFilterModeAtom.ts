import { atom } from "jotai";

import type { SourceControlFilterMode } from "./sourceControlTypes";

/** Active Source Control sidebar filter (file buckets or git history graph). */
export const sourceControlFilterModeAtom =
  atom<SourceControlFilterMode>("uncommitted");
sourceControlFilterModeAtom.debugLabel = "sourceControlFilterModeAtom";

/** Registered by Code Editor so global header actions can apply filter side effects. */
export const sourceControlFilterModeHandlerAtom = atom<
  ((mode: SourceControlFilterMode) => void) | null
>(null);
sourceControlFilterModeHandlerAtom.debugLabel =
  "sourceControlFilterModeHandlerAtom";
