import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ListOrderedIcon, XIcon } from "lucide-react";

import { EMPTY_QUEUED_MESSAGES, useMessageQueueStore } from "../../messageQueueStore";
import { Button } from "../ui/button";

export function ComposerQueuedMessages({ threadRef }: { threadRef: ScopedThreadRef }) {
  const messages = useMessageQueueStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_QUEUED_MESSAGES,
  );
  const remove = useMessageQueueStore((state) => state.remove);

  if (messages.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ListOrderedIcon className="size-3.5" />
        {messages.length} queued message{messages.length === 1 ? "" : "s"}
      </div>
      <div className="space-y-1">
        {messages.map((message, index) => (
          <div key={message.id} className="flex min-w-0 items-center gap-2">
            <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground/60">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
              {message.prompt.trim() || "Attachment message"}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove queued message ${index + 1}`}
              onClick={() => remove(threadRef, message.id)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
