import { assert, describe, expect, it } from "@effect/vitest";

import {
  applyCompanionRecognitionVocabulary,
  canonicalizeCompanionTranscript,
  companionProjectKey,
  companionRecognitionContextPhrases,
  companionContinuationTarget,
  resolveCompanionProjectTarget,
} from "./voice-routing.ts";

const target = { projectId: "project-1", threadId: "thread-1" } as const;

describe("companion voice routing", () => {
  const projects = [
    { id: "jarvis", title: "Jarvis", workspaceRoot: "C:\\work\\Jarvis" },
    { id: "api", title: "Payments API", workspaceRoot: "C:\\work\\payments-api" },
  ] as const;

  it("uses one cache key for a legacy project before and after alias updates", () => {
    const legacyProject = {
      id: "legacy-project",
      title: "Legacy",
      workspaceRoot: "C:\\work\\legacy",
    } as const;
    expect(companionProjectKey(legacyProject)).toBe("legacy:legacy-project");
    expect(companionProjectKey({ ...legacyProject, nodeId: undefined })).toBe(
      "legacy:legacy-project",
    );
  });

  it("routes an explicit natural-language project without a setup selection", () => {
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "In the Jarvis project, fix the voice overlay",
        projects,
      }),
      { kind: "resolved", project: projects[0], source: "spoken" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "For payments api, review the failing tests",
        projects,
      }),
      { kind: "resolved", project: projects[1], source: "spoken" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Change directory to payments API and review the failing tests",
        projects,
      }),
      { kind: "resolved", project: projects[1], source: "spoken" },
    );
  });

  it("repairs and routes a strong project spelling match before dispatch", () => {
    const alertify = {
      id: "alertify",
      title: "Alertify",
      workspaceRoot: "C:\\work\\Alertify",
    } as const;
    const available = [...projects, alertify];
    assert.equal(
      canonicalizeCompanionTranscript("Can you please check out Alertifi?", available),
      "Can you please check out Alertify?",
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Can you please check out Alertifi?",
        projects: available,
      }),
      { kind: "resolved", project: alertify, source: "spoken" },
    );
  });

  it("uses one project or the last successful voice project without reading the visible T3 tab", () => {
    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "Run the tests", projects: [projects[0]] }),
      { kind: "resolved", project: projects[0], source: "only-project" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Run the tests",
        projects,
        recentProjectId: "api",
      }),
      { kind: "resolved", project: projects[1], source: "recent" },
    );
  });

  it("asks for a project when routing would otherwise be unsafe", () => {
    assert.deepEqual(resolveCompanionProjectTarget({ transcript: "Run the tests", projects }), {
      kind: "needs-clarification",
      projects,
    });
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "In the frontend project, run the tests",
        projects,
        recentProjectId: "jarvis",
      }),
      { kind: "needs-clarification", projects },
    );
  });

  it("continues only when continuation mode has an exact target", () => {
    assert.deepEqual(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
        attentionTarget: target,
      }),
      target,
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
      }),
    );
  });

  it("starts explicitly routed provider work instead of contaminating the previous task", () => {
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Use Codex to implement the new dashboard",
        attentionTarget: target,
      }),
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Spin up Claude Code to review the last change",
        attentionTarget: target,
      }),
    );
  });

  it("passes exact task context while leaving control meaning to the Director", () => {
    for (const transcript of [
      "actually use SQLite instead",
      "after that update the docs",
      "what is it doing",
      "do that last task in Payments API project",
    ]) {
      assert.deepEqual(
        companionContinuationTarget({
          conversationMode: "continue-last-thread",
          transcript,
          attentionTarget: target,
        }),
        target,
      );
    }
  });

  it("routes a blocked-task reply exactly even when new-thread mode is selected", () => {
    assert.deepEqual(
      companionContinuationTarget({
        conversationMode: "new-thread",
        transcript: "yes, allow it",
        attentionTarget: { ...target, reportKind: "approval-needed" },
      }),
      { ...target, reportKind: "approval-needed" },
    );
  });

  it("recovers a project name that local speech recognition heard phonetically", () => {
    const namedProjects = [
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
      { id: "rivvl", title: "Rivvl", workspaceRoot: "C:\\work\\rivvl" },
    ] as const;

    for (const transcript of [
      "Please check the pull request in ripple",
      "Please check the pull request in ribbon",
    ]) {
      assert.deepEqual(resolveCompanionProjectTarget({ transcript, projects: namedProjects }), {
        kind: "needs-clarification",
        projects: [namedProjects[1]],
        heardAlias: transcript.endsWith("ripple") ? "ripple" : "ribbon",
      });
    }
  });

  it("catches the observed multi-word Alertify transcription before dispatch", () => {
    const namedProjects = [
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
      { id: "jarvis", title: "Jarvis", workspaceRoot: "C:\\work\\Jarvis" },
    ] as const;

    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Can you please check out a light defile?",
        projects: namedProjects,
      }),
      {
        kind: "needs-clarification",
        projects: [namedProjects[0]],
        heardAlias: "a light defile",
      },
    );
  });

  it("biases recognition with live entity names before phonetic repair is needed", () => {
    const alertify = {
      id: "alertify",
      title: "Alertify",
      workspaceRoot: "C:\\work\\Alertify",
    } as const;

    assert.deepEqual(
      companionRecognitionContextPhrases({
        projects: [alertify],
        terms: [
          { canonical: "Codex", aliases: ["code x"] },
          { canonical: "Sol", aliases: ["soul"] },
        ],
      }),
      ["Alertify", "Codex", "Sol"],
    );
  });

  it("requires confirmation for a new pronunciation but accepts ordinals", () => {
    const namedProjects = [
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
      { id: "rivvl", title: "Rivvl", workspaceRoot: "C:\\work\\rivvl" },
    ] as const;

    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "ripple", projects: namedProjects }),
      { kind: "needs-clarification", projects: [namedProjects[1]], heardAlias: "ripple" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "second one", projects: namedProjects }),
      { kind: "resolved", project: namedProjects[1], source: "spoken" },
    );
  });

  it("routes a Host-learned pronunciation as an exact project alias", () => {
    const namedProjects = [
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
      {
        id: "rivvl",
        title: "Rivvl",
        workspaceRoot: "C:\\work\\rivvl",
        aliases: ["ripple"],
      },
    ] as const;
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Please check the pull request in ripple",
        projects: namedProjects,
      }),
      { kind: "resolved", project: namedProjects[1], source: "spoken" },
    );
  });

  it("applies unique project, provider, and model terms at the recognition boundary", () => {
    assert.equal(
      applyCompanionRecognitionVocabulary({
        transcript: "Use code x soul to review in ripple",
        projects: [
          {
            id: "rivvl",
            title: "Rivvl",
            workspaceRoot: "C:\\work\\rivvl",
            aliases: ["ripple"],
          },
        ],
        terms: [
          { canonical: "Codex", aliases: ["code x"] },
          { canonical: "Sol", aliases: ["soul"] },
        ],
      }),
      "Use Codex Sol to review in Rivvl",
    );
  });

  it("does not rewrite a learned project alias outside a project-name span", () => {
    assert.equal(
      applyCompanionRecognitionVocabulary({
        transcript: "Fix the ribbon animation",
        projects: [
          {
            id: "rivvl",
            title: "Rivvl",
            workspaceRoot: "C:\\work\\rivvl",
            aliases: ["ribbon"],
          },
        ],
      }),
      "Fix the ribbon animation",
    );
  });

  it("does not route an ordinary alias token to a project", () => {
    const projects = [
      {
        id: "rivvl",
        title: "Rivvl",
        workspaceRoot: "C:\\work\\rivvl",
        aliases: ["ribbon"],
      },
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
    ];
    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "Fix the ribbon animation", projects }),
      { kind: "needs-clarification", projects },
    );
  });

  it("does not rewrite provider vocabulary outside provider-routing language", () => {
    assert.equal(
      applyCompanionRecognitionVocabulary({
        transcript: "Fix the soul music player",
        projects: [],
        terms: [{ canonical: "Sol", aliases: ["soul"], scope: "provider-routing" }],
      }),
      "Fix the soul music player",
    );
  });

  it("does not apply a duplicate learned alias from catalog order", () => {
    const colliding = [
      { id: "one", title: "One", workspaceRoot: "C:\\one", aliases: ["shared"] },
      { id: "two", title: "Two", workspaceRoot: "C:\\two", aliases: ["shared"] },
    ] as const;
    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "in shared", projects: colliding }),
      {
        kind: "needs-clarification",
        projects: colliding,
      },
    );
    assert.equal(
      applyCompanionRecognitionVocabulary({ transcript: "in shared", projects: colliding }),
      "in shared",
    );
  });

  it("keeps equal project names distinct across execution nodes", () => {
    const duplicated = [
      {
        id: "project-shared",
        title: "Payments",
        workspaceRoot: "C:\\desktop\\payments",
        nodeId: "environment-desktop",
        nodeLabel: "Desktop",
      },
      {
        id: "project-shared",
        title: "Payments",
        workspaceRoot: "C:\\laptop\\payments",
        nodeId: "environment-laptop",
        nodeLabel: "Laptop",
      },
    ] as const;
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "In Payments, run the tests",
        projects: duplicated,
      }),
      { kind: "needs-clarification", projects: duplicated },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "second one",
        projects: duplicated,
      }),
      { kind: "resolved", project: duplicated[1], source: "spoken" },
    );
  });

  it("canonicalizes recognized project and product terms before dispatch", () => {
    const namedProjects = [
      { id: "alertify", title: "Alertify", workspaceRoot: "C:\\work\\Alertify" },
      {
        id: "rivvl",
        title: "Rivvl",
        workspaceRoot: "C:\\work\\rivvl",
        aliases: ["ripple"],
      },
    ] as const;

    assert.equal(
      canonicalizeCompanionTranscript(
        "Please check the pull request on get hub in ripple",
        namedProjects,
      ),
      "Please check the pull request on GitHub in Rivvl",
    );
  });

  it("does not canonicalize a project alias used as ordinary task language", () => {
    const projects = [
      {
        id: "rivvl",
        title: "Rivvl",
        workspaceRoot: "C:\\work\\rivvl",
        aliases: ["ribbon"],
      },
    ];
    for (const transcript of [
      "Fix the ribbon animation",
      "Ribbon animations are broken",
      "Begin ribbon animations",
    ]) {
      assert.equal(canonicalizeCompanionTranscript(transcript, projects), transcript);
    }
  });

  it("matches project aliases only on token boundaries", () => {
    const projects = [
      {
        id: "art",
        title: "Art",
        workspaceRoot: "C:\\work\\art",
      },
      {
        id: "articles",
        title: "Articles",
        workspaceRoot: "C:\\work\\articles",
      },
    ];
    assert.notDeepEqual(
      resolveCompanionProjectTarget({ transcript: "Work in article project", projects }),
      { kind: "resolved", project: projects[0]!, source: "spoken" },
    );
  });

  it("accepts a bare learned alias as a project selection", () => {
    assert.equal(
      canonicalizeCompanionTranscript("ribbon", [
        {
          id: "rivvl",
          title: "Rivvl",
          workspaceRoot: "C:\\work\\rivvl",
          aliases: ["ribbon"],
        },
      ]),
      "Rivvl",
    );
  });
});
