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

/** Resolve the caller's current server-authoritative workspace context.
 * The custom claim is only a locator; active membership and workspace lifecycle are re-read.
 */
export const getWorkspaceContext = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  if (!auth) throw new HttpsError('unauthenticated', 'ورود به حساب کاربری الزامی است.');
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  const manifest = await db.collection('workspaceMigrations').doc(workspaceId).get();
  const status = manifest.exists ? String(manifest.get('status') || 'not_started') : 'not_started';
  return {
    workspaceId,
    role,
    migrationStatus: status,
    stagedReadsEnabled: status === 'verified' && manifest.get('readBarrier.status') === 'frozen',
    coreWritesFrozen: manifest.exists && manifest.get('coreWritesFrozen') === true,
    coreWriteMode: String(manifest.get('coreWriteMode') || 'legacy'),
  };
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
  warehouse_keeper: ['products'],
  sales_officer: ['products', 'invoices'],
  treasurer: ['counters', 'accounts', 'parties', 'vouchers', 'cheques', 'currencies', 'exchangeRates'],
  auditor_readonly: ['counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques', 'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs', 'auditLogs'],
};

const CORE_WRITE_FIELDS: Record<string, { required: string[]; allowed: string[] }> = {
  accounts: {
    required: ['ownerId', 'code', 'title', 'level', 'category', 'nature', 'isSystem', 'createdAt', 'updatedAt'],
    allowed: ['ownerId', 'code', 'title', 'level', 'parentCode', 'category', 'nature', 'isSystem', 'active', 'requiresParty', 'createdAt', 'updatedAt'],
  },
  products: {
    required: ['ownerId', 'sku', 'name', 'category', 'warehouse', 'unit', 'buyPrice', 'sellPrice', 'stock', 'reorderPoint', 'vatExempt', 'createdAt', 'updatedAt'],
    allowed: ['ownerId', 'sku', 'name', 'category', 'warehouse', 'unit', 'secondaryUnit', 'kgPerCarton', 'bobbinUnit', 'bobbinsPerCarton', 'yarnCount', 'lotNumber', 'originCountry', 'buyPrice', 'sellPrice', 'stock', 'reorderPoint', 'vatExempt', 'costingMethod', 'costLayers', 'inventoryValueIrr', '_version', 'updatedByDevice', 'createdAt', 'updatedAt'],
  },
  vouchers: {
    required: ['ownerId', 'voucherNumber', 'date', 'description', 'voucherType', 'status', 'totalDebit', 'totalCredit', 'lines', 'createdAt', 'updatedAt'],
    allowed: ['ownerId', 'voucherNumber', 'date', 'description', 'voucherType', 'status', 'totalDebit', 'totalCredit', 'currencyCode', 'exchangeRate', 'foreignTotalDebit', 'foreignTotalCredit', 'referenceId', 'reversalOfVoucherId', 'fiscalYear', 'integrityHash', 'lines', '_version', 'updatedByDevice', 'createdAt', 'updatedAt'],
  },
  invoices: {
    required: ['ownerId', 'invoiceNumber', 'invoiceType', 'date', 'partyId', 'partyName', 'warehouse', 'subtotal', 'discount', 'vatAmount', 'grandTotal', 'paidCash', 'paidBank', 'paidCheque', 'creditAmount', 'status', 'items', 'createdAt', 'updatedAt'],
    allowed: ['ownerId', 'invoiceNumber', 'taxSerial', 'invoiceType', 'date', 'partyId', 'partyName', 'intermediaryId', 'intermediaryName', 'warehouse', 'costCenterId', 'currencyCode', 'exchangeRate', 'foreignSubtotal', 'foreignDiscount', 'foreignVatAmount', 'foreignGrandTotal', 'subtotal', 'discount', 'vatAmount', 'grandTotal', 'paidCash', 'paidBank', 'paidCheque', 'creditAmount', 'status', 'voucherId', 'items', '_version', 'updatedByDevice', 'createdAt', 'updatedAt'],
  },
};

