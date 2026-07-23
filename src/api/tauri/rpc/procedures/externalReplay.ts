import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas/externalReplay";

// Tauri serializes Rust `()` as JSON `null`. Normalize that wire value back
// to TypeScript `void` so best-effort release calls do not report a false
// validation failure after the backend has already released the resources.
const TauriUnit = z.null().transform(() => undefined);

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
  prewarmWindow: defineProcedure("external_replay_prewarm_window")
    .input(schemas.ExternalReplayPrewarmWindowInput)
    .output(schemas.ExternalReplayWindowSchema)
    .build(),
  release: defineProcedure("external_replay_release")
    .input(schemas.ExternalReplayReleaseInput)
    .output(TauriUnit)
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
    .output(TauriUnit)
    .build(),
} as const;
