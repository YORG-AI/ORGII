/**
 * URL Preview Actions (Zod-based)
 *
 * Actions for opening URLs in the editor as preview tabs.
 * Used by agent tools to show web pages to the user.
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { EditorTabService } from "@src/services/workStation/EditorTabService";
import { createUrlPreviewTab } from "@src/store/workstation/tabs/factories";

export const urlPreview = defineZodAction(
  {
    id: ACTION_ID.URL_PREVIEW,
    category: "file",
    layer: "gui",
    description:
      "Open a URL in the editor as a preview tab. Use this to show web pages to the user within the editor area.",
    params: z.object({
      url: z
        .string()
        .url("Must be a valid URL")
        .describe("The URL to preview (must include protocol, e.g., https://)"),
      title: z
        .string()
        .optional()
        .describe("Optional custom title for the tab"),
    }),
    examples: [
      "preview https://github.com",
      "open https://docs.rs in editor",
      "show https://example.com",
    ],
  },
  async ({ url, title }) => {
    try {
      const tab = createUrlPreviewTab(url, title);
      EditorTabService.openTab(tab);

      return {
        success: true,
        message: `Opened URL preview: ${title || url}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to open URL preview: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
);

export const urlPreviewActions = [urlPreview];
