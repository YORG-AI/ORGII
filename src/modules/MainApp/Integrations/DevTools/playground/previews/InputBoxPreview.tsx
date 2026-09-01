import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import InputArea from "@src/engines/ChatPanel/InputArea";

export function InputBoxPreview() {
  return (
    <div className="tool-event-preview-shell tool-event-preview-shell--chat">
      <div className="tool-event-preview-shell__content tool-event-preview-shell__content--chat">
        <div className="flex min-h-0 flex-1 items-center justify-center text-text-3">
          No events to display
        </div>
        <ChatProvider>
          <div className="flex w-full shrink-0 flex-col items-center px-2 py-2">
            <div className="flex w-full max-w-[800px] flex-col gap-1.5">
              <InputArea />
            </div>
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}
