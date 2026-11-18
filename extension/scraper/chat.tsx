import { useRef } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

function Message() {
  return (
    <MessagePrimitive.Root className="chat-message">
      <span className="speaker">
        <AuiIf condition={(s) => s.message.role === "user"}>You</AuiIf>
        <AuiIf condition={(s) => s.message.role === "assistant"}>Scraper</AuiIf>
      </span>
      <MessagePrimitive.Content />
    </MessagePrimitive.Root>
  );
}

export function Chat({
  messages,
  running,
  disabled,
  requestPermission,
  onSend,
  onCancel,
}: {
  messages: ThreadMessageLike[];
  running: boolean;
  disabled: boolean;
  requestPermission: () => Promise<boolean>;
  onSend: (text: string, permission: Promise<boolean>) => void;
  onCancel: () => void;
}) {
  const permission = useRef<Promise<boolean> | undefined>(undefined);
  function preparePermission() {
    if (disabled || running) return;
    // Firefox requires the original click/submit gesture, before runtime work.
    permission.current = requestPermission();
    void permission.current.catch(() => {});
  }
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: running,
    isDisabled: disabled,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const granted = permission.current;
      permission.current = undefined;
      if (text && granted) onSend(text, granted);
    },
    onCancel: async () => onCancel(),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="welcome">
              <h2>What would you like to extract?</h2>
              <p>
                Describe the fields you need. I’ll inspect this site, build a
                scraper, and test a sample.
              </p>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" || message.role === "assistant" ? (
                <Message />
              ) : null
            }
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root
          className="composer"
          onSubmitCapture={preparePermission}
        >
          <ComposerPrimitive.Input
            aria-label="Message the scraper agent"
            placeholder="Extract titles, prices and links…"
            maxLength={4000}
            rows={2}
          />
          <div className="composer-actions">
            {running ? (
              <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send onClickCapture={preparePermission}>
                Send
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
