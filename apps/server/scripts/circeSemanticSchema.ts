import { CirceSemanticProposal } from "@circe/core/command";

import { toJsonSchemaObject } from "../src/textGeneration/TextGenerationUtils.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collapse Effect null-union output (`anyOf: [T, {type: "null"}]`) into a
 * strict `type: [T, "null"]` form, flattening `allOf` constraint blocks.
 * Anything unrecognized passes through untouched so schema evolution never
 * silently drops a field.
 */
function strictProperty(property: unknown): unknown {
  if (!isObject(property)) return property;
  const flattened = { ...property };
  const allOf = flattened.allOf;
  if (Array.isArray(allOf)) {
    delete flattened.allOf;
    for (const part of allOf) {
      if (isObject(part)) Object.assign(flattened, part);
    }
  }
  const anyOf = flattened.anyOf;
  if (Array.isArray(anyOf)) {
    const nullBranch = anyOf.find(
      (branch): branch is JsonObject => isObject(branch) && branch.type === "null",
    );
    const valueBranches = anyOf.filter((branch) => branch !== nullBranch);
    if (nullBranch !== undefined && valueBranches.length === 1 && isObject(valueBranches[0])) {
      const value = strictProperty(valueBranches[0]) as JsonObject;
      delete flattened.anyOf;
      const valueType = value.type;
      return {
        ...value,
        ...flattened,
        type:
          typeof valueType === "string"
            ? [valueType, "null"]
            : Array.isArray(valueType)
              ? [...valueType, "null"]
              : ["string", "null"],
      };
    }
  }
  return flattened;
}

/**
 * Production-compatible strict JSON Schema for the live semantic proposal.
 * Every key derives from the imported Effect schema, so new literals (such
 * as `unsupported`) flow through without edits here. Strictness the base
 * document lacks: all properties required, no additional properties.
 */
export function buildStrictCirceSemanticJsonSchema(): JsonObject {
  const base = toJsonSchemaObject(CirceSemanticProposal);
  if (!isObject(base) || !isObject(base.properties)) {
    throw new Error("CirceSemanticProposal did not produce an object schema.");
  }
  const properties: JsonObject = {};
  for (const [key, property] of Object.entries(base.properties)) {
    properties[key] = strictProperty(property);
  }
  const schema: JsonObject = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  if (base.$defs !== undefined) schema.$defs = base.$defs;
  return schema;
}
