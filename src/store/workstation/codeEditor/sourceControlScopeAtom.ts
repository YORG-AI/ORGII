import { atom } from "jotai";

import type { SourceControlScopeMap } from "./sourceControlTypes";

/** Per-repo Source Control scope for the current app session (not persisted). */
export const sourceControlScopeMapAtom = atom<SourceControlScopeMap>({});
sourceControlScopeMapAtom.debugLabel = "sourceControlScopeMapAtom";
