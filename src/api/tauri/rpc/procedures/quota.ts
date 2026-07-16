import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const quota = {
  getZenmuxStatus: defineProcedure("quota_get_zenmux_status")
    .output(schemas.quota.ZenmuxQuotaStatusSchema)
    .build(),

  getContextStatus: defineProcedure("session_get_context_status")
    .input(schemas.quota.SessionContextStatusInput)
    .output(schemas.quota.SessionContextStatusSchema)
    .build(),
} as const;
