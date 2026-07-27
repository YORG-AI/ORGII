import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const cli = {
  message: defineProcedure("cli_agent_message")
    .input(schemas.cli.CliMessageInputSchema)
    .output(schemas.cli.CliRunReceiptSchema)
    .build(),
  status: defineProcedure("cli_agent_status")
    .input(schemas.cli.CliSessionIdInputSchema)
    .output(schemas.cli.CliStatusSchema.nullable())
    .build(),
  statusBatch: defineProcedure("cli_agent_status_batch")
    .input(schemas.cli.CliStatusBatchInputSchema)
    .output(z.array(schemas.cli.CliStatusBatchItemSchema))
    .build(),
  chunks: defineProcedure("cli_agent_chunks")
    .input(schemas.cli.CliSessionIdInputSchema)
    .output(schemas.cli.CliChunksSchema)
    .build(),
  cancel: defineProcedure("cli_agent_cancel")
    .input(schemas.cli.CliCancelInputSchema)
    .output(z.boolean())
    .build(),
} as const;
