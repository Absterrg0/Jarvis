import { isRelayDocument } from "./relay.ts";

export function relayDocumentDidFinish(input: {
  readonly url: string;
  readonly pendingTranscript: string | undefined;
}): { readonly ready: boolean; readonly transcriptToDeliver: string | undefined } {
  const ready = isRelayDocument(input.url);
  return {
    ready,
    transcriptToDeliver: ready ? input.pendingTranscript : undefined,
  };
}
