export interface SyncOperationIdentity {
  target: 'supabase' | 'firebase';
  workspaceId: string;
  deviceId: string;
  clientRevision: number;
  payloadHash: string;
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable; use a secure browser context.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable SHA-256 fingerprint that ignores the export-time timestamp. */
export async function fingerprintWorkspacePayload(rawJson: string): Promise<string> {
  const normalized = rawJson.replace(/"exportedAt"\\s*:\\s*"[^"]*"/, '"exportedAt":""');
  const digest = await sha256Hex(normalized);
  return `${normalized.length}_${digest}`;
}

/**
 * Produces the same id for the same logical sync attempt across reloads.
 * A changed payload or remote base revision receives a different id.
 */
export async function createSyncOperationId(identity: SyncOperationIdentity): Promise<string> {
  const canonical = JSON.stringify([
    identity.target,
    identity.workspaceId,
    identity.deviceId,
    Math.max(0, Math.floor(identity.clientRevision)),
    identity.payloadHash,
  ]);
  return `op_${await sha256Hex(canonical)}`;
}