function validateCoreWorkspacePayload(collectionName: string, value: unknown, workspaceId: string) {
  const schema = CORE_WRITE_FIELDS[collectionName];
  if (!schema || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'این مجموعه هنوز در درگاه نوشتن workspace پشتیبانی نمی‌شود.');
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (data.ownerId !== workspaceId || schema.required.some((key) => !(key in data))
      || keys.some((key) => !schema.allowed.includes(key))) {
    throw new HttpsError('invalid-argument', 'ساختار رکورد با قرارداد داده مجموعه سازگار نیست.');
  }
  if (collectionName === 'accounts') {
    if (typeof data.code !== 'string' || !/^\\d+$/.test(data.code)
        || typeof data.title !== 'string' || !['group', 'kol', 'moein', 'tafsili'].includes(String(data.level))
        || !['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'memo'].includes(String(data.category))
        || !['debit', 'credit', 'both'].includes(String(data.nature)) || typeof data.isSystem !== 'boolean'
        || (data.active !== undefined && typeof data.active !== 'boolean')
        || (data.requiresParty !== undefined && typeof data.requiresParty !== 'boolean')) {
      throw new HttpsError('invalid-argument', 'ساختار حساب معتبر نیست.');
    }
  } else if (collectionName === 'products') {
    if (typeof data.sku !== 'string' || typeof data.name !== 'string'
        || typeof data.stock !== 'number' || !Number.isFinite(data.stock)
        || typeof data.buyPrice !== 'number' || data.buyPrice < 0
        || typeof data.sellPrice !== 'number' || data.sellPrice < 0
        || typeof data.reorderPoint !== 'number' || data.reorderPoint < 0
        || typeof data.vatExempt !== 'boolean'
        || (data.costingMethod !== undefined && !['fifo', 'moving_average', 'periodic_average'].includes(String(data.costingMethod)))
        || (data.costLayers !== undefined && (!Array.isArray(data.costLayers) || data.costLayers.length > 200))) {
      throw new HttpsError('invalid-argument', 'ساختار کالا یا لایه‌های بهای تمام‌شده معتبر نیست.');
    }
  } else if (collectionName === 'vouchers') {
    if (typeof data.voucherNumber !== 'number' || data.voucherNumber < 1
        || typeof data.totalDebit !== 'number' || data.totalDebit !== data.totalCredit
        || !Array.isArray(data.lines) || data.lines.length < 2 || data.lines.length > 100
        || !['draft', 'permanent'].includes(String(data.status))
        || (data.status === 'permanent' && (typeof data.integrityHash !== 'string' || !/^vseal_[0-9a-f]{16}$/.test(data.integrityHash)))) {
      throw new HttpsError('invalid-argument', 'ساختار سند حسابداری یا تراز آن معتبر نیست.');
    }
  } else if (collectionName === 'invoices') {
    const amounts = ['subtotal', 'discount', 'vatAmount', 'grandTotal', 'paidCash', 'paidBank', 'paidCheque', 'creditAmount'];
    if (amounts.some((key) => typeof data[key] !== 'number' || !Number.isFinite(data[key] as number) || (data[key] as number) < 0)
        || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100
        || !['issued', 'settled', 'cancelled'].includes(String(data.status))) {
      throw new HttpsError('invalid-argument', 'ساختار فاکتور یا مبالغ آن معتبر نیست.');
    }
  }
}

const WORKSPACE_WRITE_COLLECTIONS: Record<string, readonly string[]> = {
  owner: WORKSPACE_MIGRATION_COLLECTIONS,
  finance_manager: ['accounts', 'products', 'vouchers', 'invoices'],
  accountant: ['accounts', 'products', 'vouchers', 'invoices'],
  warehouse_keeper: ['products', 'importDossiers', 'salesOrders', 'subcontractJobs'],
  sales_officer: ['parties', 'products', 'invoices', 'salesOrders'],
  treasurer: ['accounts', 'vouchers'],
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
  if (manifest.get('coreWritesFrozen') === true && (collectionName === 'accounts' || collectionName === 'products')) {
    throw new HttpsError('failed-precondition', 'نوشتن حساب‌ها و کالاها در دوره توقف مهاجرت مسدود است.');
  }
  const rootRef = db.collection(collectionName).doc(documentId);
  const stagedRef = migrationDestination(workspaceId, collectionName).doc(documentId);
  const operationRef = db.collection('workspaceWriteOperations').doc(`${workspaceId}_${operationId}`);
  const rawData = request.data?.data;
  if (operation !== 'delete') {
    validateCoreWorkspacePayload(collectionName, rawData, workspaceId);
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
  if ((collectionName === 'accounts' || collectionName === 'products')
      && (manifest.get('coreWritesFrozen') !== true || manifest.get('readBarrier.status') !== 'frozen')) {
    throw new HttpsError('failed-precondition', 'خواندن حساب‌ها و کالاها تا توقف نوشتن‌های قدیمی و تطبیق نهایی مجاز نیست.');
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
    if (record.get('deleted') === true || record.get('payload') === undefined) continue;
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



/** Core read adapter for accounts/products. A verified snapshot is not sufficient:
 * reads stay closed until an explicit write-freeze barrier prevents post-verification drift.
 */
export const listWorkspaceCoreRecords = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  const collectionName = request.data?.collection;
  if (collectionName !== 'accounts' && collectionName !== 'products') {
    throw new HttpsError('invalid-argument', 'این آداپتور فقط حساب‌ها و کالاها را می‌خواند.');
  }
  if (!(STAGED_READ_COLLECTIONS[role] || []).includes(collectionName)) {
    throw new HttpsError('permission-denied', 'نقش شما به مشاهده این مجموعه دسترسی ندارد.');
  }
  const manifest = await db.collection('workspaceMigrations').doc(workspaceId).get();
  const barrier = manifest.get('readBarrier');
  if (!manifest.exists || manifest.get('status') !== 'verified'
      || !barrier || barrier.status !== 'frozen'
      || typeof barrier.generation !== 'string' || !barrier.generation
      || !barrier.frozenAt) {
    throw new HttpsError('failed-precondition', 'خواندن داده‌ها تا ثبت مانع همگام‌سازی و توقف نوشتن‌های قدیمی مجاز نیست.');
  }
  const requestedLimit = Number(request.data?.limit ?? 100);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    throw new HttpsError('invalid-argument', 'اندازه صفحه باید بین ۱ تا ۱۰۰ باشد.');
  }
  const cursor = request.data?.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_\\-]{1,128}$/.test(cursor))) {
    throw new HttpsError('invalid-argument', 'نشانگر صفحه‌بندی معتبر نیست.');
  }
  const records = migrationDestination(workspaceId, collectionName);
  let query = records.orderBy(FieldPath.documentId()).limit(requestedLimit);
  if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const items = snapshot.docs
    .filter((record) => record.get('deleted') !== true && record.get('payload') !== undefined)
    .map((record) => ({ id: record.id, payload: record.get('payload'), version: Number(record.get('version') || 1) }));
  const responseBytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
  if (responseBytes > 7 * 1024 * 1024) {
    throw new HttpsError('resource-exhausted', 'حجم صفحه از حد مجاز پاسخ بیشتر است.');
  }
  return {
    workspaceId, collection: collectionName, generation: barrier.generation, role, items,
    nextCursor: snapshot.size === requestedLimit ? snapshot.docs[snapshot.docs.length - 1].id : null,
  };
});

