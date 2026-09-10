import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_BREADCRUMB_BUTTON_CLASS,
  resolveRenameCommit,
  shouldShowOpenInPicker,
} from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});

describe("PROJECT_BREADCRUMB_BUTTON_CLASS", () => {
  it("expands the coarse-pointer hit area to 44px without growing the desktop layout", () => {
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("relative");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:absolute");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:size-full");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:min-h-11");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:min-w-11");
  });

  it("keeps the compact inline desktop presentation", () => {
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("inline-flex");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("min-w-0");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).not.toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).not.toMatch(/(^|\s)h-11(\s|$)/);
  });
});
