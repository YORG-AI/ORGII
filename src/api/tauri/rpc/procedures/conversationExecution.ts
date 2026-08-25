import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

const domain = schemas.conversationExecution;

export const conversationExecution = {
  get: defineProcedure("conversation_execution_get")
    .input(domain.ConversationExecutionGetInput)
    .output(domain.ConversationExecutionSnapshotSchema.nullable())
    .build(),
  prepareCandidate: defineProcedure("conversation_execution_prepare_candidate")
    .input(domain.ConversationExecutionPrepareCandidateInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  beginMaterialization: defineProcedure(
    "conversation_execution_begin_materialization"
  )
    .input(domain.ConversationExecutionBeginMaterializationInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  activateCandidate: defineProcedure(
    "conversation_execution_activate_candidate"
  )
    .input(domain.ConversationExecutionActivateCandidateInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  abortCandidate: defineProcedure("conversation_execution_abort_candidate")
    .input(domain.ConversationExecutionAbortCandidateInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  advanceCheckpoint: defineProcedure(
    "conversation_execution_advance_checkpoint"
  )
    .input(domain.ConversationExecutionAdvanceCheckpointInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  retireActive: defineProcedure("conversation_execution_retire_active")
    .input(domain.ConversationExecutionRetireActiveInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
  markRunnerTerminal: defineProcedure(
    "conversation_execution_mark_runner_terminal"
  )
    .input(domain.ConversationRunnerIdentityInput)
    .output(domain.ConversationRunnerMutationResultSchema)
    .build(),
  forgetRunner: defineProcedure("conversation_execution_forget_runner")
    .input(domain.ConversationRunnerIdentityInput)
    .output(domain.ConversationRunnerMutationResultSchema)
    .build(),
  listRunnerIdsPage: defineProcedure("conversation_execution_list_runner_ids")
    .input(domain.ConversationRunnerPageInput)
    .output(domain.ConversationRunnerPageSchema)
    .build(),
  listCleanupCandidates: defineProcedure(
    "conversation_execution_list_cleanup_candidates"
  )
    .input(domain.ConversationRunnerCleanupCandidatesInput)
    .output(z.array(domain.ConversationRunnerRegistrationSchema))
    .build(),
  importLegacyRunners: defineProcedure(
    "conversation_execution_import_legacy_runners"
  )
    .input(domain.ConversationExecutionImportLegacyRunnersInput)
    .output(domain.ConversationExecutionMutationResultSchema)
    .build(),
} as const;
