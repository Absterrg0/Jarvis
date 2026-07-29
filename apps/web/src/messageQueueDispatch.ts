export type QueuedMessageDispatchInput = {
  readonly id: string;
};

export function createQueuedMessageDispatchController(input: {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (frame: number) => void;
  readonly restore: (message: QueuedMessageDispatchInput) => void;
  readonly remove: (message: QueuedMessageDispatchInput) => void;
  readonly send: () => void;
}) {
  let frame: number | null = null;
  let send = input.send;

  return {
    dispatch: (message: QueuedMessageDispatchInput) => {
      if (frame !== null) return;
      input.restore(message);
      frame = input.requestFrame(() => {
        frame = null;
        input.remove(message);
        send();
      });
    },
    setSend: (nextSend: () => void) => {
      send = nextSend;
    },
    cancel: () => {
      if (frame === null) return;
      input.cancelFrame(frame);
      frame = null;
    },
  };
}
