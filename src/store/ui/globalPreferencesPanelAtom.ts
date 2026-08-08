import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import {
  APPLICATION_PREVIEW_STYLE,
  type ApplicationPreviewStyle,
  normalizeApplicationPreviewStyle,
} from "@src/config/appearance/applicationPreviewStyle";

const APPLICATION_PREVIEW_STYLE_STORAGE_KEY = "orgii:application-preview-style";

export const globalPreferencesPanelOpenAtom = atom(false);
globalPreferencesPanelOpenAtom.debugLabel = "globalPreferencesPanelOpenAtom";

const storedApplicationPreviewStyleAtom = atomWithStorage<unknown>(
  APPLICATION_PREVIEW_STYLE_STORAGE_KEY,
  APPLICATION_PREVIEW_STYLE.COMPACT
);

/**
 * Local-only visual preference shared by the setup preview and the global
 * preferences panel. Unsupported persisted values recover to compact.
 */
export const applicationPreviewStyleAtom = atom(
  (get): ApplicationPreviewStyle =>
    normalizeApplicationPreviewStyle(get(storedApplicationPreviewStyleAtom)),
  (_get, set, value: unknown) => {
    set(
      storedApplicationPreviewStyleAtom,
      normalizeApplicationPreviewStyle(value)
    );
  }
);
applicationPreviewStyleAtom.debugLabel = "applicationPreviewStyleAtom";
