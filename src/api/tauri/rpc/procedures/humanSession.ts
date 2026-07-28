import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

export const humanSession = {
  create: defineProcedure("human_session_create")
    .input(schemas.humanSession.HumanSessionCreateInput)
    .output(schemas.humanSession.HumanSessionSchema)
    .build(),
  get: defineProcedure("human_session_get")
    .input(schemas.humanSession.HumanSessionGetInput)
    .output(schemas.humanSession.HumanSessionSchema)
    .build(),
  append: defineProcedure("human_session_append")
    .input(schemas.humanSession.HumanSessionAppendInput)
    .output(schemas.humanSession.HumanSessionSchema)
    .build(),
  delete: defineProcedure("human_session_delete")
    .input(schemas.humanSession.HumanSessionGetInput)
    .build(),
} as const;
