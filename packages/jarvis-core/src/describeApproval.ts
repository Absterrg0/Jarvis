export type ApprovalRisk =
  | "read"
  | "read-and-compute"
  | "workspace-write"
  | "external-effect"
  | "destructive"
  | "unknown";

export type ApprovalDescription = {
  readonly spoken: string;
  readonly risk: ApprovalRisk;
  readonly rawDetail: string;
};

function compact(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function commandTokens(command: string): ReadonlyArray<string> {
  return (
    command
      .match(/(?:"[^"]*"|'[^']*'|[^\s]+)/gu)
      ?.map((token) => token.replace(/^['"]|['"]$/gu, "")) ?? []
  );
}

function destructiveTarget(tokens: ReadonlyArray<string>): string | undefined {
  const commandIndex = tokens.findIndex((token) => /^(?:rm|rmdir|del|remove-item)$/iu.test(token));
  if (commandIndex < 0) return undefined;
  return tokens.slice(commandIndex + 1).find((token) => !token.startsWith("-"));
}

function describesTestCommand(tokens: ReadonlyArray<string>): boolean {
  return (
    tokens.some((token) =>
      /^(?:vitest|jest|pytest|cargo-test|go-test)$/iu.test(token.replace(/\s+/gu, "-")),
    ) || tokens.some((token) => /^(?:test|tests|test:.*)$/iu.test(token))
  );
}

function describesBuildCommand(tokens: ReadonlyArray<string>): boolean {
  return tokens.some((token) => /^(?:build|compile|tsc|cargo|make)$/iu.test(token));
}

function describesInstallCommand(tokens: ReadonlyArray<string>): boolean {
  return (
    tokens.some((token) => /^(?:install|add|update|upgrade)$/iu.test(token)) &&
    tokens.some((token) => /^(?:pnpm|npm|yarn|bun|pip|pip3|cargo|dnf|apt|brew)$/iu.test(token))
  );
}

function includesSequence(tokens: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return tokens.some((_, index) =>
    expected.every((token, offset) => tokens[index + offset]?.toLowerCase() === token),
  );
}

function readableList(values: ReadonlyArray<string>): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function inspectedFiles(rawDetail: string): ReadonlyArray<string> {
  const files = Array.from(
    rawDetail.matchAll(
      /\bsed\s+-n\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/giu,
    ),
    (match) => match[1] ?? match[2] ?? match[3],
  ).filter((value): value is string => value !== undefined && !value.endsWith("/SKILL.md"));
  return [...new Set(files)];
}

function readOnlyInspectionDescription(rawDetail: string): string | undefined {
  const purposes: Array<string> = [];
  const files = inspectedFiles(rawDetail);
  if (files.length > 0) purposes.push(`read ${readableList(files)}`);
  const skill = /\/skills\/([^/\s"']+)\/SKILL\.md/iu.exec(rawDetail)?.[1];
  if (skill !== undefined && /\bsed\s+-n\b|\b(?:cat|head|tail)\b/iu.test(rawDetail)) {
    purposes.push(`read the ${skill} instructions`);
  }
  const repositoryFacts = [
    /\bgit\s+remote(?:\s+-v)?\b/iu.test(rawDetail) ? "remotes" : undefined,
    /\bgit\s+status\b/iu.test(rawDetail) ? "status" : undefined,
    /\bgit\s+branch\s+--show-current\b/iu.test(rawDetail) ? "current branch" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (repositoryFacts.length > 0) {
    purposes.push(`inspect repository ${readableList(repositoryFacts)}`);
  }
  if (
    /\bfind\s+\.\s+[^;&|]*-type\s+d\b/iu.test(rawDetail) &&
    /-maxdepth\s+(?:1|2)\b/iu.test(rawDetail)
  ) {
    purposes.push(
      /(?:-not\s+)?-path\s+['"]?\.\/\.git/iu.test(rawDetail)
        ? "list the top-level project directories, excluding Git internals"
        : "list the top-level project directories",
    );
  }
  if (purposes.length === 0) return undefined;
  if (
    /(?:^|[;&|]\s*|\b)(?:rm|rmdir|del|remove-item|mv|cp|tee|sudo|curl|wget)\b|\bgit\s+(?:add|commit|push|reset|clean|checkout|switch|merge|rebase)\b|\bsed\s+-i\b|(?:^|[^<])>{1,2}(?:[^>]|$)/iu.test(
      rawDetail,
    )
  ) {
    return undefined;
  }
  if (purposes.length === 1) return purposes[0];
  return readableList(purposes);
}

/** Keeps raw tool detail available while producing only claims we can infer safely. */
export function describeApproval(input: {
  readonly requestKind?: string;
  readonly detail?: string;
  readonly projectTitle: string;
}): ApprovalDescription {
  const rawDetail = compact(input.detail ?? "");
  const target = rawDetail.length > 0 ? rawDetail : "the requested files";
  const testSubject =
    input.projectTitle === "this project"
      ? "tests for this project"
      : `${input.projectTitle} tests`;
  if (input.requestKind === "file-read") {
    return {
      spoken: `The agent wants to read ${target} in ${input.projectTitle}. Allow it?`,
      risk: "read",
      rawDetail,
    };
  }
  if (input.requestKind === "file-change") {
    return {
      spoken: `The agent wants to modify ${target} in ${input.projectTitle}. The change will remain reviewable in T3. Allow it?`,
      risk: "workspace-write",
      rawDetail,
    };
  }

  const tokens = commandTokens(rawDetail);
  if (
    includesSequence(tokens, ["git", "reset", "--hard"]) ||
    includesSequence(tokens, ["git", "clean"])
  ) {
    return {
      spoken: `The agent wants to discard local work in ${input.projectTitle}. This can permanently remove uncommitted files or changes. Allow it?`,
      risk: "destructive",
      rawDetail,
    };
  }
  const deletionTarget = destructiveTarget(tokens);
  if (deletionTarget !== undefined) {
    return {
      spoken: `The agent wants to permanently delete ${deletionTarget} in ${input.projectTitle}. This cannot be undone automatically. Allow it?`,
      risk: "destructive",
      rawDetail,
    };
  }
  if (describesTestCommand(tokens)) {
    return {
      spoken: `The agent wants to run the ${testSubject}. This reads the project and may use extra processing power for a few minutes. Allow it?`,
      risk: "read-and-compute",
      rawDetail,
    };
  }
  if (describesInstallCommand(tokens)) {
    return {
      spoken: `The agent wants to install or update dependencies for ${input.projectTitle}. This changes local dependencies and may access the network. Allow it?`,
      risk: "external-effect",
      rawDetail,
    };
  }
  if (describesBuildCommand(tokens)) {
    return {
      spoken: `The agent wants to build ${input.projectTitle}. This may create generated files and use extra processing power. Allow it?`,
      risk: "workspace-write",
      rawDetail,
    };
  }
  if (includesSequence(tokens, ["git", "push"])) {
    return {
      spoken: `The agent wants to publish local commits from ${input.projectTitle} to a remote repository. This changes shared external state. Allow it?`,
      risk: "external-effect",
      rawDetail,
    };
  }
  if (
    tokens.some((token) => /^(?:curl|wget)$/iu.test(token)) ||
    tokens.some((token) => /^(?:sudo|runas)$/iu.test(token))
  ) {
    return {
      spoken: `The agent wants to run a command with network or elevated-system access for ${input.projectTitle}. Review the exact command before allowing it.`,
      risk: "external-effect",
      rawDetail,
    };
  }
  if (tokens.some((token) => /^(?:migrate|migration|db:migrate|prisma)$/iu.test(token))) {
    return {
      spoken: `The agent wants to run a database migration for ${input.projectTitle}. This may change persistent data. Review the target database before allowing it.`,
      risk: "external-effect",
      rawDetail,
    };
  }
  const inspection = readOnlyInspectionDescription(rawDetail);
  if (inspection !== undefined) {
    return {
      spoken: `The agent wants to ${inspection} in ${input.projectTitle}. This only reads local information. Allow it?`,
      risk: "read",
      rawDetail,
    };
  }
  return {
    spoken: `The agent wants to run a command in ${input.projectTitle} that I cannot safely summarize. Review the exact command on screen before allowing it.`,
    risk: "unknown",
    rawDetail,
  };
}
