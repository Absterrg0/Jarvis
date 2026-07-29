import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

function scoreSlashCommandItem(
  item: Exclude<ComposerCommandItem, { type: "path" }>,
  query: string,
): number | null {
  const primaryValue = (() => {
    switch (item.type) {
      case "slash-command":
        return item.command;
      case "provider-slash-command":
        return item.command.name;
      case "custom-command":
        return item.command.name;
      case "create-custom-command":
        return item.label;
      case "model":
        return `${item.model} ${item.label}`;
      case "skill":
        return item.skill.name;
    }
  })().toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<Exclude<ComposerCommandItem, { type: "path" }>>,
  query: string,
): Array<Exclude<ComposerCommandItem, { type: "path" }>> {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: Exclude<ComposerCommandItem, { type: "path" }>;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: `${item.type}\u0000${primaryValueForTieBreak(item)}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}

function primaryValueForTieBreak(item: Exclude<ComposerCommandItem, { type: "path" }>): string {
  switch (item.type) {
    case "slash-command":
      return item.command;
    case "provider-slash-command":
      return `${item.command.name}\u0000${item.provider}`;
    case "custom-command":
      return item.command.name;
    case "create-custom-command":
      return item.label;
    case "model":
      return `${item.model}\u0000${item.instanceId}`;
    case "skill":
      return `${item.skill.name}\u0000${item.provider}`;
  }
}
