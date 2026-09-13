import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCirceSemanticProposal,
  validateSemanticProposal,
  type SemanticEvidenceCatalogs,
  type SemanticRef,
  type SemanticRole,
} from "./semanticEvidence.ts";

const catalogs: SemanticEvidenceCatalogs = {
  projects: [
    { id: ProjectId.make("project-beacon"), title: "Beacon", names: ["Beacon", "beacon"] },
    {
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      names: ["Rivvl", "rivvl", "Riv"],
    },
  ],
  tasks: [
    { key: "thread-auth", title: "Rivvl authentication", names: ["Rivvl authentication", "auth"] },
    { key: "thread-docs", title: "Release docs", names: ["Release docs"] },
  ],
  providers: [
    { key: "codex", names: ["codex", "Codex"] },
    { key: "claude", names: ["claude", "Claude"] },
  ],
};

function cite(source: string, text: string, from = 0): SemanticRef["span"] {
  const start = source.indexOf(text, from);
  if (start < 0) throw new Error(`cite: ${JSON.stringify(text)} missing`);
  return { start, end: start + text.length, text };
}

function ref(source: string, role: SemanticRole, text: string, value = text): SemanticRef {
  return { span: cite(source, text), role, value };
}

function validate(source: string, refs: ReadonlyArray<SemanticRef>) {
  return validateSemanticProposal({ source, refs, catalogs });
}

