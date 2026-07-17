import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";

export const sessionReplyComment = defineZodAction(
  {
    id: ACTION_ID.SESSION_REPLY_COMMENT,
    category: "session",
    description:
      "Post a reply to a review-comment thread during an active address-comments run",
    params: z.object({
      commentId: z
        .string()
        .min(1)
        .describe("Thread head id, exactly as given in the run briefing"),
      body: z.string().min(1).describe("The reply text"),
      localSessionId: z
        .string()
        .optional()
        .describe(
          "Invoking session id — overwritten by the ADE dispatch layer from the trusted ade_action envelope's invokingSessionId field, never honored from agent-supplied params; binds the reply to that session's own run"
        ),
    }),
    layer: "gui",
    tags: ["session", "comments", "cloud"],
    examples: ["reply to review comment"],
  },
  async ({ commentId, body, localSessionId }) => {
    const { replyViaActiveAddressRun } =
      await import("@src/features/Org2Cloud/addressCommentsRun");
    return replyViaActiveAddressRun(commentId, body, localSessionId);
  }
);

export const sessionCommentZodActions = [sessionReplyComment];
