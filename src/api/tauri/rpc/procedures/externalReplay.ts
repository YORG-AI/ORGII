import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas/externalReplay";

export const externalReplay = {
  openWindow: defineProcedure("external_replay_open_window")
    .input(schemas.ExternalReplayOpenWindowInput)
    .output(schemas.ExternalReplayWindowSchema)
    .build(),
  pollDelta: defineProcedure("external_replay_poll_delta")
    .input(schemas.ExternalReplayPollDeltaInput)
    .output(schemas.ExternalReplayDeltaSchema)
    .build(),
  readWindow: defineProcedure("external_replay_read_window")
    .input(schemas.ExternalReplayReadWindowInput)
    .output(schemas.ExternalReplayWindowSchema)
    .build(),
  queryWindow: defineProcedure("external_replay_query_window")
    .input(schemas.ExternalReplayQueryWindowInput)
    .output(schemas.ExternalReplayWindowSchema)
    .build(),
  handoff: defineProcedure("external_replay_handoff")
    .input(schemas.ExternalReplayHandoffInput)
    .output(schemas.ExternalReplayHandoffSchema)
    .build(),
  applyQueryWindow: defineProcedure("external_replay_apply_query_window")
    .input(schemas.ExternalReplayApplyQueryWindowInput)
    .output(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
    .build(),
  release: defineProcedure("external_replay_release")
    .input(schemas.ExternalReplayReleaseInput)
    .output(z.void())
    .build(),
  readPayloadRange: defineProcedure("external_replay_read_payload_range")
    .input(schemas.ExternalReplayReadPayloadRangeInput)
    .output(schemas.ExternalReplayPayloadRangeSchema)
    .build(),
  streamExport: defineProcedure("external_replay_stream_export")
    .input(schemas.ExternalReplayStreamExportInput)
    .output(schemas.ExternalReplayExportResultSchema)
    .build(),
  cloudPrepare: defineProcedure("external_replay_cloud_prepare")
    .input(schemas.ExternalReplayCloudPrepareInput)
    .output(schemas.ExternalReplayCloudManifestSchema)
    .build(),
  cloudReadBatch: defineProcedure("external_replay_cloud_read_batch")
    .input(schemas.ExternalReplayCloudReadBatchInput)
    .output(schemas.ExternalReplayCloudBatchSchema)
    .build(),
  cloudPrefixHash: defineProcedure("external_replay_cloud_prefix_hash")
    .input(schemas.ExternalReplayCloudPrefixHashInput)
    .output(schemas.ExternalReplayCloudPrefixHashSchema)
    .build(),
  cloudRelease: defineProcedure("external_replay_cloud_release")
    .input(schemas.ExternalReplayCloudReleaseInput)
    .output(z.void())
    .build(),
} as const;
