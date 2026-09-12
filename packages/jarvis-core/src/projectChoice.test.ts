import { describe, expect, it } from "vite-plus/test";

import { resolveJarvisProjectChoice } from "./projectChoice.ts";

const rivvl = { title: "Rivvl", label: "Rivvl — /work/rivvl" };
const alertify = { title: "Alertify", label: "Alertify — /work/alertify" };
const billing = { title: "Billing", label: "Billing — /work/billing" };

describe("shared project choice resolution", () => {
  it("resolves ordinals and number words against the offered order", () => {
    expect(resolveJarvisProjectChoice({ answer: "2", candidates: [rivvl, alertify] })).toEqual({
      index: 1,
      matchedText: "2",
      kind: "ordinal",
    });
    expect(
      resolveJarvisProjectChoice({ answer: "the second one", candidates: [rivvl, alertify] }),
    ).toEqual({ index: 1, matchedText: "the second one", kind: "ordinal" });
    expect(resolveJarvisProjectChoice({ answer: "first", candidates: [rivvl, alertify] })).toEqual({
      index: 0,
      matchedText: "first",
      kind: "ordinal",
    });
  });

  it("resolves an exact name or alias", () => {
    expect(
      resolveJarvisProjectChoice({
        answer: "Rivvl",
        candidates: [{ title: "Rivvl", names: ["rivvl"] }, billing],
      }),
    ).toEqual({ index: 0, matchedText: "Rivvl", kind: "name" });
    expect(
      resolveJarvisProjectChoice({
        answer: "alert effect",
        candidates: [{ title: "Alertify", label: "Alertify", names: ["alert effect"] }, billing],
      }),
    ).toEqual({ index: 0, matchedText: "alert effect", kind: "name" });
  });

  it("resolves a misheard answer to the unique fuzzy candidate and reports the matched word", () => {
    expect(
      resolveJarvisProjectChoice({ answer: "I meant rival.", candidates: [billing, rivvl] }),
    ).toEqual({ index: 1, matchedText: "rival.", kind: "fuzzy" });
  });

  it("refuses ties and distant guesses", () => {
    expect(resolveJarvisProjectChoice({ answer: "add", candidates: [rivvl, alertify] })).toBeNull();
    expect(
      resolveJarvisProjectChoice({
        answer: "payab",
        candidates: [{ title: "Payable" }, { title: "Payables" }],
      }),
    ).toBeNull();
  });

  it("accepts an affirmation only for a single offered candidate", () => {
    expect(
      resolveJarvisProjectChoice({
        answer: "yes",
        candidates: [rivvl],
        acceptsAffirmation: true,
      }),
    ).toEqual({ index: 0, matchedText: "yes", kind: "affirmation" });
    expect(
      resolveJarvisProjectChoice({
        answer: "yes",
        candidates: [rivvl, alertify],
        acceptsAffirmation: true,
      }),
    ).toBeNull();
  });
});