/** Owner-only transition after the exact frozen snapshot has been reconciled.
 * Legacy root writes remain closed; subsequent core mutations are workspace-native only.
 */
export const activateWorkspaceCoreWrites = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const ref = db.collection('workspaceMigrations').doc(workspaceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const barrier = snap.get('readBarrier');
    if (!snap.exists || snap.get('status') !== 'verified' || snap.get('coreWritesFrozen') !== true
        || !barrier || barrier.status !== 'frozen' || typeof barrier.generation !== 'string'
        || !barrier.frozenAt || !barrier.reconciledCounts?.accounts || !barrier.reconciledCounts?.products) {
      throw new HttpsError('failed-precondition', 'فعال‌سازی نوشتن workspace فقط پس از تطبیق کامل snapshot مجاز است.');
    }
    if (snap.get('coreWriteMode') === 'workspace_native') {
      return { status: 'already_active', workspaceId, generation: barrier.generation };
    }
    tx.update(ref, {
      coreWriteMode: 'workspace_native',
      coreWritesActivatedAt: FieldValue.serverTimestamp(),
      coreWritesActivatedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'active', workspaceId, generation: barrier.generation };
  });
});

/** Workspace-native CRUD. Never touches legacy root collections; versions and operation
 * ledger provide optimistic concurrency and retry idempotency. Deletes are tombstones.
 */
