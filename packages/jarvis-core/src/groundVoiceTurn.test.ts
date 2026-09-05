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

  it("hears a project named at the end of the request instead of leaking it raw", () => {
    expect(
      groundVoiceTurn({
        utterance: "check the authentication in Rebel.",
        candidates: projects.map(candidate),
      }),
    ).toEqual({
      status: "needs-confirmation",
      sourceUtterance: "check the authentication in Rebel.",
      heard: "Rebel",
      prompt: "Did you mean Rivvl?",
      project: rivvl,
    });
  });

  it("canonicalizes an exactly named trailing project into the utterance", () => {
    expect(
      groundVoiceTurn({
        utterance: "check the authentication in Rivvl",
        candidates: projects.map(candidate),
      }),
    ).toMatchObject({
      status: "resolved",
      utterance: "check the authentication in Rivvl",
      project: rivvl,
    });
  });

  it("grounds imperfect mobile ASR without Array.prototype.toSorted", () => {
    const originalToSorted = Array.prototype.toSorted;
    // eslint-disable-next-line no-extend-native -- simulate the Android Hermes runtime contract
    Object.defineProperty(Array.prototype, "toSorted", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      expect(
        groundVoiceTurn({
          utterance: "In Javis, list projects.",
          candidates: projects.map(candidate),
        }),
      ).toMatchObject({
        status: "needs-clarification",
        candidates: [{ project: rivvl }, { project: alertify }],
      });
    } finally {
      // eslint-disable-next-line no-extend-native -- restore the test process runtime contract
      Object.defineProperty(Array.prototype, "toSorted", {
        configurable: true,
        value: originalToSorted,
        writable: true,
      });
    }
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

  it("canonicalizes only the confirmed candidate's own span", () => {
    const jarvis = project("project-jarvis", "Jarvis", "/workspace/jarvis");
    expect(
      groundVoiceTurn({
        utterance: "Compare Jarvis and Alertify",
        candidates: [candidate(jarvis), candidate(alertify)],
        confirmedCandidateId: "project-alertify",
      }),
    ).toEqual({
      status: "resolved",
      sourceUtterance: "Compare Jarvis and Alertify",
      utterance: "Compare Jarvis and Alertify",
      heard: "Alertify",
      match: "confirmed-pronunciation",
      project: alertify,
    });
  });

  it("fails closed when the confirmed project is gone, even with no candidates", () => {
    expect(
      groundVoiceTurn({
        utterance: "Open Zivil",
        candidates: [],
        confirmedCandidateId: "project-rivvl",
      }),
    ).toEqual({
      status: "needs-clarification",
      sourceUtterance: "Open Zivil",
      heard: "Open Zivil",
      prompt: "That project is no longer available. Which project did you mean?",
      candidates: [],
    });
  });

  it("does not route task verbs to same-named projects", () => {
    const auth = project("project-auth", "Auth", "/workspace/auth");
    expect(
      groundVoiceTurn({
        utterance: "fix auth",
        candidates: [candidate(auth), candidate(rivvl)],
      }),
    ).toEqual({
      status: "not-mentioned",
      sourceUtterance: "fix auth",
      utterance: "fix auth",
    });
  });

  it("does not route general questions to any project", () => {
    expect(
      groundVoiceTurn({
        utterance: "what is the weather today",
        candidates: projects.map(candidate),
      }),
    ).toEqual({
      status: "not-mentioned",
      sourceUtterance: "what is the weather today",
      utterance: "what is the weather today",
    });
  });

  it("prefers the explicit target over a project word in the objective", () => {
    const web = project("project-web", "Web", "/workspace/web");
    const api = project("project-api", "API", "/workspace/api");
    expect(
      groundVoiceTurn({
        utterance: "In Web, fix the API response.",
        candidates: [candidate(web), candidate(api)],
      }),
    ).toMatchObject({
      status: "resolved",
      utterance: "In Web, fix the API response.",
      project: web,
    });
  });

  it("grounds a large multi-node catalog without blocking the UI thread", () => {
    const many = Array.from({ length: 1200 }, (_, index) => {
      const numbered = project(`project-${index}`, `Project ${index}`, `/workspace/p${index}`);
      return candidate(numbered);
    });
    const start = performance.now();
    const result = groundVoiceTurn({
      utterance: "check the authentication in Rebel.",
      candidates: [...many, ...projects.map(candidate)],
    });
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toMatchObject({ status: "needs-confirmation", heard: "Rebel" });
  });
});
