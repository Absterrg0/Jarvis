import type {
  CirceProjectRef,
  CirceSemanticProposal,
  CirceSemanticRef,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  findSourceQuoteSpans,
  isCirceNegatedOrContractedSpan,
  sourceSpanOverlapsQuotes,
} from "@circe/core/destinationSpan";
import {
  foldCirceMeshName,
  circeMeshCatalogCoverage,
  circeMeshNodeReadiness,
  meshProjectMatchNames,
  type CirceMeshCatalog,
  type CirceMeshNode,
  type CirceMeshNodeRecoveryAction,
  type CirceMeshProject,
  type CirceMeshProjectCandidate,
} from "./mesh.ts";

/**
 * Proposal-first execute grounding. One interpret call already produced a
 * typed proposal over verbatim source; this host grounds its destination or
 * correction ref against the real bounded catalog after role-aware negation.
 * No prepositions, no regex, no inferred spans: only cited refs route.
 *
 * A qualified pinned followup (an active task session) never swaps to a
 * mentioned project, but an explicitly named device does re-route it: naming a
 * device is a deliberate cross-node instruction. A negated (excluded-only)
 * turn never chooses a node. Malformed spans, unheard values, and unknown names
 * stay ambient so the execution node clarifies authoritatively instead of
 * routing on distrust. A named device is a hard constraint: a project that does
 * not live there is a conflict, an unknown device is reported, and a device
 * whose catalog is not ready is never treated as authoritative.
 */

export type CirceDeviceCandidate = {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly reachability: CirceMeshNode["reachability"];
};

export type CirceExecuteRoute =
  | { readonly status: "ambient" }
  | { readonly status: "routed"; readonly project: CirceMeshProject }
  | {
      readonly status: "needs-choice";
      readonly projectQuery: string;
      readonly candidates: ReadonlyArray<CirceMeshProjectCandidate>;
    }
  | {
      /** A device label shared by more than one node. */
      readonly status: "needs-device";
      readonly nodeQuery: string;
      readonly candidates: ReadonlyArray<CirceDeviceCandidate>;
    }
  | {
      readonly status: "unavailable";
      readonly project: CirceMeshProject;
      readonly nodeLabel: string;
    }
  | {
      /** The cited device exists but its own catalog is not ready. */
      readonly status: "device-not-ready";
      readonly nodeLabel: string;
      readonly message: string;
      readonly recovery: CirceMeshNodeRecoveryAction;
    }
  | {
      /** The cited device label matches no node: a hard routing constraint. */
      readonly status: "device-unknown";
      readonly nodeLabel: string;
    }
  | {
      /** The named project does not live on the cited device. */
      readonly status: "device-conflict";
      readonly projects: ReadonlyArray<CirceMeshProject>;
      readonly nodeLabel: string;
    }
  | {
      /** A compound turn cites steps on more than one device. */
      readonly status: "compound-devices";
      readonly nodeLabels: ReadonlyArray<string>;
    };

export interface CirceExecuteRouteCurrent {
  readonly projectRef: CirceProjectRef;
  readonly contextThreadId?: ThreadId;
}

const sameProjectRef = (left: CirceProjectRef, right: CirceProjectRef): boolean =>
  left.nodeId === right.nodeId && left.projectId === right.projectId;

const projectLabel = (project: CirceMeshProject): string =>
  `${project.title} — ${project.nodeLabel}`;

const nodeLabelOf = (node: CirceMeshNode): string => node.label;

const matchNodes = (catalog: CirceMeshCatalog, value: string): ReadonlyArray<CirceMeshNode> => {
  const query = foldCirceMeshName(value);
  if (query.length === 0) return [];
  return catalog.nodes.filter((node) => foldCirceMeshName(node.label) === query);
};

/**
 * A cited device authorizes routing only when its value was spoken inside the
 * span and the span is neither quoted nor in negation scope — the same host
 * conditions authorizing destination and task evidence already get. A device
 * mention the user ruled out or quoted never routes.
 */
