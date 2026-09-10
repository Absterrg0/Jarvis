import { randomUUID } from "./lib/utils";

let sessionReporterId: string | undefined;

/**
 * Reporter identity for this renderer session. Voice delivery and routed task
 * metadata share it so the mounted reporter hears its own submissions, but
 * independent tabs and reloads receive distinct identities so one surface
 * never speaks another renderer's live presentations.
 */
export function jarvisReporterIdentity(): string {
  if (sessionReporterId === undefined) sessionReporterId = randomUUID();
  return sessionReporterId;
}