export const mutateWorkspaceCoreRecord = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  const collectionName = request.data?.collection;
  const documentId = request.data?.documentId;
  const operation = request.data?.operation;
  const operationId = request.data?.operationId;
  const expectedVersion = request.data?.expectedVersion;
  if ((collectionName !== 'accounts' && collectionName !== 'products')
      || !(WORKSPACE_WRITE_COLLECTIONS[role] || []).includes(collectionName)
      || typeof documentId !== 'string' || !/^[A-Za-z0-9_\\-]{1,128}$/.test(documentId)
      || !['create', 'update', 'delete'].includes(operation)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_\\-]{16,128}$/.test(operationId)
      || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new HttpsError('invalid-argument', 'پارامترهای تغییر رکورد workspace معتبر نیستند.');
  }
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const recordRef = migrationDestination(workspaceId, collectionName).doc(documentId);
  const operationRef = db.collection('workspaceWriteOperations').doc(`${workspaceId}_native_${operationId}`);
  const rawData = request.data?.data;
  if (operation !== 'delete') {
    validateCoreWorkspacePayload(collectionName, rawData, workspaceId);
    if (Buffer.byteLength(JSON.stringify(stableMigrationValue(rawData)), 'utf8') > 850_000) {
      throw new HttpsError('resource-exhausted', 'اندازه رکورد بیش از حد مجاز است.');
    }
  }
  const requestHash = createHash('sha256').update(JSON.stringify({
    collectionName, documentId, operation, expectedVersion,
    data: operation === 'delete' ? null : stableMigrationValue(rawData),
  })).digest('hex');
  return db.runTransaction(async (tx) => {
    const [manifest, operationSnap, record] = await Promise.all([
      tx.get(manifestRef), tx.get(operationRef), tx.get(recordRef),
    ]);
    if (!manifest.exists || manifest.get('status') !== 'verified'
        || manifest.get('coreWritesFrozen') !== true || manifest.get('coreWriteMode') !== 'workspace_native'
        || manifest.get('readBarrier.status') !== 'frozen') {
      throw new HttpsError('failed-precondition', 'نوشتن بومی workspace هنوز فعال نشده است.');
    }
    if (operationSnap.exists) {
      if (operationSnap.get('requestHash') !== requestHash) {
        throw new HttpsError('already-exists', 'شناسه عملیات برای محتوای متفاوت استفاده شده است.');
      }
      return { status: 'replayed', operationId, version: operationSnap.get('resultVersion') };
    }
    const currentVersion = record.exists ? Number(record.get('version') || 1) : 0;
    if (currentVersion !== expectedVersion) {
      throw new HttpsError('aborted', 'نسخه رکورد تغییر کرده است؛ داده را تازه‌سازی و دوباره اعمال کنید.', {
        expectedVersion, currentVersion,
      });
    }
    if (operation === 'create' && record.exists) {
      throw new HttpsError('already-exists', 'رکورد از قبل وجود دارد.');
    }
    if (operation !== 'create' && (!record.exists || record.get('deleted') === true)) {
      throw new HttpsError('not-found', 'رکورد فعال یافت نشد.');
    }
    const nextVersion = currentVersion + 1;
    const now = FieldValue.serverTimestamp();
    if (operation === 'delete') {
      tx.set(recordRef, {
        workspaceId, sourceCollection: collectionName, sourceId: documentId,
        schemaVersion: 1, version: nextVersion, deleted: true,
        deletedAt: now, updatedAt: now,
      });
    } else {
      const payload = rawData as Record<string, unknown>;
      tx.set(recordRef, {
        workspaceId, sourceCollection: collectionName, sourceId: documentId,
        sourceHash: workspaceMigrationHash(payload), schemaVersion: 1,
        version: nextVersion, deleted: false, payload,
        ...(record.exists && record.get('createdAt') ? { createdAt: record.get('createdAt') } : { createdAt: now }),
        updatedAt: now,
      });
    }
    tx.create(operationRef, {
      workspaceId, uid: auth.uid, collection: collectionName, documentId,
      operation, requestHash, resultVersion: nextVersion, createdAt: now,
    });
    return { status: 'committed', operationId, version: nextVersion };
  });
});

