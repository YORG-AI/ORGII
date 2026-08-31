import React from "react";

import { ChatBubbleBody } from "@src/components/ChatBubble";

import PortableUserMessageContent from "./PortableUserMessageContent";

export interface UserBubbleProps {
  text: string;
}

export function UserBubble({ text }: UserBubbleProps) {
  return (
    <div className="flex justify-end">
      <ChatBubbleBody variant="sessionUser" className="!max-w-[85%]">
        <PortableUserMessageContent text={text} />
      </ChatBubbleBody>
    </div>
  );
}

UserBubble.displayName = "UserBubble";
