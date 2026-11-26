import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, Firestore } from '@google-cloud/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

const app = initializeApp();
const db = new Firestore({
  projectId: 'elaborate-hash-368613',
  databaseId: 'ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b',
});
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
  const activeMembershipsQuery = db.collection('workspaceMemberships')
    .where('uid', '==', uid);
  await db.runTransaction(async (tx) => {
    const [workspaceSnap, membershipSnap, activeMemberships] = await Promise.all([
      tx.get(workspaceRef),
      tx.get(membershipRef),
      tx.get(activeMembershipsQuery),
    ]);
    if (activeMemberships.docs.some((member) => member.get('active') === true && member.get('workspaceId') !== uid)) {
      throw new HttpsError('already-exists', 'این حساب عضو فضای کاری دیگری است و نمی‌تواند فضای کاری مستقل بسازد.');
    }
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

async function requireActiveWorkspaceMember(auth: CallableAuth) {
  const workspaceId = auth.token.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw new HttpsError('permission-denied', 'شناسه فضای کاری معتبر نیست.');
  }
  const membership = await getActiveMembership(auth.uid, workspaceId);
  const workspace = await db.collection('workspaces').doc(workspaceId).get();
  if (!workspace.exists || workspace.get('status') !== 'active') {
    throw new HttpsError('permission-denied', 'فضای کاری فعال نیست.');
  }
  return { workspaceId, role: String(membership.data.role) as MemberRole | 'owner' };
}

const STAGED_READ_COLLECTIONS: Record<string, readonly string[]> = {
  owner: ['counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators', 'auditLogs', 'workspaceExtensions', 'devicePresence', 'cloudBackups'],
  finance_manager: ['counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs', 'auditLogs'],
  accountant: ['counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'auditLogs'],
  warehouse_keeper: ['products', 'importDossiers', 'salesOrders', 'subcontractJobs'],
  sales_officer: ['parties', 'products', 'invoices', 'salesOrders'],
  treasurer: ['counters', 'accounts', 'parties', 'vouchers', 'cheques', 'currencies', 'exchangeRates'],
  auditor_readonly: ['counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs', 'auditLogs'],
};

const WORKSPACE_WRITE_COLLECTIONS: Record<string, readonly string[]> = {
  owner: WORKSPACE_MIGRATION_COLLECTIONS,
  finance_manager: ['accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs'],
  accountant: ['accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates'],
  warehouse_keeper: ['products', 'importDossiers', 'salesOrders', 'subcontractJobs'],
  sales_officer: ['parties', 'products', 'invoices', 'salesOrders'],
  treasurer: ['accounts', 'parties', 'vouchers', 'cheques', 'currencies', 'exchangeRates'],
  auditor_readonly: [],
};

/**
 * Atomic legacy-root + workspace-staging mutation in the same Firestore database.
 * The operation ledger makes retries idempotent. This endpoint is a migration
 * bridge; the React accounting context must be explicitly routed to it before
 * it can be considered the application's active dual-write path.
 */
export const writeWorkspaceRecord = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  const collectionName = request.data?.collection;
  const documentId = request.data?.documentId;
  const operation = request.data?.operation;
  const operationId = request.data?.operationId;
  const allowed = WORKSPACE_WRITE_COLLECTIONS[role] || [];
  if (typeof collectionName !== 'string' || !allowed.includes(collectionName)
      || typeof documentId !== 'string' || !/^[A-Za-z0-9_\-]{1,128}$/.test(documentId)
      || !['create', 'update', 'delete'].includes(operation)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_\-]{16,128}$/.test(operationId)) {
    throw new HttpsError('invalid-argument', 'پارامترهای عملیات همگام‌سازی معتبر نیستند.');
  }
  const manifest = await db.collection('workspaceMigrations').doc(workspaceId).get();
  if (!manifest.exists || manifest.get('status') !== 'verified') {
    throw new HttpsError('failed-precondition', 'پیش از فعال‌سازی همگام‌سازی، مهاجرت باید تأیید شود.');
  }
  const rootRef = db.collection(collectionName).doc(documentId);
  const stagedRef = migrationDestination(workspaceId, collectionName).doc(documentId);
  const operationRef = db.collection('workspaceWriteOperations').doc(`${workspaceId}_${operationId}`);
  const rawData = request.data?.data;
  if (operation !== 'delete') {
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)
        || (rawData as Record<string, unknown>).ownerId !== workspaceId) {
      throw new HttpsError('invalid-argument', 'داده باید متعلق به همین فضای کاری باشد.');
    }
    const encoded = JSON.stringify(stableMigrationValue(rawData));
    if (Buffer.byteLength(encoded, 'utf8') > 850_000) {
      throw new HttpsError('resource-exhausted', 'اندازه رکورد برای همگام‌سازی بیش از حد مجاز است.');
    }
  }
  const requestHash = createHash('sha256').update(JSON.stringify({
    collectionName, documentId, operation, data: operation === 'delete' ? null : stableMigrationValue(rawData),
  })).digest('hex');
  return db.runTransaction(async (tx) => {
    const [operationSnap, rootSnap, stagedSnap] = await Promise.all([
      tx.get(operationRef), tx.get(rootRef), tx.get(stagedRef),
    ]);
    if (operationSnap.exists) {
      if (operationSnap.get('requestHash') !== requestHash) {
        throw new HttpsError('already-exists', 'شناسه عملیات قبلاً برای محتوای متفاوت استفاده شده است.');
      }
      return { status: 'replayed', operationId };
    }
    if (operation === 'create' && (rootSnap.exists || stagedSnap.exists)) {
      throw new HttpsError('already-exists', 'رکورد از قبل وجود دارد؛ ایجاد تکراری مجاز نیست.');
    }
    if (operation !== 'create' && (!rootSnap.exists || !stagedSnap.exists)) {
      throw new HttpsError('failed-precondition', 'رکورد legacy و نسخه workspace باید هر دو موجود باشند.');
    }
    if (rootSnap.exists && rootSnap.get('ownerId') !== workspaceId) {
      throw new HttpsError('permission-denied', 'رکورد متعلق به این فضای کاری نیست.');
    }
    if (stagedSnap.exists && stagedSnap.get('workspaceId') !== workspaceId) {
      throw new HttpsError('permission-denied', 'رکورد staging متعلق به این فضای کاری نیست.');
    }
    if (operation === 'delete') {
      tx.delete(rootRef);
      tx.delete(stagedRef);
    } else {
      const payload = rawData as Record<string, unknown>;
      const now = FieldValue.serverTimestamp();
      tx.set(rootRef, payload);
      tx.set(stagedRef, {
        workspaceId, sourceCollection: collectionName, sourceId: documentId,
        sourceHash: workspaceMigrationHash(payload), schemaVersion: 1,
        payload, copiedAt: now, updatedAt: now,
      });
    }
    tx.create(operationRef, {
      workspaceId, uid: auth.uid, collection: collectionName, documentId,
      operation, requestHash, createdAt: FieldValue.serverTimestamp(),
    });
    return { status: 'committed', operationId };
  });
});

