export interface VerifiedFirebaseIdentity {
  uid: string;
  email: string;
}

/**
 * Extracts a Firebase Identity Toolkit account only when the provider confirms
 * that the email address has been verified. The caller must still verify the
 * ID token with Identity Toolkit before passing this response here.
 */
export function resolveVerifiedFirebaseIdentity(payload: unknown): VerifiedFirebaseIdentity | null {
  if (!payload || typeof payload !== 'object') return null;
  const users = (payload as { users?: unknown }).users;
  if (!Array.isArray(users) || users.length === 0) return null;

  const user = users[0] as {
    localId?: unknown;
    email?: unknown;
    emailVerified?: unknown;
  } | null;
  if (
    !user ||
    typeof user.localId !== 'string' ||
    user.localId.length === 0 ||
    typeof user.email !== 'string' ||
    user.email.length === 0 ||
    user.emailVerified !== true
  ) {
    return null;
  }

  return { uid: user.localId, email: user.email };
}

/**
 * A server revision ahead of the client's base is a conflict even when both
 * tabs share the same persisted browser device ID.
 */
export function hasSupabaseRevisionConflict(serverRevision: number, clientRevision: number): boolean {
  return Number.isFinite(serverRevision) && Number.isFinite(clientRevision) && serverRevision > clientRevision;
}

const MAX_RECENT_SYNC_OPERATION_IDS = 256;

function readSyncMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Checks the bounded durable replay window, retaining compatibility with old snapshots. */
export function hasProcessedSyncOperation(syncMeta: unknown, operationId: string): boolean {
  if (!operationId) return false;
  const meta = readSyncMeta(syncMeta);
  if (meta.lastOperationId === operationId) return true;
  return Array.isArray(meta.recentOperationIds)
    && meta.recentOperationIds.some((id) => id === operationId);
}

/** Adds an operation to the persisted replay window without trusting client-supplied history. */
export function appendProcessedSyncOperation(
  previousSyncMeta: unknown,
  operationId: string,
): Record<string, unknown> {
  const previous = readSyncMeta(previousSyncMeta);
  const existingIds = Array.isArray(previous.recentOperationIds)
    ? previous.recentOperationIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128,
      )
    : [];
  const recentOperationIds = [...new Set([...existingIds, operationId])].slice(-MAX_RECENT_SYNC_OPERATION_IDS);
  return {
    ...previous,
    lastOperationId: operationId,
    recentOperationIds,
  };
}
