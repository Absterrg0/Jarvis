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
  return {
    spoken: `The agent wants to run a command in ${input.projectTitle} that I cannot safely summarize. Review the exact command on screen before allowing it.`,
    risk: "unknown",
    rawDetail,
  };
}
