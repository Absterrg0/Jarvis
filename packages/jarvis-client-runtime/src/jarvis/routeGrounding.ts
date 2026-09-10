import type { JarvisProjectRef, JarvisSemanticProposal, ThreadId } from "@t3tools/contracts";
import {
  foldJarvisMeshName,
  jarvisMeshCatalogCoverage,
  meshProjectMatchNames,
  type JarvisMeshCatalog,
  type JarvisMeshProject,
  type JarvisMeshProjectCandidate,
} from "./mesh.ts";

/**
 * Proposal-first execute grounding. One interpret call already produced a
 * typed proposal over verbatim source; this host grounds its destination or
 * correction ref against the real bounded catalog after role-aware negation.
 * No prepositions, no regex, no inferred spans: only cited refs route.
 *
 * A qualified pinned followup (an active task thread) never swaps to a
 * mentioned project. A negated (excluded-only) turn never chooses a node.
 * Malformed spans, unheard values, and unknown names stay ambient so the
 * execution node clarifies authoritatively instead of routing on distrust.
 * Ambiguity asks with node-qualified candidates; an unambiguous destination
 * on a disconnected node reports unavailable with no fallback.
 */

export type JarvisExecuteRoute =
  | { readonly status: "ambient" }
  | { readonly status: "routed"; readonly project: JarvisMeshProject }
  | {
      readonly status: "needs-choice";
      readonly projectQuery: string;
      readonly candidates: ReadonlyArray<JarvisMeshProjectCandidate>;
    }
  | {
      readonly status: "unavailable";
      readonly project: JarvisMeshProject;
      readonly nodeLabel: string;
    };

export interface JarvisExecuteRouteCurrent {
  readonly projectRef: JarvisProjectRef;
  readonly contextThreadId?: ThreadId;
}

const sameProjectRef = (left: JarvisProjectRef, right: JarvisProjectRef): boolean =>
  left.nodeId === right.nodeId && left.projectId === right.projectId;

const projectLabel = (project: JarvisMeshProject): string =>
  `${project.title} — ${project.nodeLabel}`;

function checkSpan(source: string, start: number, end: number, text: string): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > source.length || end <= start) return false;
  return source.slice(start, end) === text;
}

function containsFoldedName(wrapperText: string, value: string): boolean {
  const folded = foldJarvisMeshName(wrapperText);
  const name = foldJarvisMeshName(value);
  if (folded.length === 0 || name.length === 0) return false;
  const escaped = name
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  return new RegExp(`\\b${escaped}\\b`, "u").test(folded);
}