/** Atomically closes legacy client writes for accounts/products through Firestore Rules. */
export const freezeWorkspaceCoreWrites = onCall({ region: REGION }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const ref = db.collection('workspaceMigrations').doc(workspaceId);
  const generation = randomBytes(16).toString('hex');
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'verified') {
      throw new HttpsError('failed-precondition', 'ابتدا باید مهاجرت اولیه تأیید شده باشد.');
    }
    if (snap.get('coreWritesFrozen') === true) {
      return { status: 'already_frozen', generation: String(snap.get('readBarrier')?.generation || '') };
    }
    tx.update(ref, {
      coreWritesFrozen: true,
      readBarrier: { status: 'reconciling', generation, requestedAt: FieldValue.serverTimestamp() },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'frozen_pending_reconciliation', generation };
  });
  return { workspaceId, ...result };
});

/** Reconciles both complete core collections after Rules have blocked legacy writes. */
export const reconcileWorkspaceCoreSnapshot = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const workspaceId = await requireWorkspaceOwner(auth);
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const manifest = await manifestRef.get();
  const barrier = manifest.get('readBarrier');
  if (!manifest.exists || manifest.get('status') !== 'verified' || manifest.get('coreWritesFrozen') !== true
      || !barrier || barrier.status !== 'reconciling' || typeof barrier.generation !== 'string') {
    throw new HttpsError('failed-precondition', 'توقف نوشتن‌های قدیمی و وضعیت reconciliation معتبر نیست.');
  }
  const results: Record<string, { sourceCount: number; stagedCount: number }> = {};
  for (const collectionName of ['accounts', 'products'] as const) {
    const source = db.collection(collectionName).where('ownerId', '==', workspaceId).orderBy(FieldPath.documentId());
    const staged = migrationDestination(workspaceId, collectionName).orderBy(FieldPath.documentId());
    const sourceCountSnap = await source.count().get();
    const stagedCountSnap = await staged.count().get();
    const sourceCount = sourceCountSnap.data().count;
    const stagedCount = stagedCountSnap.data().count;
    if (sourceCount !== stagedCount) {
      throw new HttpsError('data-loss', `تعداد رکوردهای مبدأ و مقصد در ${collectionName} برابر نیست؛ read barrier بسته می‌ماند.`);
    }
    let cursor: string | undefined;
    let checked = 0;
    for (let pageIndex = 0; pageIndex < 101; pageIndex += 1) {
      let query = source.limit(MIGRATION_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      const refs = page.docs.map((doc) => staged.doc(doc.id));
      const targets = await db.getAll(...refs);
      for (let i = 0; i < page.docs.length; i += 1) {
        const payload = page.docs[i].data() as Record<string, unknown>;
        if (!targets[i].exists || targets[i].get('workspaceId') !== workspaceId
            || targets[i].get('sourceHash') !== workspaceMigrationHash(payload)) {
          throw new HttpsError('data-loss', `مغایرت داده در ${collectionName}/${page.docs[i].id}؛ read barrier بسته می‌ماند.`);
        }
      }
      checked += page.size;
      cursor = page.docs[page.docs.length - 1].id;
      if (page.size < MIGRATION_PAGE_SIZE) break;
      if (pageIndex === 100) throw new HttpsError('resource-exhausted', 'تعداد رکوردها از سقف reconciliation تک‌درخواستی بیشتر است.');
    }
    if (checked !== sourceCount) throw new HttpsError('data-loss', `تعداد رکوردهای بررسی‌شده در ${collectionName} با شمارش کل برابر نیست.`);
    results[collectionName] = { sourceCount, stagedCount };
  }
  await manifestRef.update({
    readBarrier: { status: 'frozen', generation: barrier.generation, frozenAt: FieldValue.serverTimestamp(), reconciledCounts: results },
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 'frozen', workspaceId, generation: barrier.generation, collections: results };
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
