import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeContextModel, selectContextModel } from "./ContextPanel";

function model(overrides: Partial<ServerProviderModel> & { slug: string }): ServerProviderModel {
  return {
    name: overrides.slug,
    isCustom: false,
    capabilities: null,
    ...overrides,
  };
}

describe("selectContextModel", () => {
  it("returns null when the provider lists no models", () => {
    expect(selectContextModel([])).toBeNull();
  });

  it("prefers the default non-custom model", () => {
    const models = [
      model({ slug: "first", isDefault: true, isCustom: true }),
      model({ slug: "second" }),
      model({ slug: "third", isDefault: true }),
    ];
    expect(selectContextModel(models)?.slug).toBe("third");
  });

  it("falls back to the first non-custom model without a default", () => {
    const models = [model({ slug: "first", isCustom: true }), model({ slug: "second" })];
    expect(selectContextModel(models)?.slug).toBe("second");
  });

  it("falls back to the first model when every model is custom", () => {
    const models = [model({ slug: "first", isCustom: true })];
    expect(selectContextModel(models)?.slug).toBe("first");
  });
});

describe("describeContextModel", () => {
  it("returns null when no flag applies", () => {
    expect(describeContextModel(model({ slug: "plain" }))).toBeNull();
  });

  it("joins the real flags that apply", () => {
    expect(describeContextModel(model({ slug: "flagged", isDefault: true, badge: "new" }))).toBe(
      "Default · New",
    );
  });

  it("names legacy and custom models", () => {
    expect(describeContextModel(model({ slug: "old", isLegacy: true }))).toBe("Legacy");
    expect(describeContextModel(model({ slug: "mine", isCustom: true }))).toBe("Custom");
  });
});
