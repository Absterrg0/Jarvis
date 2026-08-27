export type SpokenRequestKind = "inspection" | "change" | "unknown";

const changeVerb =
  /\b(?:add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b/iu;

const politeLead =
  /^(?:jarvis[,.]?\s*)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:need|want)\s+you\s+to\s+)*/iu;

/** Classifies voice requests before a provider can act on them. */
export function classifySpokenRequest(utterance: string): SpokenRequestKind {
  const request = utterance.trim().replace(politeLead, "");
  const inspectionLead =
    /^(?:check(?:\s+out)?|inspect|review|explain|assess|look\s+at|verify|tell\s+me)\b/iu.test(
      request,
    );
  if (inspectionLead) {
    const explicitFollowUp = /\b(?:and|then|also)\s+(?:please\s+)?/iu.exec(request);
    if (explicitFollowUp !== null && changeVerb.test(request.slice(explicitFollowUp.index))) {
      return "change";
    }
    return "inspection";
  }
  if (changeVerb.test(request)) return "change";
  return "unknown";
}
