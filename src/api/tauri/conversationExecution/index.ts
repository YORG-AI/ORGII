import { rpc } from "@src/api/tauri/rpc";
import type {
  ConversationExecutionKey,
  ConversationExecutionMutationResult,
  ConversationExecutionSnapshot,
  ConversationRunnerPage,
  ConversationRunnerRegistration,
} from "@src/api/tauri/rpc/schemas/conversationExecution";

export type {
  ConversationExecutionKey,
  ConversationExecutionMutationResult,
  ConversationExecutionSnapshot,
  ConversationRunnerPage,
  ConversationRunnerRegistration,
} from "@src/api/tauri/rpc/schemas/conversationExecution";

export {
  importLegacyConversationRunnerMigration,
  planLegacyConversationRunnerMigration,
} from "./legacyRunnerMigration";
export type { LegacyRunnerMigrationPlan } from "./legacyRunnerMigration";

type ProcedureInput<T> = T extends (input: infer I) => Promise<unknown>
  ? I
  : never;

export function getConversationExecution(
  key: ConversationExecutionKey
): Promise<ConversationExecutionSnapshot | null> {
  return rpc.conversationExecution.get({ request: key });
}

export function prepareConversationExecutionCandidate(
  request: ProcedureInput<
    typeof rpc.conversationExecution.prepareCandidate
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.prepareCandidate({ request });
}

export function beginConversationExecutionMaterialization(
  request: ProcedureInput<
    typeof rpc.conversationExecution.beginMaterialization
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.beginMaterialization({ request });
}

export function activateConversationExecutionCandidate(
  request: ProcedureInput<
    typeof rpc.conversationExecution.activateCandidate
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.activateCandidate({ request });
}

export function abortConversationExecutionCandidate(
  request: ProcedureInput<
    typeof rpc.conversationExecution.abortCandidate
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.abortCandidate({ request });
}

export function advanceConversationExecutionCheckpoint(
  request: ProcedureInput<
    typeof rpc.conversationExecution.advanceCheckpoint
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.advanceCheckpoint({ request });
}

export function retireActiveConversationExecutionEpisode(
  request: ProcedureInput<
    typeof rpc.conversationExecution.retireActive
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.retireActive({ request });
}

export function markConversationRunnerTerminal(
  request: ProcedureInput<
    typeof rpc.conversationExecution.markRunnerTerminal
  >["request"]
) {
  return rpc.conversationExecution.markRunnerTerminal({ request });
}

export function forgetConversationRunner(
  request: ProcedureInput<
    typeof rpc.conversationExecution.forgetRunner
  >["request"]
) {
  return rpc.conversationExecution.forgetRunner({ request });
}

export function listConversationRunnerIdsPage(
  request: ProcedureInput<
    typeof rpc.conversationExecution.listRunnerIdsPage
  >["request"]
): Promise<ConversationRunnerPage> {
  return rpc.conversationExecution.listRunnerIdsPage({ request });
}

export function listConversationRunnerCleanupCandidates(
  request: ProcedureInput<
    typeof rpc.conversationExecution.listCleanupCandidates
  >["request"]
): Promise<ConversationRunnerRegistration[]> {
  return rpc.conversationExecution.listCleanupCandidates({ request });
}

export function importLegacyConversationRunnerRegistry(
  request: ProcedureInput<
    typeof rpc.conversationExecution.importLegacyRunners
  >["request"]
): Promise<ConversationExecutionMutationResult> {
  return rpc.conversationExecution.importLegacyRunners({ request });
}
