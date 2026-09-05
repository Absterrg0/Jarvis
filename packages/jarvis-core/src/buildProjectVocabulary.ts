import type {
  JarvisProjectAlias,
  JarvisProjectVocabulary,
  OrchestrationProjectShell,
} from "@t3tools/contracts";

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

/**
 * Group aliases by project once per catalog pass. Every per-project alias
 * scan (vocabulary, semantic names, deterministic resolution) shares this
 * index instead of filtering the whole alias list per project.
 */
export function groupJarvisAliasesByProject(
  aliases: ReadonlyArray<JarvisProjectAlias>,
): ReadonlyMap<string, ReadonlyArray<JarvisProjectAlias>> {
  const grouped = new Map<string, Array<JarvisProjectAlias>>();
  for (const alias of aliases) {
    const group = grouped.get(alias.projectId);
    if (group === undefined) grouped.set(alias.projectId, [alias]);
    else group.push(alias);
  }
  return grouped;
}

export function buildProjectVocabulary(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
}): JarvisProjectVocabulary {
  // Group aliases once per catalog construction: filtering the whole alias
  // list per project is quadratic in catalog size and dominates semantic
  // prompt preparation on large nodes. Order within a project follows the
  // input order, matching the previous per-project filter exactly.
  const aliasesByProject = groupJarvisAliasesByProject(input.aliases);
  return input.projects.map((project) => {
    const aliases = aliasesByProject.get(project.id) ?? [];
    return {
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryNames: [
        project.repositoryIdentity?.displayName,
        project.repositoryIdentity?.name,
      ].filter(present),
      aliases: aliases.map((alias) => alias.alias),
      aliasDetails: aliases.map(({ alias, kind }) => ({ alias, kind })),
    };
  });
}