/**
 * Read-only, role-scoped access to a fully verified staging snapshot.
 * Membership document and workspace status are checked on every request;
 * custom claims are used only to locate the workspace, never as authorization.
 */
export const listWorkspaceStagedRecords = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  const collectionName = request.data?.collection;
  if (typeof collectionName !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(collectionName)) {
    throw new HttpsError('invalid-argument', 'نام مجموعه معتبر نیست.');
  }
  const allowed = STAGED_READ_COLLECTIONS[role] || [];
  if (!allowed.includes(collectionName)) {
    throw new HttpsError('permission-denied', 'نقش شما به مشاهده این مجموعه دسترسی ندارد.');
  }
  const manifest = await db.collection('workspaceMigrations').doc(workspaceId).get();
  if (!manifest.exists || manifest.get('status') !== 'verified') {
    throw new HttpsError('failed-precondition', 'نسخه staging هنوز به‌طور کامل بررسی و تأیید نشده است.');
  }
  const requestedLimit = Number(request.data?.limit ?? 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    throw new HttpsError('invalid-argument', 'تعداد رکورد در هر صفحه باید بین ۱ تا ۱۰۰ باشد.');
  }
  const cursor = request.data?.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_\-]{1,128}$/.test(cursor))) {
    throw new HttpsError('invalid-argument', 'نشانگر صفحه‌بندی معتبر نیست.');
  }
  const records = migrationDestination(workspaceId, collectionName);
  let query = records.orderBy(FieldPath.documentId()).limit(requestedLimit);
  if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const items: Array<{ id: string; payload: unknown }> = [];
  let responseBytes = 0;
  for (const record of snapshot.docs) {
    const item = { id: record.id, payload: record.get('payload') };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (items.length > 0 && responseBytes + itemBytes > 7 * 1024 * 1024) break;
    items.push(item);
    responseBytes += itemBytes;
  }
  const hasMoreInPage = items.length < snapshot.size;
  return {
    workspaceId,
    collection: collectionName,
    role,
    items,
    nextCursor: items.length > 0 && (hasMoreInPage || snapshot.size === requestedLimit)
      ? items[items.length - 1].id
      : null,
  };
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
  const existingWorkspaceClaim = auth.token.workspaceId;
  if (existingWorkspaceClaim && existingWorkspaceClaim !== workspaceId) {
    throw new HttpsError('failed-precondition', 'این حساب از قبل به فضای کاری دیگری متصل است.');
  }
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

