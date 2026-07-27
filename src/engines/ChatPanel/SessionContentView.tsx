import { useAtomValue } from "jotai";
import React from "react";

import { HumanSessionView } from "@src/features/HumanSession";
import { sessionByIdAtom } from "@src/store/session";
import { isHumanSession } from "@src/util/session/sessionDispatch";

import ChatView, { type ChatViewProps } from "./ChatView";

/** Route a canonical session row to its purpose-built content surface. */
const SessionContentView: React.FC<ChatViewProps> = (props) => {
  const session = useAtomValue(sessionByIdAtom(props.sessionId));
  const human =
    session?.category === "human_session" || isHumanSession(props.sessionId);

  return human ? (
    <HumanSessionView sessionId={props.sessionId} />
  ) : (
    <ChatView {...props} />
  );
};

export default SessionContentView;
