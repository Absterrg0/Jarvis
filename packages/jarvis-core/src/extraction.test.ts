import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  adaptExtractionProposal,
  codePointLength,
  codePointToUtf16Offset,
  deriveWrapperValue,
  sliceCodePoints,
} from "./extraction.ts";
import { validateSemanticProposal, type SemanticEvidenceCatalogs } from "./semanticEvidence.ts";

const catalogs: SemanticEvidenceCatalogs = {
  projects: [{ id: ProjectId.make("project-rivvl"), title: "Rivvl", names: ["Rivvl"] }],
  tasks: [{ key: "thread-auth", title: "Rivvl authentication", names: ["Rivvl authentication"] }],
  providers: [{ key: "codex", names: ["Codex"] }],
};

describe("extraction adapter codepoint to UTF-16 conversion", () => {
  it("counts astral characters as one codepoint", () => {
    expect(codePointLength("🔧 Fix")).toBe(5);
    expect("🔧 Fix".length).toBe(6);
  });

  it("converts codepoint offsets to UTF-16 offsets canonically", () => {
    expect(codePointToUtf16Offset("🔧 Fix Harbor", 6)).toBe(7);
    expect(codePointToUtf16Offset("abc", 2)).toBe(2);
  });

  it("emits a UTF-16 destination span after an emoji", () => {
    const text = "🔧 Fix Harbor login";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [
        { start: 0, end: 1, label: "CONTROL" },
        { start: 6, end: 12, label: "PROJECT" },
        { start: 13, end: 18, label: "INSTRUCTION" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs).toEqual([
      { span: { start: 7, end: 13, text: "Harbor" }, role: "destination", value: "Harbor" },
    ]);
    expect(text.slice(7, 13)).toBe("Harbor");
  });

  it("pins codepoint semantics against UTF-16-derived offsets", () => {
    const text = "🔧 Fix Harbor login";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [{ start: 7, end: 13, label: "PROJECT" }],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs[0]?.span.text).toBe("arbor ");
    expect(result.proposal.refs[0]?.span.text).not.toBe("Harbor");
  });

  it("rejects offsets valid in UTF-16 units but past the codepoint end", () => {
    const text = "🔧ab";
    expect(codePointLength(text)).toBe(3);
    const result = adaptExtractionProposal({
      text,
      action: "status",
      spans: [{ start: 0, end: 4, label: "PROJECT" }],
    });
    expect(result).toMatchObject({ status: "rejected", reason: "out-of-bounds" });
  });

  it("keeps astral characters inside span text verbatim", () => {
    const text = "Ship 🚀 Harbor now";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [
        { start: 0, end: 6, label: "INSTRUCTION" },
        { start: 7, end: 13, label: "PROJECT" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(sliceCodePoints(text, 5, 6)).toBe("🚀");
    expect(result.proposal.refs).toEqual([
      { span: { start: 8, end: 14, text: "Harbor" }, role: "destination", value: "Harbor" },
    ]);
  });
});

describe("extraction adapter role reconciliation", () => {
  it("maps a fresh-style row to destination and drops carrier labels", () => {
    const result = adaptExtractionProposal({
      text: "Check PRs in Rivvl.",
      action: "start",
      spans: [
        { start: 0, end: 9, label: "INSTRUCTION" },
        { start: 10, end: 12, label: "ROUTING" },
        { start: 13, end: 18, label: "PROJECT" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("start");
    expect(result.proposal.refs).toEqual([
      { span: { start: 13, end: 18, text: "Rivvl" }, role: "destination", value: "Rivvl" },
    ]);
    expect(result.proposal.model).toBeNull();
    expect(result.proposal.answer).toBeNull();
    expect(result.proposal.effort).toBeNull();
  });

  it("maps task, provider, and model evidence", () => {
    const text = "In Harbor, use Codex with Kite-M to inspect the release.";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [
        { start: 0, end: 2, label: "ROUTING" },
        { start: 3, end: 9, label: "PROJECT" },
        { start: 15, end: 20, label: "PROVIDER" },
        { start: 26, end: 32, label: "MODEL" },
        { start: 36, end: 55, label: "INSTRUCTION" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs).toEqual([
      { span: { start: 3, end: 9, text: "Harbor" }, role: "destination", value: "Harbor" },
      { span: { start: 15, end: 20, text: "Codex" }, role: "provider", value: "Codex" },
    ]);
    expect(result.proposal.model).toBe("Kite-M");
  });

  it("maps clarify to unsupported and overflow to unsupported with no refs", () => {
    const clarified = adaptExtractionProposal({
      text: "Move it there",
      action: "clarify",
      spans: [],
    });
    expect(clarified.status).toBe("proposal");
    if (clarified.status !== "proposal") return;
    expect(clarified.proposal.action).toBe("unsupported");
    expect(clarified.proposal.refs).toEqual([]);
    const truncated = adaptExtractionProposal({
      text: "Fix Harbor login",
      action: "start",
      spans: [{ start: 4, end: 10, label: "PROJECT" }],
      overflow: true,
    });
    expect(truncated.status).toBe("proposal");
    if (truncated.status !== "proposal") return;
    expect(truncated.proposal.action).toBe("unsupported");
    expect(truncated.proposal.refs).toEqual([]);
  });

  it("passes duplicate destinations to the host instead of picking one", () => {
    const text = "Move Harbor work to Lumen now";
    const result = adaptExtractionProposal({
      text,
      action: "reroute",
      spans: [
        { start: 5, end: 11, label: "PROJECT" },
        { start: 20, end: 25, label: "PROJECT" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs).toHaveLength(2);
    const validation = validateSemanticProposal({
      source: text,
      refs: result.proposal.refs,
      catalogs,
    });
    expect(validation).toMatchObject({ status: "malformed", kind: "cardinality" });
  });

  it("rejects two distinct models instead of merging them", () => {
    const result = adaptExtractionProposal({
      text: "Use Codex with Kite-M or Heron-1",
      action: "start",
      spans: [
        { start: 15, end: 21, label: "MODEL" },
        { start: 25, end: 32, label: "MODEL" },
      ],
    });
    expect(result).toMatchObject({ status: "rejected", reason: "ambiguous" });
  });
});

describe("extraction adapter containment", () => {
  it("rejects unknown top-level keys instead of ignoring them", () => {
    const result = adaptExtractionProposal({
      text: "Status of the auth task",
      action: "status",
      spans: [],
      threadId: "invented-id",
    });
    expect(result).toMatchObject({ status: "rejected", reason: "malformed" });
  });

  it("rejects unknown span labels, unknown span keys, and unknown actions", () => {
    expect(
      adaptExtractionProposal({
        text: "Do the thing",
        action: "start",
        spans: [{ start: 0, end: 2, label: "AUTHORITY" }],
      }),
    ).toMatchObject({ status: "rejected", reason: "malformed" });
    expect(
      adaptExtractionProposal({
        text: "Do the thing",
        action: "start",
        spans: [{ start: 0, end: 2, label: "CONTROL", priority: 1 }],
      }),
    ).toMatchObject({ status: "rejected", reason: "malformed" });
    expect(
      adaptExtractionProposal({ text: "Blast off", action: "launch", spans: [] }),
    ).toMatchObject({ status: "rejected", reason: "unknown-action" });
  });

  it("rejects node routing instead of mapping it to a role", () => {
    const result = adaptExtractionProposal({
      text: "Move the task to north-node",
      action: "reroute",
      spans: [
        { start: 9, end: 13, label: "TASK" },
        { start: 17, end: 27, label: "NODE" },
      ],
    });
    expect(result).toMatchObject({ status: "rejected", reason: "node-routing" });
  });

  it("rejects overlapping spans", () => {
    const result = adaptExtractionProposal({
      text: "Fix Harbor login",
      action: "start",
      spans: [
        { start: 4, end: 10, label: "PROJECT" },
        { start: 8, end: 15, label: "INSTRUCTION" },
      ],
    });
    expect(result).toMatchObject({ status: "rejected", reason: "overlap" });
  });

  it("rejects out-of-bounds, empty, and non-integer spans", () => {
    const text = "Fix Harbor";
    expect(
      adaptExtractionProposal({
        text,
        action: "start",
        spans: [{ start: 0, end: 99, label: "PROJECT" }],
      }),
    ).toMatchObject({ status: "rejected", reason: "out-of-bounds" });
    expect(
      adaptExtractionProposal({
        text,
        action: "start",
        spans: [{ start: 4, end: 4, label: "PROJECT" }],
      }),
    ).toMatchObject({ status: "rejected", reason: "out-of-bounds" });
    expect(
      adaptExtractionProposal({
        text,
        action: "start",
        spans: [{ start: 0.5, end: 3, label: "PROJECT" }],
      }),
    ).toMatchObject({ status: "rejected", reason: "malformed" });
  });
});

describe("extraction adapter host seam", () => {
  it("emits a proposal the host validator accepts for a known project", () => {
    const source = "Check PRs in Rivvl.";
    const result = adaptExtractionProposal({
      text: source,
      action: "start",
      spans: [
        { start: 0, end: 9, label: "INSTRUCTION" },
        { start: 10, end: 12, label: "ROUTING" },
        { start: 13, end: 18, label: "PROJECT" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    const validation = validateSemanticProposal({
      source,
      refs: result.proposal.refs,
      catalogs,
    });
    expect(validation).toMatchObject({
      status: "valid",
      target: { title: "Rivvl", value: "Rivvl" },
    });
  });

  it("emits a proposal the host reports unknown for an uncatalogued name", () => {
    const source = "Start work in Asterfall today";
    const result = adaptExtractionProposal({
      text: source,
      action: "start",
      spans: [{ start: 14, end: 23, label: "PROJECT" }],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    const validation = validateSemanticProposal({
      source,
      refs: result.proposal.refs,
      catalogs,
    });
    expect(validation).toMatchObject({ status: "unknown", kind: "project", text: "Asterfall" });
  });
});

describe("extraction adapter roles-v1 wrappers", () => {
  it("derives wrapper values without splitting or rejoining source", () => {
    expect(deriveWrapperValue("in Harbor")).toBe("Harbor");
    expect(deriveWrapperValue("to Backend")).toBe("Backend");
    expect(deriveWrapperValue("In Rivvl,")).toBe("Rivvl");
    expect(deriveWrapperValue(" in Rivvl")).toBe("Rivvl");
    expect(deriveWrapperValue("inside Harbor.")).toBe("Harbor");
    expect(deriveWrapperValue("Harbor")).toBe("Harbor");
    expect(deriveWrapperValue("with Harbor")).toBe("with Harbor");
  });

  it("maps a DESTINATION wrapper to a host-validatable destination", () => {
    const text = "Check PRs in Rivvl.";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [{ start: 10, end: 18, label: "DESTINATION" }],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs).toEqual([
      { span: { start: 10, end: 18, text: "in Rivvl" }, role: "destination", value: "Rivvl" },
    ]);
    const validation = validateSemanticProposal({
      source: text,
      refs: result.proposal.refs,
      catalogs,
    });
    expect(validation).toMatchObject({ status: "valid", target: { title: "Rivvl" } });
  });

  it("keeps the full wrapper including comma for leading destinations", () => {
    const text = "In Rivvl, fix login";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [{ start: 0, end: 9, label: "DESTINATION" }],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs[0]?.span.text).toBe("In Rivvl,");
    expect(result.proposal.refs[0]?.value).toBe("Rivvl");
  });

  it("maps CORRECTION, SUBJECT, and EXCLUDED with no authority overreach", () => {
    const text = "No, Rivvl fix login";
    const correction = adaptExtractionProposal({
      text,
      action: "start",
      spans: [{ start: 4, end: 9, label: "CORRECTION" }],
    });
    expect(correction.status).toBe("proposal");
    if (correction.status !== "proposal") return;
    expect(correction.proposal.refs).toEqual([
      { span: { start: 4, end: 9, text: "Rivvl" }, role: "correction", value: "Rivvl" },
    ]);
    const subject = adaptExtractionProposal({
      text: "Compare Rivvl with Jarvis",
      action: "start",
      spans: [
        { start: 8, end: 13, label: "SUBJECT" },
        { start: 19, end: 25, label: "EXCLUDED" },
      ],
    });
    expect(subject.status).toBe("proposal");
    if (subject.status !== "proposal") return;
    expect(subject.proposal.refs.map((ref) => ref.role)).toEqual(["subject", "excluded"]);
    const validation = validateSemanticProposal({
      source: "Compare Rivvl with Jarvis",
      refs: subject.proposal.refs,
      catalogs,
    });
    expect(validation).toMatchObject({ status: "valid", target: null });
  });

  it("keeps non-wrapper names as values for task and provider", () => {
    const text = "Ask Codex about auth task";
    const result = adaptExtractionProposal({
      text,
      action: "status",
      spans: [
        { start: 4, end: 9, label: "PROVIDER" },
        { start: 16, end: 25, label: "TASK" },
      ],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs.map((ref) => [ref.role, ref.value])).toEqual([
      ["provider", "Codex"],
      ["task", "auth task"],
    ]);
  });

  it("echoes MODEL and EFFORT and rejects dual distinct refs", () => {
    const single = adaptExtractionProposal({
      text: "Use Codex with Kite-M quickly",
      action: "start",
      spans: [
        { start: 15, end: 21, label: "MODEL" },
        { start: 22, end: 29, label: "EFFORT" },
      ],
    });
    expect(single.status).toBe("proposal");
    if (single.status !== "proposal") return;
    expect(single.proposal.model).toBe("Kite-M");
    expect(single.proposal.effort).toBe("quickly");
    expect(
      adaptExtractionProposal({
        text: "Use Kite-M or Heron-1",
        action: "start",
        spans: [
          { start: 4, end: 10, label: "MODEL" },
          { start: 14, end: 21, label: "MODEL" },
        ],
      }),
    ).toMatchObject({ status: "rejected", reason: "ambiguous" });
    expect(
      adaptExtractionProposal({
        text: "fast then slow",
        action: "start",
        spans: [
          { start: 0, end: 4, label: "EFFORT" },
          { start: 10, end: 14, label: "EFFORT" },
        ],
      }),
    ).toMatchObject({ status: "rejected", reason: "ambiguous" });
  });

  it("converts wrapper codepoints to UTF-16 after an emoji", () => {
    const text = "🔧 Fix in Harbor now";
    const result = adaptExtractionProposal({
      text,
      action: "start",
      spans: [{ start: 6, end: 15, label: "DESTINATION" }],
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs[0]?.span.text).toBe("in Harbor");
    expect(result.proposal.refs[0]?.value).toBe("Harbor");
    expect(text.slice(result.proposal.refs[0]!.span.start, result.proposal.refs[0]!.span.end)).toBe(
      "in Harbor",
    );
  });
});
