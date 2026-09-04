import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineAppActionRegistration } from "@src/ActionSystem/schema/actionRegistration";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import {
  type GlobalThemePreference,
  THEME_PREFERENCE,
  getGlobalTheme,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { updateSettingsBatchAtom } from "@src/store";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";
import { showThemeTransitionCover } from "@src/util/ui/theme/themeTransitionCover";

const emptyParams = z.object({});

async function applyTheme(
  themePreference: GlobalThemePreference
): Promise<string> {
  const store = getInstrumentedStore();
  const resolvedThemeId = resolveGlobalThemePreference(themePreference);
  const selectedTheme = getGlobalTheme(resolvedThemeId);
  const cover = showThemeTransitionCover();
  try {
    await swapThemeCss(selectedTheme.baseCssPath);
    store.set(updateSettingsBatchAtom, {
      "general.theme": themePreference,
    });
    localStorage.setItem("theme", themePreference);
    return selectedTheme.id;
  } finally {
    await cover.hide();
  }
}

function defineThemeAction(
  id: string,
  themeId: GlobalThemePreference,
  description: string,
  message: string,
  examples: string[]
) {
  return defineZodAction(
    {
      id,
      category: "theme",
      description,
      params: emptyParams,
      layer: "gui",
      examples,
    },
    async () => {
      await applyTheme(themeId);
      return { success: true, message };
    }
  );
}

const themeSetSystem = defineThemeAction(
  ACTION_ID.THEME_SET_SYSTEM,
  THEME_PREFERENCE.SYSTEM,
  "Switch ORGII to follow the system theme",
  "System theme enabled",
  ["follow system theme", "use system theme", "sync theme with system"]
);

const themeSetLight = defineThemeAction(
  ACTION_ID.THEME_SET_LIGHT,
  "light",
  "Switch ORGII to the light theme",
  "Light theme enabled",
  ["use light theme", "switch to light mode", "turn off dark mode"]
);

const themeSetDark = defineThemeAction(
  ACTION_ID.THEME_SET_DARK,
  "dark",
  "Switch ORGII to the dark theme",
  "Dark theme enabled",
  ["use dark theme", "switch to dark mode", "turn on dark mode"]
);

export const themeZodActions = [themeSetSystem, themeSetLight, themeSetDark];

export const themeActionRegistration =
  defineAppActionRegistration(themeZodActions);
