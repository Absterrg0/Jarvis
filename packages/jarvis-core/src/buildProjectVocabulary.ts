import type {
  JarvisProjectAlias,
  JarvisProjectVocabulary,
  OrchestrationProjectShell,
} from "@t3tools/contracts";

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

export function buildProjectVocabulary(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly aliases: ReadonlyArray<JarvisProjectAlias>;
}): JarvisProjectVocabulary {
  return input.projects.map((project) => {
    const aliases = input.aliases.filter((alias) => alias.projectId === project.id);
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
