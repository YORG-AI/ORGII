import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const workRuns = {
  conversationTurnAccept: defineProcedure("work_run_conversation_turn_accept")
    .input(schemas.workRuns.ConversationTurnAcceptInput)
    .output(z.string().nullable())
    .build(),
  conversationTurnRelease: defineProcedure("work_run_conversation_turn_release")
    .input(schemas.workRuns.ConversationTurnReleaseInput)
    .output(z.boolean())
    .build(),
  conversationTurnNack: defineProcedure("work_run_conversation_turn_nack")
    .input(schemas.workRuns.ConversationTurnNackInput)
    .output(z.boolean())
    .build(),
  conversationTurnPrepareRunner: defineProcedure(
    "work_run_conversation_turn_prepare_runner"
  )
    .input(schemas.workRuns.ConversationTurnPrepareRunnerInput)
    .build(),
  conversationTurnAckRunner: defineProcedure(
    "work_run_conversation_turn_ack_runner"
  )
    .input(schemas.workRuns.ConversationTurnAckRunnerInput)
    .build(),
} as const;
