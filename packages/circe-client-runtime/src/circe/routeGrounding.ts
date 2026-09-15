import type { CirceProjectRef, CirceSemanticProposal, ThreadId } from "@t3tools/contracts";
import {
  foldCirceMeshName,
  circeMeshCatalogCoverage,
  meshProjectMatchNames,
  type CirceMeshCatalog,
  type CirceMeshNode,
  type CirceMeshProject,
  type CirceMeshProjectCandidate,
} from "./mesh.ts";

/**
 * Proposal-first execute grounding. One interpret call already produced a
 * typed proposal over verbatim source; this host grounds its destination or
 * correction ref against the real bounded catalog after role-aware negation.
 * No prepositions, no regex, no inferred spans: only cited refs route.
 *
 * A qualified pinned followup (an active task thread) never swaps to a
 * mentioned project, but an explicitly named device does re-route it: naming a
 * device is a deliberate cross-node instruction. A negated (excluded-only)
 * turn never chooses a node. Malformed spans, unheard values, and unknown names
 * stay ambient so the execution node clarifies authoritatively instead of
 * routing on distrust. Ambiguity asks with node-qualified candidates; an
 * unambiguous destination on a disconnected node reports unavailable with no
 * fallback.
 */

export type CirceExecuteRoute =
  | { readonly status: "ambient" }
  | { readonly status: "routed"; readonly project: CirceMeshProject }
  | {
      readonly status: "needs-choice";
      readonly projectQuery: string;
      readonly candidates: ReadonlyArray<CirceMeshProjectCandidate>;
    }
  | {
      readonly status: "unavailable";
      readonly project: CirceMeshProject;
      readonly nodeLabel: string;
    }
  | {
      readonly status: "device-unavailable";
      readonly nodeLabel: string;
    }
  | {
      /** A destination project that does not live on the cited device. */
      readonly status: "device-conflict";
      readonly project: CirceMeshProject;
      readonly nodeLabel: string;
    };

export interface CirceExecuteRouteCurrent {
  readonly projectRef: CirceProjectRef;
  readonly contextThreadId?: ThreadId;
}

const sameProjectRef = (left: CirceProjectRef, right: CirceProjectRef): boolean =>
  left.nodeId === right.nodeId && left.projectId === right.projectId;

const projectLabel = (project: CirceMeshProject): string =>
  `${project.title} — ${project.nodeLabel}`;

const matchNodes = (catalog: CirceMeshCatalog, value: string): ReadonlyArray<CirceMeshNode> => {
  const query = foldCirceMeshName(value);
  if (query.length === 0) return [];
  return catalog.nodes.filter((node) => foldCirceMeshName(node.label) === query);
};

function checkSpan(source: string, start: number, end: number, text: string): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > source.length || end <= start) return false;
  return source.slice(start, end) === text;
}

function containsFoldedName(wrapperText: string, value: string): boolean {
  const folded = foldCirceMeshName(wrapperText);
  const name = foldCirceMeshName(value);
  if (folded.length === 0 || name.length === 0) return false;
  const escaped = name
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  return new RegExp(`\\b${escaped}\\b`, "u").test(folded);
}

