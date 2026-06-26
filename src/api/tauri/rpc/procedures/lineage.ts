import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const lineage = {
  getSessionImpact: defineProcedure("get_session_impact")
    .input(schemas.lineage.GetSessionImpactInput)
    .output(schemas.lineage.SessionImpactSchema)
    .build(),

  getProvenanceSessionIds: defineProcedure("get_provenance_session_ids")
    .output(z.array(z.string()))
    .build(),

  orgtrackInitialize: defineProcedure("orgtrack_initialize")
    .input(schemas.lineage.OrgtrackExportInput)
    .output(schemas.lineage.OrgtrackExportResultSchema)
    .build(),

  orgtrackScanStart: defineProcedure("orgtrack_scan_start")
    .input(schemas.lineage.OrgtrackScanStartInput)
    .output(schemas.lineage.OrgtrackScanProgressSchema)
    .build(),

  orgtrackScanStatus: defineProcedure("orgtrack_scan_status")
    .input(schemas.lineage.OrgtrackScanStatusInput)
    .output(schemas.lineage.OrgtrackScanProgressSchema.nullable())
    .build(),

  orgtrackScanCancel: defineProcedure("orgtrack_scan_cancel")
    .input(schemas.lineage.OrgtrackScanCancelInput)
    .output(schemas.lineage.OrgtrackScanProgressSchema)
    .build(),

  orgtrackSyncCoreRepo: defineProcedure("orgtrack_sync_core_repo")
    .input(schemas.lineage.OrgtrackIndexInput)
    .output(schemas.lineage.OrgtrackIndexSchema)
    .build(),

  orgtrackExport: defineProcedure("orgtrack_export")
    .input(schemas.lineage.OrgtrackExportInput)
    .output(schemas.lineage.OrgtrackExportResultSchema)
    .build(),

  orgtrackGetIndex: defineProcedure("orgtrack_get_index")
    .input(schemas.lineage.OrgtrackIndexInput)
    .output(schemas.lineage.OrgtrackIndexSchema.nullable())
    .build(),

  orgtrackGetFileTimeline: defineProcedure("orgtrack_get_file_timeline")
    .input(schemas.lineage.OrgtrackFileTimelineInput)
    .output(schemas.lineage.OrgtrackFileTimelineSchema.nullable())
    .build(),

  orgtrackGetSessionSummaries: defineProcedure("orgtrack_get_session_summaries")
    .input(schemas.lineage.OrgtrackSessionSummariesInput)
    .output(z.array(schemas.lineage.CoreSessionSummarySchema))
    .build(),

  orgtrackGetSessionSummary: defineProcedure("orgtrack_get_session_summary")
    .input(schemas.lineage.OrgtrackSessionSummaryInput)
    .output(schemas.lineage.CoreSessionSummarySchema.nullable())
    .build(),

  orgtrackAnalyzeSessions: defineProcedure("orgtrack_analyze_sessions")
    .input(schemas.lineage.OrgtrackAnalyzeSessionsInput)
    .output(schemas.lineage.OrgtrackAnalysisBackfillStatsSchema)
    .build(),

  orgtrackLookupFileSessions: defineProcedure("orgtrack_lookup_file_sessions")
    .input(schemas.lineage.OrgtrackFileSessionLookupInput)
    .output(schemas.lineage.OrgtrackFileSessionLookupSchema.nullable())
    .build(),

  orgtrackGetSourceTierPolicy: defineProcedure(
    "orgtrack_get_source_tier_policy"
  )
    .input(schemas.lineage.OrgtrackSourceTierPolicyInput)
    .output(schemas.lineage.OrgtrackSourceTierPolicySchema)
    .build(),

  orgtrackGetExtractionMemoryGate: defineProcedure(
    "orgtrack_get_extraction_memory_gate"
  )
    .output(schemas.lineage.OrgtrackExtractionMemoryGateSchema)
    .build(),

  orgtrackGetSessionEditArtifacts: defineProcedure(
    "orgtrack_get_session_edit_artifacts"
  )
    .input(schemas.lineage.OrgtrackSessionArtifactQueryInput)
    .output(z.array(schemas.lineage.OrgtrackSessionEditArtifactSchema))
    .build(),

  orgtrackGetSessionDiffChunks: defineProcedure(
    "orgtrack_get_session_diff_chunks"
  )
    .input(schemas.lineage.OrgtrackSessionArtifactQueryInput)
    .output(z.array(schemas.lineage.OrgtrackSessionDiffChunkSchema))
    .build(),

  orgtrackGetSessionFinalDiffs: defineProcedure(
    "orgtrack_get_session_final_diffs"
  )
    .input(schemas.lineage.OrgtrackSessionArtifactQueryInput)
    .output(z.array(schemas.lineage.OrgtrackSessionFinalDiffSchema))
    .build(),

  orgtrackGetDiffReplayPreview: defineProcedure(
    "orgtrack_get_diff_replay_preview"
  )
    .input(schemas.lineage.OrgtrackDiffReplayPreviewInput)
    .output(schemas.lineage.OrgtrackDiffReplayPreviewSchema)
    .build(),

  orgtrackGetSessionCommitLinks: defineProcedure(
    "orgtrack_get_session_commit_links"
  )
    .input(z.object({ sessionId: z.string().optional() }).optional())
    .output(z.array(schemas.lineage.OrgtrackCommitLinkSchema))
    .build(),

  orgtrackGetSessionCheckpoints: defineProcedure(
    "orgtrack_get_session_checkpoints"
  )
    .input(schemas.lineage.OrgtrackSessionArtifactQueryInput)
    .output(z.array(schemas.lineage.OrgtrackSessionCheckpointSchema))
    .build(),

  orgtrackGetCheckpointFileStates: defineProcedure(
    "orgtrack_get_checkpoint_file_states"
  )
    .input(schemas.lineage.OrgtrackCheckpointFileStateInput)
    .output(z.array(schemas.lineage.OrgtrackCheckpointFileStateSchema))
    .build(),
} as const;