/** Lists workspace membership metadata for the authenticated owner only. */
export const listWorkspaceMembers = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const snapshot = await db.collection('workspaceMemberships')
    .where('workspaceId', '==', workspaceId)
    .get();
  const members = snapshot.docs.map((member) => {
    const data = member.data();
    return {
      uid: String(data.uid),
      email: String(data.email || ''),
      role: String(data.role),
      active: data.active === true,
      createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : null,
    };
  });
  members.sort((a, b) => a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.email.localeCompare(b.email));
  return { members };
});


const WORKSPACE_MIGRATION_COLLECTIONS = [
  'counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices',
  'cheques', 'employees', 'assets', 'costCenters', 'currencies',
  'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs',
  'rbacOperators', 'auditLogs', 'workspaceExtensions', 'devicePresence',
  'cloudBackups',
] as const;
const MIGRATION_PAGE_SIZE = 200;

function stableMigrationValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return { __date: value.toISOString() };
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return { __timestamp: (value as { toMillis: () => number }).toMillis() };
  }
  if (Buffer.isBuffer(value)) return { __bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(stableMigrationValue);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((out, key) => {
      out[key] = stableMigrationValue(record[key]);
      return out;
    }, {});
  }
  return String(value);
}

function workspaceMigrationHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(stableMigrationValue(value))).digest('hex');
}

function migrationDestination(workspaceId: string, collectionName: string) {
  return db.collection('workspaces').doc(workspaceId)
    .collection('migrationData').doc(collectionName).collection('records');
}

/**
 * Creates a reversible staging migration. Legacy source documents remain untouched.
 * This does not switch application reads/writes or grant member access.
 */
export const beginWorkspaceDataMigration = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const migrationRef = db.collection('workspaceMigrations').doc(workspaceId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(migrationRef);
    if (snap.exists) {
      const status = snap.get('status');
      if (status === 'copying' || status === 'verifying' || status === 'verified') {
        return { status, collectionIndex: Number(snap.get('collectionIndex') || 0), resumed: true };
      }
      throw new HttpsError('failed-precondition', 'وضعیت مهاجرت قبلی نامعتبر است؛ بازنشانی خودکار انجام نمی‌شود.');
    }
    tx.create(migrationRef, {
      workspaceId,
      ownerUid: auth.uid,
      schemaVersion: 1,
      status: 'copying',
      collectionIndex: 0,
      lastDocumentId: null,
      copiedCounts: {},
      verifyCollectionIndex: 0,
      verifyLastDocumentId: null,
      verifiedCounts: {},
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'copying', collectionIndex: 0, resumed: false };
  });
  return { workspaceId, ...result, collections: WORKSPACE_MIGRATION_COLLECTIONS.length, pageSize: MIGRATION_PAGE_SIZE };
});