function nodeSpanAuthorizes(source: string, ref: CirceSemanticRef): boolean {
  if (!containsFoldedName(ref.span.text, ref.value)) return false;
  const quotes = findSourceQuoteSpans(source);
  if (sourceSpanOverlapsQuotes(ref.span.start, ref.span.end, quotes)) return false;
  if (isCirceNegatedOrContractedSpan(source, ref.span.start)) return false;
  return true;
}

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
  const steps = proposal.steps ?? [];
  const stepRefs = steps.flatMap((step) => step.refs);
  const destinations = refs.filter((ref) => ref.role === "destination");
  const corrections = refs.filter((ref) => ref.role === "correction");
  const topNodeRefs = refs.filter((ref) => ref.role === "node");
  const stepNodeRefs = stepRefs.filter((ref) => ref.role === "node");
  if (
    destinations.length > 1 ||
    corrections.length > 1 ||
    destinations.length + corrections.length > 1 ||
    refs.filter((ref) => ref.role === "task").length > 1 ||
    refs.filter((ref) => ref.role === "provider").length > 1 ||
    topNodeRefs.length > 1
  ) {
    return { status: "ambient" };
  }
  // Structural proof first: every top-level span must reproduce the source
  // exactly and spans must not overlap. Step refs are validated per step by the
  // execution node; the client reads only their device refs for routing.
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
  // A compound turn carries each step's own refs. A step destination can name
  // the carrier project when the turn is routed to a step's device.
  const stepTarget = stepRefs.find(
    (ref) => ref.role === "destination" || ref.role === "correction",
  );
  const deviceTarget = target ?? stepTarget;
  if (
    stepTarget !== undefined &&
    stepTarget.role === "destination" &&
    !containsFoldedName(stepTarget.span.text, stepTarget.value)
  ) {
    return { status: "ambient" };
  }
  const matches = matchProjects(catalog, target?.value ?? "");
  const nodeRefs = [...topNodeRefs, ...stepNodeRefs];
  if (nodeRefs.length > 0) {
    // Every cited device must be real routing evidence: value spoken in the
    // span, not quoted, not negated. Otherwise the turn stays ambient for the
    // execution node to clarify.
    if (nodeRefs.some((ref) => !nodeSpanAuthorizes(source, ref))) return { status: "ambient" };
    const resolvedNodes: Array<CirceMeshNode> = [];
    for (const ref of nodeRefs) {
      const nodes = matchNodes(catalog, ref.value);
      if (nodes.length === 0) {
        // A named device is a hard constraint: never silently run elsewhere.
        return { status: "device-unknown", nodeLabel: ref.value };
      }
      if (nodes.length > 1) {
        return {
          status: "needs-device",
          nodeQuery: ref.value,
          candidates: nodes.map((candidate) => ({
            nodeId: candidate.nodeId,
            label: candidate.label,
            reachability: candidate.reachability,
          })),
        };
      }
      resolvedNodes.push(nodes[0]!);
    }
    const distinctNodes = new Map<string, CirceMeshNode>();
    for (const candidate of resolvedNodes) distinctNodes.set(candidate.nodeId, candidate);
    if (distinctNodes.size > 1) {
      // One execution node per compound turn, for now: refuse rather than
      // silently run every step on the ambient node.
      return {
        status: "compound-devices",
        nodeLabels: [...distinctNodes.values()].map(nodeLabelOf),
      };
    }
    const node = resolvedNodes[0]!;
    const deviceMatches = matchProjects(catalog, deviceTarget?.value ?? "");
    const currentOnNode =
      current !== null && current.projectRef.nodeId === node.nodeId
        ? catalog.projects.find((project) => sameProjectRef(project.ref, current.projectRef))
        : undefined;
    // The device's own catalog must be read before any project assertion: an
    // online node with a pending or failed catalog has unknown projects, so
    // its absence of a project proves nothing.
    const readiness = circeMeshNodeReadiness(node);
    if (readiness.status !== "ready") {
      // A device-only turn on the current project there is still safe.
      if (deviceTarget === undefined && currentOnNode !== undefined) {
        return { status: "routed", project: currentOnNode };
      }
      return {
        status: "device-not-ready",
        nodeLabel: nodeLabelOf(node),
        message:
          readiness.status === "unavailable"
            ? readiness.message
            : `${nodeLabelOf(node)}'s project list is still loading. Try again in a moment.`,
        recovery: readiness.status === "unavailable" ? readiness.recovery : "retry",
      };
    }
    const onNode = deviceMatches.filter((project) => project.ref.nodeId === node.nodeId);
    const offNode = deviceMatches.filter((project) => project.ref.nodeId !== node.nodeId);
    if (onNode.length === 1) return routeToProject(catalog, onNode[0]!);
    if (onNode.length > 1) {
      return {
        status: "needs-choice",
        projectQuery: deviceTarget?.value ?? "",
        candidates: onNode.map((project) => ({ ...project, label: projectLabel(project) })),
      };
    }
    if (offNode.length > 0) {
      // The named project lives elsewhere. The device is ready and does not
      // hold it, so this is a conflict rather than an invitation to abandon
      // the device the user named.
      return { status: "device-conflict", projects: offNode, nodeLabel: nodeLabelOf(node) };
    }
    // Device named with no named project: prefer the current project there,
    // else the device's only project, else ask within the device.
    const nodeProjects = catalog.projects.filter((project) => project.ref.nodeId === node.nodeId);
    if (currentOnNode !== undefined) return { status: "routed", project: currentOnNode };
    if (nodeProjects.length === 1) return { status: "routed", project: nodeProjects[0]! };
    if (nodeProjects.length > 1) {
      return {
        status: "needs-choice",
        projectQuery: "",
        candidates: nodeProjects.map((project) => ({ ...project, label: projectLabel(project) })),
      };
    }
    // A ready device with no projects has nothing to route to.
    return { status: "ambient" };
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
  /**
   * True only when a unique, catalog-ready device was grounded for this turn.
   * The device choice is explicit then, so partial coverage of other nodes
   * cannot make the project name unsound. A cited-but-ungrounded device does
   * not qualify.
   */
  readonly deviceGrounded?: boolean;
}): CirceRouteCoverageCheck {
  if (input.pinned) return { status: "proceed" };
  if (input.deviceGrounded === true) return { status: "proceed" };
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
