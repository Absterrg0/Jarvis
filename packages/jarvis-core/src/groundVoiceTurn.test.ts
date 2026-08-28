import { describe, expect, it } from "vite-plus/test";

import { groundVoiceTurn } from "./groundVoiceTurn.ts";

const project = (id: string, title: string, workspaceRoot: string) => ({
  id,
  title,
  workspaceRoot,
  repositoryNames: [],
});

const candidate = <Project extends ReturnType<typeof project>>(value: Project) => ({
  id: value.id,
  title: value.title,
  label: `${value.title} — Laptop`,
  names: [value.title, value.workspaceRoot.split("/").at(-1) ?? value.title],
  project: value,
});

describe("groundVoiceTurn", () => {
  const rivvl = project("project-rivvl", "Rivvl", "/workspace/rivvl");
  const alertify = project("project-alertify", "Alertify", "/workspace/alertify");
  const projects = [rivvl, alertify];

  it("stops before ambient fallback when a project slot has one phonetic match", () => {
    expect(
      groundVoiceTurn({
        utterance: "Can I check out if there is any PR on alert effect?",
        candidates: projects.map(candidate),
      }),
    ).toEqual({
      status: "needs-confirmation",
      sourceUtterance: "Can I check out if there is any PR on alert effect?",
      heard: "alert effect",
      prompt: "Did you mean Alertify?",
      project: alertify,
    });
  });

  it("grounds the observed Rivvl misrecognition but never dispatches it without confirmation", () => {
    expect(
      groundVoiceTurn({
        utterance: "I need you to check out Zivil.",
        candidates: projects.map(candidate),
      }),
    ).toEqual({
      status: "needs-confirmation",
      sourceUtterance: "I need you to check out Zivil.",
      heard: "Zivil",
      prompt: "Did you mean Rivvl?",
      project: rivvl,
    });
  });

  it("binds an explicit project while preserving a branch with the same phonetic shape", () => {
    expect(
      groundVoiceTurn({
        utterance: "In Rivvl, check out branch Zivil.",
        candidates: projects.map(candidate),
      }),
    ).toEqual({
      status: "resolved",
      sourceUtterance: "In Rivvl, check out branch Zivil.",
      utterance: "In Rivvl, check out branch Zivil.",
      heard: "Rivvl",
      match: "exact",
      project: rivvl,
    });
  });

  it("clarifies duplicate project names using their node-qualified labels", () => {
    const remoteRivvl = { ...rivvl, id: "remote-rivvl" };
    expect(
      groundVoiceTurn({
        utterance: "Open Rivvl.",
        candidates: [candidate(rivvl), { ...candidate(remoteRivvl), label: "Rivvl — Server" }],
      }),
    ).toMatchObject({
      status: "needs-clarification",
      candidates: [{ label: "Rivvl — Laptop" }, { label: "Rivvl — Server" }],
    });
  });

  it("clarifies tied phonetic matches instead of falling back to ambient focus", () => {
    const remoteRivvl = { ...rivvl, id: "remote-rivvl" };
    expect(
      groundVoiceTurn({
        utterance: "Check out Zivil.",
        candidates: [candidate(rivvl), { ...candidate(remoteRivvl), label: "Rivvl — Server" }],
      }),
    ).toMatchObject({
      status: "needs-clarification",
      heard: "Zivil",
      candidates: [
        { label: "Rivvl — Laptop", learnedAlias: "Zivil" },
        { label: "Rivvl — Server", learnedAlias: "Zivil" },
      ],
    });
  });

  it("makes clarification labels unique when titles and basenames collide", () => {
    const duplicate = { ...rivvl, id: "duplicate-rivvl" };
    expect(
      groundVoiceTurn({
        utterance: "Open Rivvl.",
        candidates: [candidate(rivvl), candidate(duplicate)],
      }),
    ).toMatchObject({
      status: "needs-clarification",
      candidates: [{ label: "Rivvl — Laptop (1)" }, { label: "Rivvl — Laptop (2)" }],
    });
  });

  it("rejects a stale confirmation id instead of fuzzy-matching another project", () => {
    expect(
      groundVoiceTurn({
        utterance: "Check out Zivil.",
        candidates: projects.map(candidate),
        confirmedCandidateId: "deleted-project",
      }),
    ).toMatchObject({
      status: "needs-clarification",
      prompt: "That project is no longer available. Which project did you mean?",
      candidates: [{ project: rivvl }, { project: alertify }],
    });
  });

  it("does not reinterpret a typed branch-shaped objective as a project", () => {
    expect(
      groundVoiceTurn({
        utterance: "git checkout zivil",
        candidates: projects.map(candidate),
        mode: "explicit-only",
      }),
    ).toEqual({
      status: "not-mentioned",
      sourceUtterance: "git checkout zivil",
      utterance: "git checkout zivil",
    });
  });
});