/** Copies one bounded page into an isolated staging namespace, preserving the legacy source. */
export const migrateWorkspaceDataBatch = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const migrationRef = db.collection('workspaceMigrations').doc(workspaceId);
  return db.runTransaction(async (tx) => {
    const manifest = await tx.get(migrationRef);
    if (!manifest.exists || manifest.get('status') !== 'copying') {
      throw new HttpsError('failed-precondition', 'مهاجرت در وضعیت کپی فعال نیست.');
    }
    const index = Number(manifest.get('collectionIndex') || 0);
    if (index >= WORKSPACE_MIGRATION_COLLECTIONS.length) {
      tx.update(migrationRef, { status: 'verifying', verifyCollectionIndex: 0, verifyLastDocumentId: null, updatedAt: FieldValue.serverTimestamp() });
      return { status: 'verifying', copied: 0, collection: null };
    }
    const collectionName = WORKSPACE_MIGRATION_COLLECTIONS[index];
    let query = db.collection(collectionName).where('ownerId', '==', workspaceId)
      .orderBy(FieldPath.documentId()).limit(MIGRATION_PAGE_SIZE);
    const cursor = manifest.get('lastDocumentId');
    if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
    const page = await tx.get(query);
    if (page.empty) {
      const nextIndex = index + 1;
      tx.update(migrationRef, {
        collectionIndex: nextIndex,
        lastDocumentId: null,
        status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verifying' : 'copying',
        verifyCollectionIndex: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 0 : manifest.get('verifyCollectionIndex') || 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verifying' : 'copying', copied: 0, collection: collectionName };
    }
    const nextCounts = { ...(manifest.get('copiedCounts') || {}) } as Record<string, number>;
    for (const sourceDoc of page.docs) {
      const payload = sourceDoc.data() as Record<string, unknown>;
      const serialized = JSON.stringify(stableMigrationValue(payload));
      if (Buffer.byteLength(serialized, 'utf8') > 850_000) {
        throw new HttpsError('resource-exhausted', `سند ${collectionName}/${sourceDoc.id} برای بسته‌بندی امن مهاجرت بیش از حد بزرگ است.`);
      }
    }
    nextCounts[collectionName] = (nextCounts[collectionName] || 0) + page.size;
    const reachedEnd = page.size < MIGRATION_PAGE_SIZE;
    const nextIndex = reachedEnd ? index + 1 : index;
    // Staged writes and cursor advance commit atomically.
    for (const sourceDoc of page.docs) {
      const payload = sourceDoc.data() as Record<string, unknown>;
      tx.set(migrationDestination(workspaceId, collectionName).doc(sourceDoc.id), {
        workspaceId, sourceCollection: collectionName, sourceId: sourceDoc.id,
        sourceHash: workspaceMigrationHash(payload), schemaVersion: 1, payload,
        copiedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(migrationRef, {
      copiedCounts: nextCounts, collectionIndex: nextIndex,
      lastDocumentId: reachedEnd ? null : page.docs[page.docs.length - 1].id,
      status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verifying' : 'copying',
      verifyCollectionIndex: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 0 : manifest.get('verifyCollectionIndex') || 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verifying' : 'copying', copied: page.size, collection: collectionName };
  });
});

/** Compares staged SHA-256 payloads to the live legacy source in bounded pages. */
export const verifyWorkspaceDataMigration = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const migrationRef = db.collection('workspaceMigrations').doc(workspaceId);
  return db.runTransaction(async (tx) => {
    const manifest = await tx.get(migrationRef);
    if (!manifest.exists || manifest.get('status') !== 'verifying') {
      if (manifest.exists && manifest.get('status') === 'verified') return { status: 'verified', verified: 0, collection: null };
      throw new HttpsError('failed-precondition', 'مهاجرت در وضعیت بررسی نیست.');
    }
    const index = Number(manifest.get('verifyCollectionIndex') || 0);
    if (index >= WORKSPACE_MIGRATION_COLLECTIONS.length) {
      tx.update(migrationRef, { status: 'verified', verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return { status: 'verified', verified: 0, collection: null };
    }
    const collectionName = WORKSPACE_MIGRATION_COLLECTIONS[index];
    let query = db.collection(collectionName).where('ownerId', '==', workspaceId)
      .orderBy(FieldPath.documentId()).limit(MIGRATION_PAGE_SIZE);
    const cursor = manifest.get('verifyLastDocumentId');
    if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
    const page = await tx.get(query);
    const destination = migrationDestination(workspaceId, collectionName);
    const destinationRefs = page.docs.map((doc) => destination.doc(doc.id));
    const staged = destinationRefs.length ? await tx.getAll(...destinationRefs) : [];
    const verifiedCounts = { ...(manifest.get('verifiedCounts') || {}) } as Record<string, number>;
    for (let i = 0; i < page.docs.length; i += 1) {
      const sourceData = page.docs[i].data() as Record<string, unknown>;
      if (!staged[i].exists || staged[i].get('sourceHash') !== workspaceMigrationHash(sourceData)) {
        throw new HttpsError('data-loss', `تطبیق هش داده ناموفق است: ${collectionName}/${page.docs[i].id}. داده مبدأ تغییر کرده یا نسخه مقصد ناقص است.`);
      }
    }
    verifiedCounts[collectionName] = (verifiedCounts[collectionName] || 0) + page.size;
    const reachedEnd = page.size < MIGRATION_PAGE_SIZE;
    const copiedCounts = (manifest.get('copiedCounts') || {}) as Record<string, number>;
    if (reachedEnd && (copiedCounts[collectionName] || 0) !== verifiedCounts[collectionName]) {
      throw new HttpsError('data-loss', `تعداد رکوردهای ${collectionName} با نسخه staging برابر نیست.`);
    }
    const nextIndex = reachedEnd ? index + 1 : index;
    tx.update(migrationRef, {
      verifiedCounts,
      verifyCollectionIndex: nextIndex,
      verifyLastDocumentId: reachedEnd ? null : page.docs[page.docs.length - 1].id,
      status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verified' : 'verifying',
      ...(nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? { verifiedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: nextIndex >= WORKSPACE_MIGRATION_COLLECTIONS.length ? 'verified' : 'verifying', verified: page.size, collection: collectionName };
  });
});
