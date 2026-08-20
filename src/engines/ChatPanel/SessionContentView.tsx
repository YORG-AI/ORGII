import { useAtomValue } from "jotai";
import React, { Suspense, lazy } from "react";

import { sessionByIdAtom } from "@src/store/session";
import { isHumanSession } from "@src/util/session/sessionDispatch";

import ChatView, { type ChatViewProps } from "./ChatView";

// Lazy: human sessions are rare, and the view pulls the whole HumanSession
// feature (incl. @tanstack/react-virtual) into the ChatPanel startup graph.
const HumanSessionView = lazy(() =>
  import("@src/features/HumanSession").then((module) => ({
    default: module.HumanSessionView,
  }))
);

/** Route a canonical session row to its purpose-built content surface. */
const SessionContentView: React.FC<ChatViewProps> = (props) => {
  const session = useAtomValue(sessionByIdAtom(props.sessionId));
  const human =
    session?.category === "human_session" || isHumanSession(props.sessionId);

  return human ? (
    <Suspense fallback={null}>
      <HumanSessionView sessionId={props.sessionId} />
    </Suspense>
  ) : (
    <ChatView {...props} />
  );
};

export default SessionContentView;
