import { useEffect, useRef } from "react";

import { onJarvisCommandFeedback, type JarvisCommandFeedback } from "../../jarvisBus";
import { toastManager } from "../ui/toast";

/** Toast channel type per feedback kind; exported for the unit test. */
export function jarvisFeedbackToastType(
  kind: JarvisCommandFeedback["kind"],
): "loading" | "success" | "warning" | "error" {
  switch (kind) {
    case "working":
      return "loading";
    case "done":
      return "success";
    case "needs-input":
      return "warning";
    case "error":
      return "error";
  }
}

const WORKING_TIMEOUT_MS = 60_000;
const SETTLED_TIMEOUT_MS = 8_000;

/**
 * Every ARIS answer reaches the user wherever they are, as one updating toast
 * per turn: the receipt ("Heard …") is a loading toast the final answer
 * replaces. The command console is a detail view, never the channel.
 */
export function JarvisFeedbackToaster() {
  const activeToastId = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    const present = (feedback: JarvisCommandFeedback) => {
      const settled = feedback.kind !== "working";
      const options = {
        type: jarvisFeedbackToastType(feedback.kind),
        title: "ARIS",
        description: feedback.text,
        timeout: settled ? SETTLED_TIMEOUT_MS : WORKING_TIMEOUT_MS,
      };
      const existing = activeToastId.current;
      if (existing === null) {
        activeToastId.current = toastManager.add(options);
      } else {
        toastManager.update(existing, options);
      }
      if (settled) activeToastId.current = null;
    };
    return onJarvisCommandFeedback(present);
  }, []);

  return null;
}
