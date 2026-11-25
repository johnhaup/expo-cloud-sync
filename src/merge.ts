import type { SyncRecord } from "./types";

export type Row = Record<string, unknown>;

/** A row as a record payload: JSON with its keys sorted, so two devices holding the same row write the same string. */
export function payloadOf(row: Row): string {
  const sorted: Row = {};
  for (const column of Object.keys(row).sort()) sorted[column] = row[column];
  return JSON.stringify(sorted);
}

/**
 * Whether a remote record replaces the local row. The whole record wins, never single fields.
 * - No local row: apply.
 * - The newer stamp wins. "keep" means the local row must be pushed (the caller keeps it dirty).
 * - Equal stamps: equal payloads are the same; otherwise the greater payload string wins, so both sides pick the same one.
 * - `fresh` (a new install before its first download finished): the remote record always wins. Otherwise a
 *   setting changed in the first seconds after a reinstall would push the install's defaults over the cloud copy.
 */
export function decide(
  local: { updatedAt: number; payload: string } | undefined,
  remote: Pick<SyncRecord, "updatedAt" | "payload">,
  fresh = false,
): "apply" | "keep" | "same" {
  if (!local) return "apply";
  if (fresh) return remote.payload === local.payload && remote.updatedAt === local.updatedAt ? "same" : "apply";
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt ? "apply" : "keep";
  if (remote.payload === local.payload) return "same";
  return remote.payload > local.payload ? "apply" : "keep";
}
