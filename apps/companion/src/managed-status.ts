export const managedReadyPrefix = "JARVIS_MANAGED_READY";
export const managedPairedPrefix = "JARVIS_MANAGED_PAIRED";
export const managedErrorPrefix = "JARVIS_MANAGED_ERROR";

export function managedStatusLine(status: "READY" | "PAIRED" | "ERROR", code?: string): string {
  const prefix =
    status === "READY"
      ? managedReadyPrefix
      : status === "PAIRED"
        ? managedPairedPrefix
        : managedErrorPrefix;
  if (status !== "ERROR") return prefix;
  const safeCode = (code ?? "UNKNOWN").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64);
  return `${prefix} ${safeCode}`;
}
