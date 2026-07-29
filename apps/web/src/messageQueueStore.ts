import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import type { ComposerImageAttachment } from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";

export interface QueuedComposerMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

interface MessageQueueStoreState {
  readonly byThreadKey: Readonly<Record<string, ReadonlyArray<QueuedComposerMessage>>>;
  readonly messagesForThread: (threadRef: ScopedThreadRef) => ReadonlyArray<QueuedComposerMessage>;
  readonly peek: (threadRef: ScopedThreadRef) => QueuedComposerMessage | null;
  readonly enqueue: (threadRef: ScopedThreadRef, message: QueuedComposerMessage) => void;
  readonly dequeue: (threadRef: ScopedThreadRef) => QueuedComposerMessage | null;
  readonly remove: (threadRef: ScopedThreadRef, messageId: string) => void;
  readonly clear: (threadRef: ScopedThreadRef) => void;
  readonly clearAll: () => void;
}

export const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedComposerMessage> = [];

export const useMessageQueueStore = create<MessageQueueStoreState>((set, get) => ({
  byThreadKey: {},
  messagesForThread: (threadRef) =>
    get().byThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_QUEUED_MESSAGES,
  peek: (threadRef) => get().byThreadKey[scopedThreadKey(threadRef)]?.[0] ?? null,
  enqueue: (threadRef, message) => {
    const key = scopedThreadKey(threadRef);
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [key]: [...(state.byThreadKey[key] ?? EMPTY_QUEUED_MESSAGES), message],
      },
    }));
  },
  dequeue: (threadRef) => {
    const key = scopedThreadKey(threadRef);
    const current = get().byThreadKey[key] ?? EMPTY_QUEUED_MESSAGES;
    const [message, ...remaining] = current;
    if (!message) return null;
    set((state) => {
      const next = { ...state.byThreadKey };
      if (remaining.length === 0) {
        delete next[key];
      } else {
        next[key] = remaining;
      }
      return { byThreadKey: next };
    });
    return message;
  },
  remove: (threadRef, messageId) => {
    const key = scopedThreadKey(threadRef);
    set((state) => {
      const current = state.byThreadKey[key] ?? EMPTY_QUEUED_MESSAGES;
      const remaining = current.filter((message) => message.id !== messageId);
      if (remaining.length === current.length) return state;
      const next = { ...state.byThreadKey };
      if (remaining.length === 0) {
        delete next[key];
      } else {
        next[key] = remaining;
      }
      return { byThreadKey: next };
    });
  },
  clear: (threadRef) => {
    const key = scopedThreadKey(threadRef);
    set((state) => {
      if (!(key in state.byThreadKey)) return state;
      const next = { ...state.byThreadKey };
      delete next[key];
      return { byThreadKey: next };
    });
  },
  clearAll: () => set({ byThreadKey: {} }),
}));
