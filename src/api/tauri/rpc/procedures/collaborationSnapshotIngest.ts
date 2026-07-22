import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas/collaborationSnapshotIngest";

export const collaborationSnapshotIngest = {
  begin: defineProcedure("collaboration_snapshot_ingest_begin")
    .input(schemas.CollaborationSnapshotIngestBeginInputSchema)
    .output(schemas.CollaborationSnapshotIngestBeginResultSchema)
    .build(),
  getCursor: defineProcedure("collaboration_snapshot_ingest_get_cursor")
    .input(schemas.CollaborationSnapshotIngestGetCursorInputSchema)
    .output(schemas.CollaborationSnapshotCursorSchema.nullable())
    .build(),
  probeSecondary: defineProcedure("collaboration_snapshot_secondary_probe")
    .input(schemas.CollaborationSnapshotSecondaryProbeInputSchema)
    .output(z.boolean())
    .build(),
  applyWirePage: defineProcedure(
    "collaboration_snapshot_ingest_apply_wire_page"
  )
    .input(schemas.CollaborationSnapshotIngestPageInputSchema)
    .output(schemas.CollaborationSnapshotIngestProgressSchema)
    .build(),
  commit: defineProcedure("collaboration_snapshot_ingest_commit")
    .input(schemas.CollaborationSnapshotIngestTokenInputSchema)
    .output(schemas.CollaborationSnapshotIngestCommitResultSchema)
    .build(),
  abort: defineProcedure("collaboration_snapshot_ingest_abort")
    .input(schemas.CollaborationSnapshotIngestTokenInputSchema)
    .output(z.void())
    .build(),
} as const;
