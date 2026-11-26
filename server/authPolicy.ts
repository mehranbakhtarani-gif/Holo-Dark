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
