import type { EnvironmentId, JarvisTaskRef, ProjectId, ThreadId } from "@t3tools/contracts";

const JARVIS_OPEN_EVENT = "t3code:open-jarvis";
const JARVIS_ATTENTION_EVENT = "t3code:jarvis-attention";
const JARVIS_ATTENTION_KEY = "t3code:jarvis:attention-target:v1";

export interface JarvisAttentionTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly taskRef?: JarvisTaskRef;
}

export interface JarvisCommandTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId;
  readonly contextThreadTitle?: string;
  readonly taskRef?: JarvisTaskRef;
}

export function openJarvis(): void {
  window.dispatchEvent(new Event(JARVIS_OPEN_EVENT));
}

export function onOpenJarvis(listener: () => void): () => void {
  window.addEventListener(JARVIS_OPEN_EVENT, listener);
  return () => window.removeEventListener(JARVIS_OPEN_EVENT, listener);
}

export function publishJarvisAttentionTarget(target: JarvisAttentionTarget): void {
  localStorage.setItem(JARVIS_ATTENTION_KEY, JSON.stringify(target));
  window.dispatchEvent(new CustomEvent(JARVIS_ATTENTION_EVENT, { detail: target }));
}

export function readJarvisAttentionTarget(): JarvisAttentionTarget | null {
  try {
    const target = JSON.parse(localStorage.getItem(JARVIS_ATTENTION_KEY) ?? "null") as unknown;
    if (typeof target !== "object" || target === null) return null;
    const value = target as Record<string, unknown>;
    return typeof value.environmentId === "string" &&
      typeof value.projectId === "string" &&
      typeof value.threadId === "string" &&
      typeof value.threadTitle === "string"
      ? (target as JarvisAttentionTarget)
      : null;
  } catch {
    return null;
  }
}

export function clearJarvisAttentionTarget(): void {
  localStorage.removeItem(JARVIS_ATTENTION_KEY);
}

export function onJarvisAttentionTarget(
  listener: (target: JarvisAttentionTarget) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<JarvisAttentionTarget>).detail);
  };
  window.addEventListener(JARVIS_ATTENTION_EVENT, handler);
  return () => window.removeEventListener(JARVIS_ATTENTION_EVENT, handler);
}