function matchProjects(catalog: CirceMeshCatalog, value: string): ReadonlyArray<CirceMeshProject> {
  const query = foldCirceMeshName(value);
  if (query.length === 0) return [];
  const seen = new Set<string>();
  const out: CirceMeshProject[] = [];
  for (const project of catalog.projects) {
    const key = `${project.ref.nodeId}:${project.ref.projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (meshProjectMatchNames(project).some((name) => foldCirceMeshName(name) === query)) {
      out.push(project);
    }
  }
  return out;
}

export function resolveCirceProposalExecuteRoute(
  catalog: CirceMeshCatalog,
  source: string,
  proposal: CirceSemanticProposal,
  current: CirceExecuteRouteCurrent | null,
): CirceExecuteRoute {
  // Bounded grammar host-conditions arrive as unsupported: never route,
  // never choose, never report unavailable. The execution node clarifies
  // authoritatively with no partial dispatch.
  if (proposal.action === "unsupported") return { status: "ambient" };
  const refs = proposal.refs;
  if (refs.length > 8) return { status: "ambient" };
  const destinations = refs.filter((ref) => ref.role === "destination");
  const corrections = refs.filter((ref) => ref.role === "correction");
  const nodeRefs = refs.filter((ref) => ref.role === "node");
  if (
    destinations.length > 1 ||
    corrections.length > 1 ||
    destinations.length + corrections.length > 1 ||
    refs.filter((ref) => ref.role === "task").length > 1 ||
    refs.filter((ref) => ref.role === "provider").length > 1 ||
    nodeRefs.length > 1
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
    const heard = foldCirceMeshName(correction.span.text);
    if (heard.length === 0 || heard !== foldCirceMeshName(correction.value)) {
      return { status: "ambient" };
    }
  }

  // An explicitly named device is a deliberate cross-node instruction: it is
  // consulted before the pinned-followup rule, so naming a device re-routes a
  // followup that a bare project mention could not.
  const nodeRef = nodeRefs[0];
  const matches = matchProjects(catalog, target?.value ?? "");
  if (nodeRef !== undefined) {
    const nodes = matchNodes(catalog, nodeRef.value);
    if (nodes.length === 1) {
      const node = nodes[0]!;
      const onNode = matches.filter((project) => project.ref.nodeId === node.nodeId);
      const offNode = matches.filter((project) => project.ref.nodeId !== node.nodeId);
      if (onNode.length === 1) {
        // A device and a project that agrees with it: route to that project.
        return routeToProject(catalog, onNode[0]!);
      }
      if (onNode.length > 1) {
        return {
          status: "needs-choice",
          projectQuery: target?.value ?? "",
          candidates: onNode.map((project) => ({ ...project, label: projectLabel(project) })),
        };
      }
      if (offNode.length === 1) {
        // The named project lives on another device: surface the conflict
        // instead of guessing which the user meant.
        return { status: "device-conflict", project: offNode[0]!, nodeLabel: node.label };
      }
      if (offNode.length > 1) {
        return {
          status: "needs-choice",
          projectQuery: target?.value ?? "",
          candidates: offNode.map((project) => ({ ...project, label: projectLabel(project) })),
        };
      }
      // Device named with no resolvable project: prefer the current project on
      // that device, else the device's only project, else ask within the device.
      if (node.reachability !== "online") {
        return { status: "device-unavailable", nodeLabel: node.label };
      }
      const nodeProjects = catalog.projects.filter((project) => project.ref.nodeId === node.nodeId);
      const currentOnNode =
        current !== null && current.projectRef.nodeId === node.nodeId
          ? nodeProjects.find((project) => sameProjectRef(project.ref, current.projectRef))
          : undefined;
      if (currentOnNode !== undefined) return { status: "routed", project: currentOnNode };
      if (nodeProjects.length === 1) return { status: "routed", project: nodeProjects[0]! };
      if (nodeProjects.length > 1) {
        return {
          status: "needs-choice",
          projectQuery: "",
          candidates: nodeProjects.map((project) => ({ ...project, label: projectLabel(project) })),
        };
      }
      // Online device with no projects: stay ambient and let the execution
      // node clarify the missing project.
      return { status: "ambient" };
    }
    if (nodes.length > 1) {
      // A label shared by several devices is not a route: fall through so the
      // project mention (or execution-node clarification) decides instead.
      return { status: "ambient" };
    }
    // No device matched the label: not routing evidence, so fall through to
    // project routing exactly as if the node ref were absent.
  }

  // A pinned followup keeps its task before any project mention is considered.
  if (current?.contextThreadId !== undefined) return { status: "ambient" };
  // No positive target claim: excluded-only (negated) and subject-only turns
  // never choose a node. The execution node applies the ambient veto itself.
  if (target === undefined) return { status: "ambient" };
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
  return routeToProject(catalog, project);
}

/** Route to a resolved project, refusing an offline owner node. */
function routeToProject(catalog: CirceMeshCatalog, project: CirceMeshProject): CirceExecuteRoute {
  const live = catalog.nodes.find((candidate) => candidate.nodeId === project.ref.nodeId);
  if (live === undefined || live.reachability !== "online") {
    return { status: "unavailable", project, nodeLabel: project.nodeLabel };
  }
  return { status: "routed", project };
}

export type CirceRouteCoverageCheck =
  | { readonly status: "proceed" }
  | {
      readonly status: "confirm";
      readonly project: CirceMeshProject;
      readonly nodeLabels: ReadonlyArray<string>;
    };

function valueMatchesProject(value: string, project: CirceMeshProject): boolean {
  const query = foldCirceMeshName(value);
  if (query.length === 0) return false;
  return meshProjectMatchNames(project).some((name) => foldCirceMeshName(name) === query);
}

function sourceMentionsProject(source: string, project: CirceMeshProject): boolean {
  const foldedSource = foldCirceMeshName(source);
  if (foldedSource.length === 0) return false;
  return meshProjectMatchNames(project).some((name) => {
    const folded = foldCirceMeshName(name);
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
export function resolveCirceRouteCoverageConfirm(input: {
  readonly catalog: CirceMeshCatalog;
  readonly source: string;
  readonly proposal: CirceSemanticProposal;
  readonly resolved: CirceMeshProject | undefined;
  readonly routed: boolean;
  readonly pinned: boolean;
}): CirceRouteCoverageCheck {
  if (input.pinned) return { status: "proceed" };
  // A cited device is an explicit routing target: the choice is already made,
  // so partial catalog coverage cannot make it unsound.
  if (input.proposal.refs.some((ref) => ref.role === "node")) return { status: "proceed" };
  const coverage = circeMeshCatalogCoverage(input.catalog);
  if (coverage.complete) return { status: "proceed" };
  const confirm = (project: CirceMeshProject): CirceRouteCoverageCheck => ({
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