describe("span proof", () => {
  it("accepts exact spans that reproduce the source", () => {
    const source = "Check auth in Rivvl";
    const result = validate(source, [ref(source, "destination", "in Rivvl", "Rivvl")]);
    expect(result).toMatchObject({
      status: "valid",
      target: { title: "Rivvl", value: "Rivvl" },
    });
    if (result.status !== "valid") return;
    expect(result.deletions).toEqual([{ start: 11, end: 19 }]);
  });

  it("rejects spans that do not reproduce the source exactly, without trimming", () => {
    const source = "Check auth in Rivvl";
    expect(
      validate(source, [
        { span: { start: 10, end: 18, text: "in Rivvl " }, role: "destination", value: "Rivvl" },
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
    expect(
      validate(source, [
        { span: { start: 11, end: 18, text: "in Rivvl" }, role: "destination", value: "Rivvl" },
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
    expect(
      validate(source, [
        { span: { start: 14, end: 19, text: "rivvl" }, role: "subject", value: "rivvl" },
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
  });

  it("rejects out-of-bounds, reversed, and overlapping spans", () => {
    const source = "Check auth in Rivvl";
    expect(
      validate(source, [
        { span: { start: 0, end: 99, text: source }, role: "subject", value: source },
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
    expect(
      validate(source, [
        ref(source, "subject", "Check"),
        { span: { start: 0, end: 8, text: "Check au" }, role: "subject", value: "Check au" },
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
  });

  it("rejects empty refs and ref floods", () => {
    expect(validate("Fix it", [])).toMatchObject({ status: "valid", target: null });
    const source = "Fix it";
    const flood = Array.from({ length: 9 }, () => ref(source, "subject", "Fix"));
    expect(validate(source, flood)).toMatchObject({ status: "malformed", kind: "cardinality" });
  });
});

describe("cardinality without conjunction reading", () => {
  it("rejects two task refs as one action per turn", () => {
    const source = "Fix auth then add release notes";
    expect(
      validate(source, [ref(source, "task", "Fix auth"), ref(source, "task", "release notes")]),
    ).toMatchObject({ status: "malformed", kind: "cardinality" });
  });

  it("rejects two destination refs and destination plus correction", () => {
    const source = "In Rivvl in Beacon fix it";
    expect(
      validate(source, [
        { ...ref(source, "destination", "In Rivvl", "Rivvl") },
        { ...ref(source, "destination", "in Beacon", "Beacon") },
      ]),
    ).toMatchObject({ status: "malformed", kind: "cardinality" });
    const repair = "I meant VPS not Rivvl in Beacon";
    expect(
      validate(repair, [
        { span: cite(repair, "VPS"), role: "correction", value: "VPS" },
        { span: cite(repair, "in Beacon"), role: "destination", value: "Beacon" },
      ]),
    ).toMatchObject({ status: "malformed", kind: "cardinality" });
  });

  it("rejects two provider refs", () => {
    const source = "Use Codex with Claude";
    expect(
      validate(source, [ref(source, "provider", "Codex"), ref(source, "provider", "Claude")]),
    ).toMatchObject({ status: "malformed", kind: "cardinality" });
  });
});

describe("catalog resolution", () => {
  it("reports the exact heard text for unknown projects", () => {
    const source = "Check auth in Deleted";
    expect(validate(source, [ref(source, "destination", "in Deleted", "Deleted")])).toEqual({
      status: "unknown",
      kind: "project",
      text: "Deleted",
    });
  });

  it("reports ambiguity with stable candidate keys", () => {
    const source = "Check auth in Rivvl";
    const doubled: SemanticEvidenceCatalogs = {
      ...catalogs,
      projects: [
        ...catalogs.projects,
        { id: ProjectId.make("project-rivvl-2"), title: "Rivvl", names: ["Rivvl"] },
      ],
    };
    const result = validateSemanticProposal({
      source,
      refs: [ref(source, "destination", "in Rivvl", "Rivvl")],
      catalogs: doubled,
    });
    expect(result).toMatchObject({ status: "ambiguous", kind: "project", text: "Rivvl" });
    if (result.status !== "ambiguous") return;
    expect(result.candidateKeys).toEqual(["project-rivvl", "project-rivvl-2"]);
  });

  it("never normalizes a typo into authority", () => {
    const source = "Switch to the Rivvil project";
    expect(validate(source, [ref(source, "destination", "Rivvil", "Rivvl")])).toMatchObject({
      status: "unheard",
      kind: "project",
      value: "Rivvl",
    });
  });

  it("requires task and provider values to echo their spans", () => {
    const source = "Use Fix to review auth";
    expect(validate(source, [ref(source, "provider", "Fix", "Codex")])).toMatchObject({
      status: "unheard",
      kind: "provider",
    });
    expect(validate(source, [ref(source, "task", "auth", "Rivvl authentication")])).toMatchObject({
      status: "unheard",
      kind: "task",
    });
  });

  it("resolves established aliases exactly, never phonetically", () => {
    const source = "Check auth in Riv";
    expect(validate(source, [ref(source, "destination", "in Riv", "Riv")])).toMatchObject({
      status: "valid",
      target: { title: "Rivvl", value: "Riv" },
    });
    const near = "Check auth in Ruvvl";
    expect(
      validate(near, [{ span: cite(near, "Ruvvl"), role: "destination", value: "Ruvvl" }]),
    ).toMatchObject({ status: "unknown", kind: "project", text: "Ruvvl" });
  });

  it("matches destination wrappers on word boundaries only", () => {
    const source = "make it happen";
    expect(validate(source, [ref(source, "destination", "happen", "App")])).toMatchObject({
      status: "unheard",
      kind: "project",
    });
  });

  it("lets subject and excluded refs account for mentions without catalog matches", () => {
    const source = "Queue a smoke test excluding the billing endpoint";
    const result = validate(source, [
      ref(source, "task", "smoke test"),
      ref(source, "excluded", "billing endpoint"),
    ]);
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") return;
    // The task name is uncatalogued, but the exclusion itself needs no
    // catalog: drop the task ref and the turn validates.
    expect(validate(source, [ref(source, "excluded", "billing endpoint")])).toMatchObject({
      status: "valid",
      target: null,
    });
  });

  it("collects excluded project ids for the ambient veto", () => {
    const source = "Check auth but not in Fable";
    const owned: SemanticEvidenceCatalogs = {
      ...catalogs,
      projects: [
        ...catalogs.projects,
        { id: ProjectId.make("project-fable"), title: "Fable", names: ["Fable"] },
      ],
    };
    const result = validateSemanticProposal({
      source,
      refs: [
        {
          span: cite(source, "Fable"),
          role: "excluded",
          value: "Fable",
        },
      ],
      catalogs: owned,
    });
    expect(result).toMatchObject({ status: "valid", target: null });
    if (result.status !== "valid") return;
    expect(result.excludedProjectIds.map(String)).toEqual(["project-fable"]);
  });

  it("rejects a destination for a project the transcript ruled out", () => {
    const source = "Test auth but not in Rivvl.";
    expect(validate(source, [ref(source, "destination", "in Rivvl", "Rivvl")])).toMatchObject({
      status: "malformed",
      kind: "span",
    });
  });

  it("rejects quoted spans as authorizing evidence", () => {
    const quotedDestination = 'Check auth in "Rivvl"';
    expect(
      validate(quotedDestination, [ref(quotedDestination, "destination", '"Rivvl"', "Rivvl")]),
    ).toMatchObject({ status: "malformed", kind: "span" });
    const quotedTask = 'Explain "Rivvl authentication" now';
    expect(
      validate(quotedTask, [
        ref(quotedTask, "task", '"Rivvl authentication"', "Rivvl authentication"),
      ]),
    ).toMatchObject({ status: "malformed", kind: "span" });
  });
});

describe("proposal schema", () => {
  it("decodes one inference with explicit nulls and quoted spans", () => {
    const source = 'PRs mentioning "Rivvl" in Beacon repo';
    const decoded = decodeCirceSemanticProposal({
      action: "start",
      refs: [
        { span: cite(source, '"Rivvl"'), role: "subject", value: "Rivvl" },
        { span: cite(source, "in Beacon repo"), role: "destination", value: "Beacon" },
      ],
      model: null,
      effort: null,
      answer: null,
    });
    expect(decoded.action).toBe("start");
    expect(decoded.refs).toHaveLength(2);
  });

  it("rejects unknown actions and unbounded answers", () => {
    expect(() =>
      decodeCirceSemanticProposal({
        action: "dispatch",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
    ).toThrow();
    expect(() =>
      decodeCirceSemanticProposal({
        action: "converse",
        refs: [],
        model: null,
        effort: null,
        answer: "x".repeat(401),
      }),
    ).toThrow();
  });
});
