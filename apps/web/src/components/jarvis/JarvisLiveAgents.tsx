import { ActivityIcon, ChevronRightIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { useThreadShells } from "../../state/entities";
import { buildDesktopJarvisOrbAgents } from "./JarvisDesktopOrb.bridge";

/** Existing task shell events keep both views current without polling. */
export function JarvisLiveAgents({
  catalog,
  view = "active",
}: {
  readonly catalog: JarvisMeshCatalog | null;
  readonly view?: "active" | "recent";
}) {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const agents = useMemo(() => buildDesktopJarvisOrbAgents(threads, catalog), [threads, catalog]);
  const rows = useMemo(() => {
    if (view === "active") return agents;
    const nodes = new Map(catalog?.nodes.map((node) => [node.nodeId, node]));
    return threads
      .filter((thread) => thread.archivedAt === null && nodes.has(thread.environmentId))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8)
      .map((thread) => {
        const active = agents.find(
          (agent) =>
            agent.taskRef.threadId === thread.id &&
            agent.taskRef.executionNodeId === thread.environmentId,
        );
        const node = nodes.get(thread.environmentId);
        const project = catalog?.projects.find(
          (project) =>
            project.ref.nodeId === thread.environmentId &&
            project.ref.projectId === thread.projectId,
        );
        const provider = catalog?.providers.find(
          (provider) =>
            provider.nodeId === thread.environmentId &&
            provider.snapshot.instanceId === thread.modelSelection.instanceId,
        );
        return (
          active ?? {
            taskRef: { executionNodeId: thread.environmentId, threadId: thread.id },
            title: thread.title,
            projectTitle: project?.title ?? "Project unavailable",
            nodeLabel: node?.label ?? "Device unavailable",
            providerLabel: provider?.snapshot.displayName ?? thread.modelSelection.instanceId,
            status: node?.reachability === "online" ? "ready" : "offline",
          }
        );
      });
  }, [agents, catalog, threads, view]);
  return (
    <section
      className="jarvis-agent-section"
      aria-label={view === "active" ? "Running agents" : "Recent tasks"}
    >
      {rows.length === 0 ? (
        <div className="jarvis-agents-empty">
          <ActivityIcon className="size-5" aria-hidden="true" />
          <p>{view === "active" ? "No agents running" : "Your work starts here"}</p>
          <span>Choose a project and give Jarvis an instruction.</span>
        </div>
      ) : (
        <ul className="jarvis-agent-grid">
          {rows.map((agent) => (
            <li key={JSON.stringify(agent.taskRef)}>
              <button
                type="button"
                className="jarvis-agent-card"
                disabled={agent.status === "offline"}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: agent.taskRef.executionNodeId,
                      threadId: agent.taskRef.threadId,
                    },
                  })
                }
              >
                <span className="jarvis-agent-icon" data-state={agent.status} aria-hidden="true">
                  {agent.status === "ready" ? (
                    <MessageSquareIcon className="size-4" />
                  ) : (
                    <ActivityIcon className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="jarvis-agent-title">{agent.title}</span>
                  <span className="jarvis-agent-meta">
                    {agent.projectTitle} / {agent.providerLabel} / {agent.nodeLabel}
                  </span>
                </span>
                {agent.status !== "ready" && (
                  <span className="jarvis-agent-state">
                    {agent.status === "running"
                      ? "Working"
                      : agent.status === "waiting"
                        ? "Needs you"
                        : agent.status}
                  </span>
                )}
                <ChevronRightIcon className="size-3.5 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
