import { globalPreferencesPanelOpenAtom } from "@src/store/ui/globalPreferencesPanelAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export function openGlobalPreferencesPanel(): void {
  getInstrumentedStore().set(globalPreferencesPanelOpenAtom, true);
}

export function closeGlobalPreferencesPanel(): void {
  getInstrumentedStore().set(globalPreferencesPanelOpenAtom, false);
}

export function toggleGlobalPreferencesPanel(): void {
  const store = getInstrumentedStore();
  store.set(
    globalPreferencesPanelOpenAtom,
    !store.get(globalPreferencesPanelOpenAtom)
  );
}
