import { createHash, randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

const app = initializeApp();
const db = getFirestore(app, 'ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b');
const REGION = 'us-central1';
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MEMBER_ROLES = [
  'finance_manager',
  'accountant',
  'warehouse_keeper',
  'sales_officer',
  'treasurer',
  'auditor_readonly',
] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];

interface CallableAuth {
  uid: string;
  token: Record<string, unknown> & {
    email?: string;
    email_verified?: boolean;
    workspaceId?: string;
  };
}

function requireVerifiedAuth(auth: CallableAuth | undefined): asserts auth is CallableAuth {
  if (!auth) throw new HttpsError('unauthenticated', 'ورود به حساب کاربری الزامی است.');
  if (auth.token.email_verified !== true || !auth.token.email) {
    throw new HttpsError('permission-denied', 'حساب کاربری باید ایمیل تأییدشده داشته باشد.');
  }
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'ایمیل معتبر نیست.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'ایمیل معتبر نیست.');
  }
  return email;
}

function parseRole(value: unknown): MemberRole {
  if (typeof value !== 'string' || !MEMBER_ROLES.includes(value as MemberRole)) {
    throw new HttpsError('invalid-argument', 'نقش اپراتور معتبر نیست.');
  }
  return value as MemberRole;
}

function invitationHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function getActiveMembership(uid: string, workspaceId: string) {
  const ref = db.collection('workspaceMemberships').doc(`${workspaceId}_${uid}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get('active') !== true || snap.get('workspaceId') !== workspaceId || snap.get('uid') !== uid) {
    throw new HttpsError('permission-denied', 'عضویت فعال در این فضای کاری یافت نشد.');
  }
  return { ref, data: snap.data()! };
}

async function requireWorkspaceOwner(auth: CallableAuth) {
  const workspaceId = auth.token.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw new HttpsError('failed-precondition', 'ابتدا فضای کاری را از طریق فرایند راه‌اندازی ایجاد کنید.');
  }
  const membership = await getActiveMembership(auth.uid, workspaceId);
  if (membership.data.role !== 'owner') {
    throw new HttpsError('permission-denied', 'فقط مالک فضای کاری مجاز به مدیریت اعضاست.');
  }
  const workspace = await db.collection('workspaces').doc(workspaceId).get();
  if (!workspace.exists || workspace.get('ownerUid') !== auth.uid || workspace.get('status') !== 'active') {
    throw new HttpsError('permission-denied', 'مالکیت فضای کاری تأیید نشد.');
  }
  return workspaceId;
}

async function setWorkspaceClaims(uid: string, workspaceId: string, role: string, active: boolean) {
  const user = await getAuth(app).getUser(uid);
  const claims = { ...(user.customClaims ?? {}) };
  if (active) {
    claims.workspaceId = workspaceId;
    claims.workspaceRole = role;
    claims.workspaceMember = true;
  } else if (claims.workspaceId === workspaceId) {
    delete claims.workspaceId;
    delete claims.workspaceRole;
    delete claims.workspaceMember;
  }
  await getAuth(app).setCustomUserClaims(uid, claims);
}

/**
 * One-time owner bootstrap. Workspace ID intentionally equals the existing Firebase UID,
 * preserving current ownerId-based data ownership during the first migration stage.
 */
export const bootstrapWorkspace = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const uid = auth.uid;
  const existingClaim = auth.token.workspaceId;
  if (existingClaim && existingClaim !== uid) {
    throw new HttpsError('already-exists', 'این حساب قبلاً به فضای کاری دیگری متصل شده است.');
  }

  const workspaceRef = db.collection('workspaces').doc(uid);
  const membershipRef = db.collection('workspaceMemberships').doc(`${uid}_${uid}`);
  await db.runTransaction(async (tx) => {
    const workspaceSnap = await tx.get(workspaceRef);
    const membershipSnap = await tx.get(membershipRef);
    if (workspaceSnap.exists && workspaceSnap.get('ownerUid') !== uid) {
      throw new HttpsError('permission-denied', 'شناسه فضای کاری در اختیار این حساب نیست.');
    }
    if (membershipSnap.exists && membershipSnap.get('uid') !== uid) {
      throw new HttpsError('permission-denied', 'عضویت مالک با داده موجود تطبیق ندارد.');
    }
    const now = FieldValue.serverTimestamp();
    if (!workspaceSnap.exists) {
      tx.create(workspaceRef, {
        ownerUid: uid,
        status: 'active',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (!membershipSnap.exists) {
      tx.create(membershipRef, {
        workspaceId: uid,
        uid,
        email: normalizeEmail(auth.token.email),
        role: 'owner',
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    } else if (membershipSnap.get('active') !== true || membershipSnap.get('role') !== 'owner') {
      throw new HttpsError('permission-denied', 'عضویت مالک غیرفعال یا نامعتبر است.');
    }
  });

  await setWorkspaceClaims(uid, uid, 'owner', true);
  return { workspaceId: uid, role: 'owner', claimsUpdated: true };
});

/** Creates a short-lived, email-bound invitation. The raw token is returned only once. */
export const createWorkspaceInvitation = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const email = normalizeEmail(request.data?.email);
  if (email === normalizeEmail(auth.token.email)) {
    throw new HttpsError('invalid-argument', 'مالک نمی‌تواند برای ایمیل خودش دعوت‌نامه بسازد.');
  }
  const role = parseRole(request.data?.role);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = invitationHash(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const invitationRef = db.collection('workspaceInvitations').doc(tokenHash);

  await invitationRef.create({
    workspaceId,
    email,
    role,
    status: 'pending',
    tokenHash,
    createdBy: auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  return { invitationToken: token, email, role, expiresAt: expiresAt.toISOString() };
});

/** Accepts an invitation only when the signed-in, verified email matches its recipient. */
export const acceptWorkspaceInvitation = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const token = request.data?.invitationToken;
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
    throw new HttpsError('invalid-argument', 'توکن دعوت‌نامه معتبر نیست.');
  }
  const invitationRef = db.collection('workspaceInvitations').doc(invitationHash(token));
  const invitationSnap = await invitationRef.get();
  if (!invitationSnap.exists) throw new HttpsError('not-found', 'دعوت‌نامه یافت نشد.');
  const invitation = invitationSnap.data()!;
  if (invitation.email !== normalizeEmail(auth.token.email)) {
    throw new HttpsError('permission-denied', 'ایمیل حساب با گیرنده دعوت‌نامه مطابقت ندارد.');
  }
  const expiresAtMs =
    typeof invitation.expiresAt?.toMillis === 'function'
      ? invitation.expiresAt.toMillis()
      : invitation.expiresAt instanceof Date
        ? invitation.expiresAt.getTime()
        : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new HttpsError('deadline-exceeded', 'مهلت دعوت‌نامه به پایان رسیده است.');
  }
  if (invitation.status !== 'pending' && invitation.acceptedBy !== auth.uid) {
    throw new HttpsError('failed-precondition', 'این دعوت‌نامه قبلاً مصرف یا لغو شده است.');
  }

  const workspaceId = String(invitation.workspaceId);
  const workspaceRef = db.collection('workspaces').doc(workspaceId);
  const membershipRef = db.collection('workspaceMemberships').doc(`${workspaceId}_${auth.uid}`);
  await db.runTransaction(async (tx) => {
    const [workspaceSnap, memberSnap, currentInvite] = await Promise.all([
      tx.get(workspaceRef), tx.get(membershipRef), tx.get(invitationRef),
    ]);
    if (!workspaceSnap.exists || workspaceSnap.get('status') !== 'active') {
      throw new HttpsError('failed-precondition', 'فضای کاری فعال نیست.');
    }
    if (!currentInvite.exists) throw new HttpsError('not-found', 'دعوت‌نامه یافت نشد.');
    if (currentInvite.get('status') === 'pending') {
      if (memberSnap.exists && memberSnap.get('active') === true) {
        throw new HttpsError('already-exists', 'این حساب از قبل عضو فضای کاری است.');
      }
      tx.set(membershipRef, {
        workspaceId,
        uid: auth.uid,
        email: normalizeEmail(auth.token.email),
        role: invitation.role,
        active: true,
        invitedBy: invitation.createdBy,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(invitationRef, {
        status: 'accepted',
        acceptedBy: auth.uid,
        acceptedAt: FieldValue.serverTimestamp(),
      });
    } else if (currentInvite.get('acceptedBy') !== auth.uid || !memberSnap.exists || memberSnap.get('active') !== true) {
      throw new HttpsError('failed-precondition', 'دعوت‌نامه قابل استفاده مجدد نیست.');
    }
  });

  await setWorkspaceClaims(auth.uid, workspaceId, String(invitation.role), true);
  return { workspaceId, role: invitation.role, claimsUpdated: true };
});

/** Changes a member role through the trusted Admin SDK, never through client-writable profile data. */
export const setWorkspaceMemberRole = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || uid === auth.uid || uid.length > 128) {
    throw new HttpsError('invalid-argument', 'شناسه عضو معتبر نیست.');
  }
  const role = parseRole(request.data?.role);
  const memberRef = db.collection('workspaceMemberships').doc(`${workspaceId}_${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(memberRef);
    if (!snap.exists || snap.get('active') !== true || snap.get('role') === 'owner') {
      throw new HttpsError('failed-precondition', 'عضو فعال قابل تغییر یافت نشد.');
    }
    tx.update(memberRef, { role, updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid });
  });
  await setWorkspaceClaims(uid, workspaceId, role, true);
  return { uid, role, updated: true };
});

/** Revocation marks membership inactive; future rules must consult this record, not trust stale claims. */
export const revokeWorkspaceMember = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || uid === auth.uid || uid.length > 128) {
    throw new HttpsError('invalid-argument', 'شناسه عضو معتبر نیست.');
  }
  const memberRef = db.collection('workspaceMemberships').doc(`${workspaceId}_${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(memberRef);
    if (!snap.exists || snap.get('active') !== true || snap.get('role') === 'owner') {
      throw new HttpsError('failed-precondition', 'عضو فعال قابل لغو یافت نشد.');
    }
    tx.update(memberRef, {
      active: false,
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await setWorkspaceClaims(uid, workspaceId, '', false);
  return { uid, revoked: true };
});