function matchProjects(
  catalog: JarvisMeshCatalog,
  value: string,
): ReadonlyArray<JarvisMeshProject> {
  const query = foldJarvisMeshName(value);
  if (query.length === 0) return [];
  const seen = new Set<string>();
  const out: JarvisMeshProject[] = [];
  for (const project of catalog.projects) {
    const key = `${project.ref.nodeId}:${project.ref.projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (meshProjectMatchNames(project).some((name) => foldJarvisMeshName(name) === query)) {
      out.push(project);
    }
  }
  return out;
}

export function resolveJarvisProposalExecuteRoute(
  catalog: JarvisMeshCatalog,
  source: string,
  proposal: JarvisSemanticProposal,
  current: JarvisExecuteRouteCurrent | null,
): JarvisExecuteRoute {
  // A pinned followup keeps its task before any mention is considered. Pins
  // stay on the owner node; a cross-node destination never steals the turn.
  if (current?.contextThreadId !== undefined) return { status: "ambient" };
  // Bounded grammar host-conditions arrive as unsupported: never route,
  // never choose, never report unavailable. The execution node clarifies
  // authoritatively with no partial dispatch.
  if (proposal.action === "unsupported") return { status: "ambient" };
  const refs = proposal.refs;
  if (refs.length > 8) return { status: "ambient" };
  const destinations = refs.filter((ref) => ref.role === "destination");
  const corrections = refs.filter((ref) => ref.role === "correction");
  if (
    destinations.length > 1 ||
    corrections.length > 1 ||
    destinations.length + corrections.length > 1 ||
    refs.filter((ref) => ref.role === "task").length > 1 ||
    refs.filter((ref) => ref.role === "provider").length > 1
  ) {
    return { status: "ambient" };
  }
  // Structural proof first: every span must reproduce the source exactly,
  // spans must not overlap, and destination wrappers must contain their name.
  const ordered = [...refs].sort((a, b) => a.span.start - b.span.start);
  for (const [index, ref] of ordered.entries()) {
    const prev = ordered[index - 1];
    if (prev !== undefined && ref.span.start < prev.span.end) return { status: "ambient" };
    if (!checkSpan(source, ref.span.start, ref.span.end, ref.span.text)) {
      return { status: "ambient" };
    }
    if (ref.value.trim().length === 0) return { status: "ambient" };
  }
  const destination = destinations[0];
  const correction = corrections[0];
  const target = destination ?? correction;
  if (destination !== undefined && !containsFoldedName(destination.span.text, destination.value)) {
    return { status: "ambient" };
  }
  if (correction !== undefined) {
    const heard = foldJarvisMeshName(correction.span.text);
    if (heard.length === 0 || heard !== foldJarvisMeshName(correction.value)) {
      return { status: "ambient" };
    }
  }
  // No positive target claim: excluded-only (negated) and subject-only turns
  // never choose a node. The execution node applies the ambient veto itself.
  if (target === undefined) return { status: "ambient" };
  const matches = matchProjects(catalog, target.value);
  if (matches.length === 0) return { status: "ambient" };
  if (matches.length > 1) {
    return {
      status: "needs-choice",
      projectQuery: target.value,
      candidates: matches.map((project) => ({ ...project, label: projectLabel(project) })),
    };
  }
  const project = matches[0]!;
  if (current !== null && sameProjectRef(current.projectRef, project.ref)) {
    return { status: "ambient" };
  }
  const live = catalog.nodes.find((candidate) => candidate.nodeId === project.ref.nodeId);
  if (live === undefined || live.reachability !== "online") {
    return { status: "unavailable", project, nodeLabel: project.nodeLabel };
  }
  return { status: "routed", project };
}

export type JarvisRouteCoverageCheck =
  | { readonly status: "proceed" }
  | {
      readonly status: "confirm";
      readonly project: JarvisMeshProject;
      readonly nodeLabels: ReadonlyArray<string>;
    };

function valueMatchesProject(value: string, project: JarvisMeshProject): boolean {
  const query = foldJarvisMeshName(value);
  if (query.length === 0) return false;
  return meshProjectMatchNames(project).some((name) => foldJarvisMeshName(name) === query);
}

function sourceMentionsProject(source: string, project: JarvisMeshProject): boolean {
  const foldedSource = foldJarvisMeshName(source);
  if (foldedSource.length === 0) return false;
  return meshProjectMatchNames(project).some((name) => {
    const folded = foldJarvisMeshName(name);
    if (folded.length === 0) return false;
    const escaped = folded
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s+");
    return new RegExp(`\\b${escaped}\\b`, "u").test(foldedSource);
  });
}

/**
 * Uniqueness confirmation for name-dependent routes under partial catalog
 * coverage. A route that depends on a project name is unsound when an
 * unread node may hold the same name, so the caller must confirm instead of
 * dispatching. Name-independent turns (no name cited, none mentioned) stay
 * on their path: nothing about them claims a unique name. Pinned followups
 * never confirm: the pin already owns the turn. Malformed proposals proceed
 * to authoritative execution clarification instead of being masked by a
 * coverage question. With no resolved target, exactly one mentioned visible
 * project confirms; zero or several fall through to the caller's explicit
 * choice question.
 */
export function resolveJarvisRouteCoverageConfirm(input: {
  readonly catalog: JarvisMeshCatalog;
  readonly source: string;
  readonly proposal: JarvisSemanticProposal;
  readonly resolved: JarvisMeshProject | undefined;
  readonly routed: boolean;
  readonly pinned: boolean;
}): JarvisRouteCoverageCheck {
  if (input.pinned) return { status: "proceed" };
  const coverage = jarvisMeshCatalogCoverage(input.catalog);
  if (coverage.complete) return { status: "proceed" };
  const confirm = (project: JarvisMeshProject): JarvisRouteCoverageCheck => ({
    status: "confirm",
    project,
    nodeLabels: coverage.unavailableNodeLabels,
  });
  const targets = input.proposal.refs.filter(
    (ref) => ref.role === "destination" || ref.role === "correction",
  );
  // A successful route proves structural soundness plus a name match: the
  // only open question is uniqueness against the unread nodes.
  if (input.routed) {
    return input.resolved === undefined ? { status: "proceed" } : confirm(input.resolved);
  }
  if (input.resolved !== undefined) {
    if (targets.length === 1 && valueMatchesProject(targets[0]!.value, input.resolved)) {
      return confirm(input.resolved);
    }
    if (targets.length === 0) {
      // An excluded ambient name belongs to the execution node's veto
      // question, not to a uniqueness confirmation for that same project.
      const excluded = input.proposal.refs.filter((ref) => ref.role === "excluded");
      if (excluded.some((ref) => valueMatchesProject(ref.value, input.resolved!))) {
        return { status: "proceed" };
      }
      if (sourceMentionsProject(input.source, input.resolved)) {
        return confirm(input.resolved);
      }
    }
    return { status: "proceed" };
  }
  // No target yet: confirm only a single mentioned visible project with no
  // routing refs and no exclusion against it. Anything else belongs to the
  // caller's explicit choice question.
  if (targets.length > 0) return { status: "proceed" };
  const mentioned = input.catalog.projects.filter((project) =>
    sourceMentionsProject(input.source, project),
  );
  if (mentioned.length !== 1) return { status: "proceed" };
  const only = mentioned[0]!;
  const excluded = input.proposal.refs.filter((ref) => ref.role === "excluded");
  if (excluded.some((ref) => valueMatchesProject(ref.value, only))) {
    return { status: "proceed" };
  }
  return confirm(only);
}
