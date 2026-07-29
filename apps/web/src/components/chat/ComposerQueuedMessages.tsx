import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Clock3Icon, ListOrderedIcon, XIcon } from "lucide-react";

import { EMPTY_QUEUED_MESSAGES, useMessageQueueStore } from "../../messageQueueStore";
import { Button } from "../ui/button";

export function ComposerQueuedMessages({ threadRef }: { threadRef: ScopedThreadRef }) {
  const messages = useMessageQueueStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_QUEUED_MESSAGES,
  );
  const remove = useMessageQueueStore((state) => state.remove);
  const clear = useMessageQueueStore((state) => state.clear);

  if (messages.length === 0) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-primary/15 bg-gradient-to-br from-primary/[0.07] to-muted/35 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground/85">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ListOrderedIcon className="size-3" />
          </span>
          <span>
            Up next <span className="text-muted-foreground">· {messages.length}</span>
          </span>
        </div>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
          onClick={() => clear(threadRef)}
        >
          Clear queue
        </Button>
      </div>
      <div className="px-2 py-1.5">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-background/55"
          >
            {index === 0 ? (
              <Clock3Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <span className="w-3.5 shrink-0 text-center font-mono text-[10px] text-muted-foreground/60">
                {index + 1}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-foreground/85">
                {message.prompt.trim() || "Attachment message"}
              </p>
              {index === 0 ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Sends automatically when this turn finishes
                </p>
              ) : null}
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              className="opacity-70 group-hover:opacity-100"
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
