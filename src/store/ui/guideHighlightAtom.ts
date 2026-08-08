import { atom } from "jotai";

export interface GuideHighlightState {
  targetId: string;
  title?: string;
  message: string;
  createdAt: number;
}

export const guideHighlightAtom = atom<GuideHighlightState | null>(null);
guideHighlightAtom.debugLabel = "guideHighlightAtom";

export const showGuideHighlightAtom = atom(
  null,
  (_get, set, payload: Omit<GuideHighlightState, "createdAt">) => {
    set(guideHighlightAtom, {
      ...payload,
      createdAt: Date.now(),
    });
  }
);
showGuideHighlightAtom.debugLabel = "showGuideHighlightAtom";

export const clearGuideHighlightAtom = atom(null, (_get, set) => {
  set(guideHighlightAtom, null);
});
clearGuideHighlightAtom.debugLabel = "clearGuideHighlightAtom";

/** Clear a guide only when the caller still owns the highlighted target. */
export const clearGuideHighlightTargetAtom = atom(
  null,
  (get, set, targetId: string) => {
    if (get(guideHighlightAtom)?.targetId === targetId) {
      set(guideHighlightAtom, null);
    }
  }
);
clearGuideHighlightTargetAtom.debugLabel = "clearGuideHighlightTargetAtom";
