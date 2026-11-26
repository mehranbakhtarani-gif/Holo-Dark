import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, Firestore, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';

const app = initializeApp();
const db = new Firestore({
  projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'elaborate-hash-368613',
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

/**
 * Assigns a shared inventory event sequence to invoices that reached Firestore
 * without one (the normal offline writeBatch path cannot reserve a server counter).
 * Online transactions already carry a sequence and are intentionally left untouched.
 *
 * For offline invoices, the sequence represents server-side sequencing/acceptance
 * after synchronization, not the original wall-clock order on an offline device.
 */
export const sequenceOfflineInventoryInvoice = onDocumentCreated(
  { document: 'invoices/{invoiceId}', database: 'ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b', region: REGION, retry: true },
  async (event) => {
    const invoiceRef = event.data?.ref;
    if (!invoiceRef) return;
    const initialData = event.data?.data();
    const ownerId = typeof initialData?.ownerId === 'string' ? initialData.ownerId : '';
    if (!ownerId || initialData?.invoiceType === 'proforma'
        || Number.isSafeInteger(initialData?.eventSequence)) return;

    const counterRef = db.collection('counters').doc(ownerId);
    await db.runTransaction(async (tx) => {
      const [invoiceSnap, counterSnap] = await Promise.all([
        tx.get(invoiceRef),
        tx.get(counterRef),
      ]);
      if (!invoiceSnap.exists) return;
      const invoice = invoiceSnap.data() || {};
      if (invoice.ownerId !== ownerId || invoice.invoiceType === 'proforma'
          || Number.isSafeInteger(invoice.eventSequence)) return;

      const nextSequence = Math.max(
        0,
        Number(counterSnap.data()?.lastInventorySequence) || 0,
      ) + 1;
      const now = FieldValue.serverTimestamp();
      tx.update(invoiceRef, {
        eventSequence: nextSequence,
        eventSequenceSource: 'sync',
        updatedAt: now,
      });
      tx.set(counterRef, {
        ownerId,
        lastVoucherNumber: Math.max(0, Number(counterSnap.data()?.lastVoucherNumber) || 0),
        lastInvoiceSeq: Math.max(0, Number(counterSnap.data()?.lastInvoiceSeq) || 102),
        lastInventorySequence: nextSequence,
        updatedAt: now,
        ...(!counterSnap.exists ? { createdAt: now } : {}),
      }, { merge: true });
    });
  },
);

/**
 * Assigns server acceptance order to warehouse transfer events first synchronized
 * from an offline device. The sequence is explicitly marked "sync": it is not proof
 * of the original action order on disconnected devices.
 */
export const sequenceSyncedWarehouseTransferEvents = onDocumentWritten(
  {
    document: 'workspaceExtensions/{workspaceId}',
    database: 'ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b',
    region: REGION,
    retry: true,
  },
  async (event) => {
    const after = event.data?.after;
    const workspaceId = String(event.params.workspaceId || '');
    if (!after?.exists || !workspaceId) return;

    const extensionRef = after.ref;
    const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
    await db.runTransaction(async (tx) => {
      const [manifestSnap, extensionSnap] = await Promise.all([
        tx.get(manifestRef),
        tx.get(extensionRef),
      ]);
      if (!extensionSnap.exists) return;
      const extension = extensionSnap.data() || {};
      if (extension.ownerId !== workspaceId) return;

      const transfers = Array.isArray(extension.trackedWarehouseTransfers)
        ? extension.trackedWarehouseTransfers as Record<string, unknown>[]
        : [];
      if (!transfers.length) return;

      const nextTransfers = transfers.map((transfer) => ({ ...transfer }));
      const validTransfers = nextTransfers.filter((transfer) =>
        transfer && typeof transfer.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(transfer.id)
        && typeof transfer.productId === 'string' && transfer.productId
        && Number.isFinite(Number(transfer.qty)) && Number(transfer.qty) > 0
      );
      if (!validTransfers.length) return;

      // The extension array is client-writable, so its sequence fields are never
      // authoritative. A server-only ledger is the source of truth for provenance.
      const authorityCollection = db.collection('warehouseTransferEventAuthority');
      const eventRefs: Array<{
        transfer: Record<string, unknown>;
        kind: 'dispatch' | 'receipt';
        ref: FirebaseFirestore.DocumentReference;
      }> = [];
      const seenTransferIds = new Set<string>();
      for (const transfer of validTransfers) {
        const transferId = String(transfer.id);
        if (seenTransferIds.has(transferId)) continue;
        seenTransferIds.add(transferId);
        eventRefs.push({
          transfer,
          kind: 'dispatch',
          ref: authorityCollection.doc(`${workspaceId}_${transferId}_dispatch`),
        });
        if (transfer.status === 'received') eventRefs.push({
          transfer,
          kind: 'receipt',
          ref: authorityCollection.doc(`${workspaceId}_${transferId}_receipt`),
        });
      }
      const authoritySnaps = await Promise.all(eventRefs.map(({ ref }) => tx.get(ref)));
      const counterRef = manifestSnap.exists && manifestSnap.get('coreWriteMode') === 'workspace_native'
        ? migrationDestination(workspaceId, 'counters').doc(workspaceId)
        : db.collection('counters').doc(workspaceId);
      const counterSnap = await tx.get(counterRef);
      let nextSequence = Math.max(0, Number(counterSnap.data()?.lastInventorySequence) || 0);
      const pendingEvents = eventRefs.map((item, index) => ({
        ...item,
        authority: authoritySnaps[index],
        timestamp: Number.isFinite(Date.parse(String(item.transfer.updatedAt || '')))
          ? Date.parse(String(item.transfer.updatedAt))
          : 0,
        id: String(item.transfer.id),
      })).filter(({ authority }) => !authority.exists
        || !Number.isSafeInteger(authority.get('eventSequence'))
        || !['online', 'sync'].includes(String(authority.get('source'))));

      // Keep the server's counter at least as high as every existing authority record.
      for (const snap of authoritySnaps) {
        if (snap.exists && Number.isSafeInteger(snap.get('eventSequence'))) {
          nextSequence = Math.max(nextSequence, Number(snap.get('eventSequence')));
        }
      }
      pendingEvents.sort((a, b) =>
        a.timestamp - b.timestamp || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind)
      );
      const touchTransfer = (transfer: Record<string, unknown>) => {
        const previousTimestamp = Date.parse(String(transfer.updatedAt || ''));
        const nextTimestamp = Math.max(
          Date.now(),
          Number.isFinite(previousTimestamp) ? previousTimestamp + 1 : 0,
        );
        transfer.updatedAt = new Date(nextTimestamp).toISOString();
      };
      let changed = false;
      for (const item of eventRefs) {
        const snap = authoritySnaps[eventRefs.indexOf(item)];
        if (!snap.exists || !Number.isSafeInteger(snap.get('eventSequence'))
            || !['online', 'sync'].includes(String(snap.get('source')))) continue;
        const sequence = Number(snap.get('eventSequence'));
        const source = String(snap.get('source'));
        if (!snap.get('transferSnapshot')) {
          tx.set(item.ref, { transferSnapshot: item.transfer }, { merge: true });
        }
        const sequenceKey = item.kind === 'dispatch' ? 'eventSequence' : 'receivedEventSequence';
        const sourceKey = item.kind === 'dispatch' ? 'eventSequenceSource' : 'receivedEventSequenceSource';
        if (item.transfer[sequenceKey] !== sequence || item.transfer[sourceKey] !== source) {
          item.transfer[sequenceKey] = sequence;
          item.transfer[sourceKey] = source;
          touchTransfer(item.transfer);
          changed = true;
        }
      }
      for (const pending of pendingEvents) {
        nextSequence += 1;
        const source = 'sync' as const;
        const sequenceKey = pending.kind === 'dispatch' ? 'eventSequence' : 'receivedEventSequence';
        const sourceKey = pending.kind === 'dispatch' ? 'eventSequenceSource' : 'receivedEventSequenceSource';
        pending.transfer[sequenceKey] = nextSequence;
        pending.transfer[sourceKey] = source;
        touchTransfer(pending.transfer);
        tx.set(pending.ref, {
          ownerId: workspaceId,
          transferId: pending.id,
          kind: pending.kind,
          eventSequence: nextSequence,
          source,
          transferSnapshot: pending.transfer,
          createdAt: FieldValue.serverTimestamp(),
        });
        changed = true;
      }

      const previousCounter = Math.max(0, Number(counterSnap.data()?.lastInventorySequence) || 0);
      if (!changed && nextSequence === previousCounter) return;
      const now = FieldValue.serverTimestamp();
      tx.update(extensionRef, {
        trackedWarehouseTransfers: nextTransfers,
        _version: Math.max(0, Number(extension._version) || 0) + 1,
        updatedAt: now,
      });
      tx.set(counterRef, {
        ownerId: workspaceId,
        lastVoucherNumber: Math.max(0, Number(counterSnap.data()?.lastVoucherNumber) || 0),
        lastInvoiceSeq: Math.max(0, Number(counterSnap.data()?.lastInvoiceSeq) || 102),
        lastInventorySequence: nextSequence,
        updatedAt: now,
        ...(!counterSnap.exists ? { createdAt: now } : {}),
      }, { merge: true });
    });
  },
);

/**
 * Backfills return counters on legacy sale/purchase invoices.
 * Client rules intentionally block return writes while either counter field is absent,
 * so the set of linked active returns remains stable during this owner-scoped migration.
 */
export const migrateInvoiceReturnCounters = onCall(
  { region: REGION, timeoutSeconds: 120 },
  async (request) => {
    const auth = request.auth as CallableAuth | undefined;
    requireVerifiedAuth(auth);
    const uid = auth.uid;
    const markerRef = db.collection('invoiceReturnCounterMigrations').doc(uid);
    const markerSnap = await markerRef.get();
    if (markerSnap.exists && markerSnap.get('status') === 'completed') {
      return {
        status: 'already-completed',
        migratedCount: Number(markerSnap.get('migratedCount')) || 0,
      };
    }

    const invoiceQuery = db.collection('invoices')
      .where('ownerId', '==', uid)
      .orderBy(FieldPath.documentId())
      .limit(400);
    const legacySourceIds: string[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scannedInvoiceCount = 0;

    while (true) {
      const page = await (cursor ? invoiceQuery.startAfter(cursor) : invoiceQuery).get();
      if (page.empty) break;
      scannedInvoiceCount += page.size;
      for (const invoiceDoc of page.docs) {
        const data = invoiceDoc.data();
        if (
          (data.invoiceType === 'sale' || data.invoiceType === 'purchase')
          && (!Number.isInteger(data.returnRevision) || !Number.isInteger(data.activeReturnCount))
        ) {
          legacySourceIds.push(invoiceDoc.id);
        }
      }
      cursor = page.docs[page.docs.length - 1];
      if (page.size < 400) break;
    }

    let migratedCount = 0;
    for (let offset = 0; offset < legacySourceIds.length; offset += 10) {
      const results = await Promise.all(legacySourceIds.slice(offset, offset + 10).map(async (sourceId) => {
        const sourceRef = db.collection('invoices').doc(sourceId);
        return db.runTransaction(async (tx) => {
          const sourceSnap = await tx.get(sourceRef);
          if (!sourceSnap.exists || sourceSnap.get('ownerId') !== uid) return 0;
          const sourceType = sourceSnap.get('invoiceType');
          if (sourceType !== 'sale' && sourceType !== 'purchase') return 0;
          if (
            Number.isInteger(sourceSnap.get('returnRevision'))
            && Number.isInteger(sourceSnap.get('activeReturnCount'))
          ) return 0;

          const linkedReturnsQuery = db.collection('invoices')
            .where('sourceInvoiceId', '==', sourceId);
          const linkedReturnsSnap = await tx.get(linkedReturnsQuery);
          const activeReturnCount = linkedReturnsSnap.docs.filter((returnDoc) => (
            returnDoc.get('ownerId') === uid
            && (returnDoc.get('invoiceType') === 'sale_return' || returnDoc.get('invoiceType') === 'purchase_return')
            && returnDoc.get('status') !== 'cancelled'
          )).length;
          const currentRevision = sourceSnap.get('returnRevision');
          const currentVersion = Number(sourceSnap.get('_version'));
          tx.update(sourceRef, {
            returnRevision: Number.isInteger(currentRevision) ? currentRevision : 0,
            activeReturnCount,
            _version: (Number.isFinite(currentVersion) && currentVersion >= 1 ? currentVersion : 1) + 1,
            updatedByDevice: 'server-return-counter-migration',
            updatedAt: FieldValue.serverTimestamp(),
          });
          return 1;
        });
      }));
      migratedCount += results.reduce<number>((total, value) => total + value, 0);
    }

    await markerRef.set({
      ownerId: uid,
      status: 'completed',
      migratedCount,
      scannedInvoiceCount,
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { status: 'completed', migratedCount, scannedInvoiceCount };
  },
);


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
    if (typeof data.code !== 'string' || !/^\d+$/.test(data.code)
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

const WORKSPACE_MIGRATION_COLLECTIONS = [
  'counters', 'accounts', 'parties', 'products', 'vouchers', 'invoices',
  'cheques', 'employees', 'assets', 'costCenters', 'currencies',
  'exchangeRates', 'importDossiers', 'salesOrders', 'subcontractJobs',
  'rbacOperators', 'auditLogs', 'workspaceExtensions', 'devicePresence',
  'cloudBackups',
] as const;

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
  // Invoice writes carry inventory, voucher, return-counter and concurrency invariants.
  // The generic workspace bridge is not an accounting transaction and must never bypass them.
  if (collectionName === 'invoices') {
    throw new HttpsError('failed-precondition', 'تغییر فاکتور فقط از مسیر تراکنش اتمیک حسابداری مجاز است.');
  }
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
  if (!['accounts', 'products', 'parties', 'vouchers'].includes(String(collectionName))) {
    throw new HttpsError('invalid-argument', 'این آداپتور فقط حساب‌ها، کالاها، طرف‌حساب‌ها و اسناد را می‌خواند.');
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


function workspaceFnv1aHex(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function workspaceVoucherIntegrityHash(voucher: Record<string, unknown>): string {
  const lines = voucher.lines as Record<string, unknown>[];
  const canonicalLines = lines.map((line) =>
    `${String(line.accountCode).trim()}|${String(line.partyId || '').trim()}|${String(line.costCenterId || '').trim()}|${Math.round(Number(line.debit) || 0)}|${Math.round(Number(line.credit) || 0)}`
  ).join(';');
  const payload = `${voucher.voucherNumber}|${String(voucher.date).trim()}|${voucher.voucherType}|${Math.round(Number(voucher.totalDebit))}|${Math.round(Number(voucher.totalCredit))}|${canonicalLines}`;
  return `vseal_${workspaceFnv1aHex(payload, 0x811c9dc5)}${workspaceFnv1aHex(payload.split('').reverse().join(''), 0x9e3779b9)}`;
}

/** Creates an in-transit transfer and splits source FIFO layers atomically. */
export const createTrackedWarehouseTransfer = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (!(WORKSPACE_WRITE_COLLECTIONS[role] || []).includes('products')) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه انتقال انبار را ندارد.');
  }
  const { productId, transferId, transferNumber, fromWarehouse, toWarehouse, qty, date, operatorName, notes } = request.data || {};
  if (typeof productId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(productId)
      || typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(transferId)
      || typeof transferNumber !== 'string' || !transferNumber.trim() || transferNumber.length > 64
      || typeof fromWarehouse !== 'string' || !fromWarehouse.trim() || fromWarehouse.length > 120
      || typeof toWarehouse !== 'string' || !toWarehouse.trim() || toWarehouse.length > 120
      || fromWarehouse.trim() === toWarehouse.trim()
      || typeof date !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(date)
      || !Number.isFinite(qty) || qty <= 0 || qty > 1e12
      || (operatorName !== undefined && (typeof operatorName !== 'string' || operatorName.length > 120))
      || (notes !== undefined && (typeof notes !== 'string' || notes.length > 500))) {
    throw new HttpsError('invalid-argument', 'اطلاعات حواله انتقال معتبر نیست.');
  }
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const extensionRef = db.collection('workspaceExtensions').doc(workspaceId);
  return db.runTransaction(async (tx) => {
    const manifestSnap = await tx.get(manifestRef);
    const nativeMode = manifestSnap.exists && manifestSnap.get('coreWriteMode') === 'workspace_native';
    if (nativeMode && (manifestSnap.get('status') !== 'verified'
        || manifestSnap.get('coreWritesFrozen') !== true
        || manifestSnap.get('readBarrier.status') !== 'frozen')) {
      throw new HttpsError('failed-precondition', 'نوشتن بومی workspace در وضعیت معتبر و قفل‌شده نیست.');
    }
    if (!nativeMode && manifestSnap.exists && manifestSnap.get('coreWritesFrozen') === true) {
      throw new HttpsError('failed-precondition', 'نوشتن کالا در دوره توقف مهاجرت مسدود است.');
    }
    const productRef = nativeMode ? migrationDestination(workspaceId, 'products').doc(productId) : db.collection('products').doc(productId);
    const counterRef = nativeMode
      ? migrationDestination(workspaceId, 'counters').doc(workspaceId)
      : db.collection('counters').doc(workspaceId);
    const [productSnap, extensionSnap, counterSnap] = await Promise.all([
      tx.get(productRef), tx.get(extensionRef), tx.get(counterRef),
    ]);
    if (!productSnap.exists || !extensionSnap.exists) throw new HttpsError('not-found', 'کالا یا سند انتقال فضای کاری یافت نشد.');
    let productData: Record<string, unknown>;
    let productVersion = 0;
    if (nativeMode) {
      if (productSnap.get('workspaceId') !== workspaceId || productSnap.get('sourceCollection') !== 'products' || productSnap.get('deleted') === true) throw new HttpsError('not-found', 'کالای فعال یافت نشد.');
      productData = productSnap.get('payload') as Record<string, unknown>;
      productVersion = Number(productSnap.get('version') || 1);
    } else productData = productSnap.data() as Record<string, unknown>;
    if (!productData || productData.ownerId !== workspaceId) throw new HttpsError('permission-denied', 'کالا متعلق به این فضای کاری نیست.');
    const ext = extensionSnap.data() as Record<string, unknown>;
    if (ext.ownerId !== workspaceId) throw new HttpsError('permission-denied', 'سند انتقال متعلق به این فضای کاری نیست.');
    const transfers = Array.isArray(ext.trackedWarehouseTransfers) ? ext.trackedWarehouseTransfers as Record<string, unknown>[] : [];
    const existingTransfer = transfers.find((t) => t && t.id === transferId);
    if (existingTransfer) {
      if (existingTransfer.productId === productId && existingTransfer.transferNumber === transferNumber
          && existingTransfer.fromWarehouse === fromWarehouse.trim()
          && existingTransfer.toWarehouse === toWarehouse.trim()
          && Number(existingTransfer.qty) === Math.round(qty * 10000) / 10000
          && existingTransfer.date === date) {
        return { status: 'replayed', transfer: existingTransfer, productVersion };
      }
      throw new HttpsError('already-exists', 'شناسه حواله قبلاً با اطلاعات دیگری استفاده شده است.');
    }
    if (transfers.length >= 100) throw new HttpsError('resource-exhausted', 'ظرفیت اسناد انتقال فضای کاری تکمیل است.');
    const layers = Array.isArray(productData.costLayers) ? productData.costLayers as Record<string, unknown>[] : [];
    if (!layers.length) throw new HttpsError('failed-precondition', 'لایه‌های بهای تمام‌شده کالا موجود نیست؛ ابتدا بهای FIFO کالا را بازسازی کنید.');
    const roundQty = (n: number) => Math.round(n * 10000) / 10000;
    let remaining = roundQty(qty);
    const nextLayers = layers.map((layer) => ({ ...layer }));
    const moved: Record<string, unknown>[] = [];
    let movedCost = 0;
    for (const layer of nextLayers) {
      if (remaining <= 0.00005) break;
      const warehouse = layer.warehouse || productData.warehouse;
      const available = Number(layer.remainingQty);
      const cost = Number(layer.totalCostIrr);
      if (warehouse !== fromWarehouse || !Number.isFinite(available) || available <= 0 || !Number.isFinite(cost) || cost < 0) continue;
      const take = roundQty(Math.min(available, remaining));
      const takeCost = take >= available - 0.00005 ? Math.round(cost) : Math.round(cost * take / available);
      layer.remainingQty = roundQty(Math.max(0, available - take));
      layer.totalCostIrr = Math.max(0, Math.round(cost - takeCost));
      movedCost += takeCost;
      moved.push({
        layerId: `trf_${transferId}_${String(layer.layerId)}`,
        date,
        sourceRef: layer.sourceRef,
        warehouse: `در راه → ${toWarehouse}`,
        originalQty: take,
        remainingQty: take,
        unitCostIrr: take > 0 ? Math.round(takeCost / take) : Number(layer.unitCostIrr) || 0,
        totalCostIrr: takeCost,
      });
      remaining = roundQty(Math.max(0, remaining - take));
    }
    if (remaining > 0.0001 || !moved.length) throw new HttpsError('failed-precondition', 'موجودی کافی در انبار مبدأ وجود ندارد.');
    const cleanLayers = [...nextLayers.filter((l) => Number(l.remainingQty) > 0.00005), ...moved];
    const eventSequence = Math.max(0, Number(counterSnap.data()?.lastInventorySequence) || 0) + 1;
    const transfer = {
      id: transferId, transferNumber: transferNumber.trim(), date, productId,
      updatedAt: new Date().toISOString(),
      eventSequence,
      eventSequenceSource: 'online',
      sku: String(productData.sku || ''), productName: String(productData.name || ''),
      fromWarehouse: fromWarehouse.trim(), toWarehouse: toWarehouse.trim(),
      qty: roundQty(qty), transferredCostIrr: movedCost,
      transferredLayers: moved.map(({ warehouse: _warehouse, date: _date, originalQty: _originalQty, unitCostIrr: _unitCostIrr, ...layer }) => layer),
      status: 'in_transit', operatorName: operatorName || '', notes: notes || '',
    };
    const now = FieldValue.serverTimestamp();
    if (nativeMode) {
      const payload = { ...productData, costLayers: cleanLayers };
      validateCoreWorkspacePayload('products', payload, workspaceId);
      productVersion += 1;
      tx.update(productRef, { payload, sourceHash: workspaceMigrationHash(payload), version: productVersion, updatedAt: now });
    } else tx.update(productRef, { costLayers: cleanLayers, updatedAt: now });
    tx.update(extensionRef, {
      trackedWarehouseTransfers: [...transfers, transfer].slice(-100),
      _version: Math.max(0, Number(ext._version) || 0) + 1,
      updatedAt: now,
    });
    tx.set(db.collection('warehouseTransferEventAuthority').doc(`${workspaceId}_${transferId}_dispatch`), {
      ownerId: workspaceId, transferId, kind: 'dispatch', eventSequence,
      source: 'online', transferSnapshot: transfer, createdAt: now,
    });
    tx.set(counterRef, {
      ownerId: workspaceId,
      lastVoucherNumber: Math.max(0, Number(counterSnap.data()?.lastVoucherNumber) || 0),
      lastInvoiceSeq: Math.max(0, Number(counterSnap.data()?.lastInvoiceSeq) || 102),
      lastInventorySequence: eventSequence,
      updatedAt: now,
      ...(!counterSnap.exists ? { createdAt: now } : {}),
    }, { merge: true });
    return { status: 'committed', transfer, productVersion };
  });
});

/** Atomically receives an in-transit warehouse transfer and moves its FIFO layers. */
export const receiveTrackedWarehouseTransfer = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (!(WORKSPACE_WRITE_COLLECTIONS[role] || []).includes('products')) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه دریافت انتقال انبار را ندارد.');
  }
  const productId = request.data?.productId;
  const transferId = request.data?.transferId;
  const receivedDate = request.data?.receivedDate;
  if (typeof productId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(productId)
      || typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(transferId)
      || typeof receivedDate !== 'string' || !receivedDate.trim() || receivedDate.length > 32) {
    throw new HttpsError('invalid-argument', 'شناسه کالا، انتقال یا تاریخ دریافت معتبر نیست.');
  }
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const extensionRef = db.collection('workspaceExtensions').doc(workspaceId);
  return db.runTransaction(async (tx) => {
    const manifestSnap = await tx.get(manifestRef);
    const nativeMode = manifestSnap.exists && manifestSnap.get('coreWriteMode') === 'workspace_native';
    if (nativeMode && (manifestSnap.get('status') !== 'verified'
        || manifestSnap.get('coreWritesFrozen') !== true
        || manifestSnap.get('readBarrier.status') !== 'frozen')) {
      throw new HttpsError('failed-precondition', 'نوشتن بومی workspace در وضعیت معتبر و قفل‌شده نیست.');
    }
    if (!nativeMode && manifestSnap.exists && manifestSnap.get('coreWritesFrozen') === true) {
      throw new HttpsError('failed-precondition', 'نوشتن کالا در دوره توقف مهاجرت مسدود است.');
    }
    const productRef = nativeMode ? migrationDestination(workspaceId, 'products').doc(productId) : db.collection('products').doc(productId);
    const counterRef = nativeMode
      ? migrationDestination(workspaceId, 'counters').doc(workspaceId)
      : db.collection('counters').doc(workspaceId);
    const dispatchAuthorityRef = db.collection('warehouseTransferEventAuthority').doc(`${workspaceId}_${transferId}_dispatch`);
    const receiptAuthorityRef = db.collection('warehouseTransferEventAuthority').doc(`${workspaceId}_${transferId}_receipt`);
    const [productSnap, extensionSnap, counterSnap, dispatchAuthoritySnap, receiptAuthoritySnap] = await Promise.all([
      tx.get(productRef), tx.get(extensionRef), tx.get(counterRef),
      tx.get(dispatchAuthorityRef), tx.get(receiptAuthorityRef),
    ]);
    if (!productSnap.exists || !extensionSnap.exists) throw new HttpsError('failed-precondition', 'کالا یا سند همگام‌سازی انتقال‌ها در فضای کاری موجود نیست.');
    let productData: Record<string, unknown>;
    let productVersion = 0;
    if (nativeMode) {
      if (productSnap.get('workspaceId') !== workspaceId || productSnap.get('sourceCollection') !== 'products' || productSnap.get('deleted') === true) throw new HttpsError('not-found', 'کالای فعال در فضای کاری یافت نشد.');
      productData = productSnap.get('payload') as Record<string, unknown>;
      productVersion = Number(productSnap.get('version') || 1);
    } else productData = productSnap.data() as Record<string, unknown>;
    if (!productData || productData.ownerId !== workspaceId) throw new HttpsError('permission-denied', 'کالا متعلق به این فضای کاری نیست.');
    const extensionData = extensionSnap.data() as Record<string, unknown>;
    if (extensionData.ownerId !== workspaceId) throw new HttpsError('permission-denied', 'اطلاعات انتقال متعلق به این فضای کاری نیست.');
    const transfers = Array.isArray(extensionData.trackedWarehouseTransfers) ? extensionData.trackedWarehouseTransfers as Record<string, unknown>[] : [];
    const transferIndex = transfers.findIndex((item) => item && item.id === transferId);
    if (transferIndex < 0) throw new HttpsError('not-found', 'سند انتقال در فضای کاری یافت نشد.');
    const transfer = transfers[transferIndex];
    if (!dispatchAuthoritySnap.exists) {
      throw new HttpsError('failed-precondition', 'مرجع معتبر ثبت خروج انتقال هنوز آماده نیست؛ همگام‌سازی را تکرار کنید.');
    }
    const authoritativeTransfer = dispatchAuthoritySnap.get('transferSnapshot') as Record<string, unknown> | undefined;
    if (authoritativeTransfer) {
      const immutableFields = ['id', 'productId', 'transferNumber', 'date', 'fromWarehouse', 'toWarehouse', 'qty', 'transferredCostIrr'];
      const transferLayers = Array.isArray(transfer.transferredLayers)
        ? transfer.transferredLayers as Record<string, unknown>[]
        : [];
      const authoritativeLayers = Array.isArray(authoritativeTransfer.transferredLayers)
        ? authoritativeTransfer.transferredLayers as Record<string, unknown>[]
        : [];
      const layerFields = ['layerId', 'sourceRef', 'remainingQty', 'totalCostIrr'];
      const layersMismatch = transferLayers.length !== authoritativeLayers.length
        || transferLayers.some((layer, index) =>
          layerFields.some((key) => layer[key] !== authoritativeLayers[index]?.[key])
        );
      const hasMismatch = immutableFields.some((key) => transfer[key] !== authoritativeTransfer[key])
        || layersMismatch;
      if (hasMismatch) {
        throw new HttpsError('failed-precondition', 'اطلاعات حواله با نسخه مرجع سرور مغایرت دارد.');
      }
    }
    if (transfer.productId !== productId) throw new HttpsError('failed-precondition', 'انتقال به کالای دیگری تعلق دارد.');
    if (transfer.status === 'received') {
      const authoritativeReceipt = receiptAuthoritySnap.get('transferSnapshot') as Record<string, unknown> | undefined;
      if (!receiptAuthoritySnap.exists || !authoritativeReceipt
          || authoritativeReceipt.status !== 'received'
          || authoritativeReceipt.receivedDate !== transfer.receivedDate) {
        throw new HttpsError('failed-precondition', 'وضعیت دریافت حواله با مرجع ثبت‌شده سرور مطابقت ندارد.');
      }
      if (transfer.receivedDate === receivedDate) return { status: 'replayed', productVersion };
      throw new HttpsError('failed-precondition', 'این انتقال قبلاً با تاریخ دیگری دریافت شده است.');
    }
    if (transfer.status !== 'in_transit' || authoritativeTransfer?.status !== 'in_transit') {
      throw new HttpsError('failed-precondition', 'فقط انتقال معتبر در راه قابل دریافت است.');
    }
    const expectedLayers = Array.isArray(transfer.transferredLayers) ? transfer.transferredLayers as Record<string, unknown>[] : [];
    const currentLayers = Array.isArray(productData.costLayers) ? productData.costLayers as Record<string, unknown>[] : [];
    if (!expectedLayers.length || !currentLayers.length || !Number.isFinite(Number(transfer.qty)) || Number(transfer.qty) <= 0 || !Number.isFinite(Number(transfer.transferredCostIrr)) || Number(transfer.transferredCostIrr) < 0 || typeof transfer.toWarehouse !== 'string' || !transfer.toWarehouse) throw new HttpsError('failed-precondition', 'اطلاعات لایه‌ها یا مقادیر انتقال معتبر نیست.');
    const expectedById = new Map<string, Record<string, unknown>>();
    for (const layer of expectedLayers) {
      if (typeof layer.layerId !== 'string' || !layer.layerId || expectedById.has(layer.layerId)) throw new HttpsError('failed-precondition', 'شناسه لایه انتقال نامعتبر یا تکراری است.');
      expectedById.set(layer.layerId, layer);
    }
    const found = new Set<string>();
    let actualQty = 0;
    let actualValue = 0;
    const transitWarehouse = 'در راه → ' + String(transfer.toWarehouse);
    const nextLayers = currentLayers.map((layer) => {
      const layerId = layer.layerId;
      if (typeof layerId !== 'string' || !expectedById.has(layerId)) return layer;
      if (found.has(layerId)) throw new HttpsError('failed-precondition', 'شناسه لایه انتقال در موجودی تکراری است.');
      found.add(layerId);
      const expected = expectedById.get(layerId)!;
      const qty = Number(layer.remainingQty);
      const cost = Number(layer.totalCostIrr);
      if (layer.warehouse !== transitWarehouse || layer.sourceRef !== expected.sourceRef || !Number.isFinite(qty) || Math.abs(qty - Number(expected.remainingQty)) > 0.00005 || !Number.isFinite(cost) || cost !== Number(expected.totalCostIrr)) throw new HttpsError('failed-precondition', 'اطلاعات لایه انتقال با موجودی کالا مغایرت دارد.');
      actualQty += qty; actualValue += cost;
      return { ...layer, warehouse: transfer.toWarehouse };
    });
    if (found.size !== expectedById.size || Math.abs(actualQty - Number(transfer.qty)) > 0.0001 || actualValue !== Number(transfer.transferredCostIrr)) throw new HttpsError('failed-precondition', 'مقدار یا ارزش لایه‌های انتقال با سند انتقال مطابقت ندارد.');
    const eventSequence = Math.max(0, Number(counterSnap.data()?.lastInventorySequence) || 0) + 1;
    const nextTransfers = transfers.slice();
    nextTransfers[transferIndex] = {
      ...transfer, status: 'received', receivedDate, updatedAt: new Date().toISOString(),
      receivedEventSequence: eventSequence, receivedEventSequenceSource: 'online',
    };
    const now = FieldValue.serverTimestamp();
    if (nativeMode) {
      const nextPayload = { ...productData, costLayers: nextLayers };
      validateCoreWorkspacePayload('products', nextPayload, workspaceId);
      productVersion += 1;
      tx.update(productRef, { payload: nextPayload, sourceHash: workspaceMigrationHash(nextPayload), version: productVersion, updatedAt: now });
    } else tx.update(productRef, { costLayers: nextLayers, updatedAt: now });
    tx.update(extensionRef, { trackedWarehouseTransfers: nextTransfers.slice(0, 100), _version: Math.max(0, Number(extensionData._version) || 0) + 1, updatedAt: now });
    tx.set(db.collection('warehouseTransferEventAuthority').doc(`${workspaceId}_${transferId}_receipt`), {
      ownerId: workspaceId, transferId, kind: 'receipt', eventSequence,
      source: 'online', transferSnapshot: nextTransfers[transferIndex], createdAt: now,
    });
    tx.set(counterRef, {
      ownerId: workspaceId,
      lastVoucherNumber: Math.max(0, Number(counterSnap.data()?.lastVoucherNumber) || 0),
      lastInvoiceSeq: Math.max(0, Number(counterSnap.data()?.lastInvoiceSeq) || 102),
      lastInventorySequence: eventSequence,
      updatedAt: now,
      ...(!counterSnap.exists ? { createdAt: now } : {}),
    }, { merge: true });
    return { status: 'committed', productVersion, transferId, receivedEventSequence: eventSequence };
  });
});

/**
 * Restores transfer records removed from the client-writable extension array.
 * The server-only dispatch ledger is authoritative; receipt snapshots supersede
 * dispatch snapshots only when the receipt event is owned by this workspace.
 */
export const restoreTrackedWarehouseTransfers = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (!(WORKSPACE_WRITE_COLLECTIONS[role] || []).includes('products')) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه بازیابی اسناد انتقال انبار را ندارد.');
  }

  const extensionRef = db.collection('workspaceExtensions').doc(workspaceId);
  const authorityCollection = db.collection('warehouseTransferEventAuthority');
  return db.runTransaction(async (tx) => {
    const extensionSnap = await tx.get(extensionRef);
    if (!extensionSnap.exists || extensionSnap.get('ownerId') !== workspaceId) {
      throw new HttpsError('not-found', 'سند فضای کاری برای بازیابی حواله‌ها یافت نشد.');
    }

    const existing = Array.isArray(extensionSnap.get('trackedWarehouseTransfers'))
      ? extensionSnap.get('trackedWarehouseTransfers') as Record<string, unknown>[]
      : [];
    const existingIds = new Set(existing
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => String(item.id)));

    // A single-field owner query avoids requiring a composite index. The bounded
    // scan prevents an unbounded callable read; the extension itself is capped at 100.
    const authorityQuery = authorityCollection
      .where('ownerId', '==', workspaceId)
      .limit(200);
    const authoritySnap = await tx.get(authorityQuery);
    const dispatchDocs = authoritySnap.docs.filter((doc) =>
      doc.get('kind') === 'dispatch'
      && doc.get('ownerId') === workspaceId
      && typeof doc.get('transferId') === 'string'
      && !existingIds.has(String(doc.get('transferId')))
      && doc.get('transferSnapshot')
      && typeof doc.get('transferSnapshot') === 'object'
    );

    const candidates = dispatchDocs.map((doc) => ({
      doc,
      transferId: String(doc.get('transferId')),
      snapshot: doc.get('transferSnapshot') as Record<string, unknown>,
    })).filter(({ transferId, snapshot }) =>
      /^[A-Za-z0-9_-]{1,128}$/.test(transferId)
      && snapshot.id === transferId
      && snapshot.productId
      && Number.isFinite(Number(snapshot.qty))
      && Number(snapshot.qty) > 0
      && Array.isArray(snapshot.transferredLayers)
    );

    const receiptRefs = candidates.map(({ transferId }) =>
      authorityCollection.doc(`${workspaceId}_${transferId}_receipt`)
    );
    const receiptSnaps = receiptRefs.length
      ? await Promise.all(receiptRefs.map((ref) => tx.get(ref)))
      : [];

    const recovered = candidates.flatMap(({ transferId, snapshot }, index) => {
      const receipt = receiptSnaps[index];
      const receiptSnapshot = receipt.exists
        && receipt.get('ownerId') === workspaceId
        && receipt.get('transferId') === transferId
        && receipt.get('kind') === 'receipt'
        ? receipt.get('transferSnapshot') as Record<string, unknown> | undefined
        : undefined;
      // Dispatch snapshots are immutable and remain "in_transit". A completed
      // transfer is represented by its separately-authorized receipt event.
      if (receiptSnapshot?.status === 'received'
          && receiptSnapshot.id === transferId
          && typeof receiptSnapshot.receivedDate === 'string'
          && receiptSnapshot.receivedDate) return [receiptSnapshot];
      if (snapshot.status !== 'in_transit') return [];
      return [snapshot];
    }).filter((transfer) => !existingIds.has(String(transfer.id)));

    const room = Math.max(0, 100 - existing.length);
    const restored = recovered
      .sort((a, b) => Number(a.eventSequence || 0) - Number(b.eventSequence || 0))
      .slice(0, room);
    if (restored.length) {
      tx.update(extensionRef, {
        trackedWarehouseTransfers: [...existing, ...restored],
        _version: Math.max(0, Number(extensionSnap.get('_version')) || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      status: restored.length ? 'restored' : recovered.length ? 'capacity-reached' : 'up-to-date',
      restoredCount: restored.length,
      remainingCapacity: Math.max(0, room - restored.length),
    };
  });
});


/**
 * Reads a bounded page of immutable transfer history from the server-only event ledger.
 * The active extension array remains capped; history is never hydrated into that array.
 */
export const listTrackedWarehouseTransferHistory = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (role !== 'auditor_readonly'
      && !(WORKSPACE_WRITE_COLLECTIONS[role] || []).includes('products')) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه مشاهده تاریخچه حواله‌های انبار را ندارد.');
  }

  const cursor = request.data?.cursor;
  if (cursor !== undefined && cursor !== null
      && (typeof cursor !== 'string'
        || cursor.length > 300
        || !cursor.startsWith(`${workspaceId}_`)
        || !cursor.endsWith('_dispatch')
        || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
    throw new HttpsError('invalid-argument', 'نشانگر صفحه تاریخچه معتبر نیست.');
  }

  const PAGE_DOCUMENTS = 100;
  let query = db.collection('warehouseTransferEventAuthority')
    .where('ownerId', '==', workspaceId)
    .where('kind', '==', 'dispatch')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(PAGE_DOCUMENTS);
  if (typeof cursor === 'string' && cursor) query = query.startAfter(cursor);
  const page = await query.get();

  const dispatches = page.docs.filter((doc) =>
    doc.get('ownerId') === workspaceId
    && doc.get('kind') === 'dispatch'
    && typeof doc.get('transferId') === 'string'
    && doc.get('transferSnapshot')
    && typeof doc.get('transferSnapshot') === 'object'
  );
  const receiptSnapshots = await Promise.all(dispatches.map(async (doc) => {
    const transferId = String(doc.get('transferId'));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(transferId)) return null;
    const receipt = await db.collection('warehouseTransferEventAuthority')
      .doc(`${workspaceId}_${transferId}_receipt`).get();
    if (!receipt.exists || receipt.get('ownerId') !== workspaceId
        || receipt.get('transferId') !== transferId || receipt.get('kind') !== 'receipt') return null;
    const snapshot = receipt.get('transferSnapshot');
    return snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : null;
  }));

  const transfers = dispatches.flatMap((doc, index) => {
    const transferId = String(doc.get('transferId'));
    const snapshot = doc.get('transferSnapshot') as Record<string, unknown>;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(transferId)
        || snapshot.id !== transferId
        || typeof snapshot.productId !== 'string'
        || !Number.isFinite(Number(snapshot.qty)) || Number(snapshot.qty) <= 0
        || !Array.isArray(snapshot.transferredLayers)) return [];
    const receipt = receiptSnapshots[index];
    // The dispatch event is immutable; use the receipt event as the current
    // state when one exists, otherwise keep the dispatch in the in-transit state.
    if (receipt?.id === transferId && receipt.status === 'received'
        && typeof receipt.receivedDate === 'string' && receipt.receivedDate) {
      const immutableFields = ['productId', 'transferNumber', 'date', 'fromWarehouse', 'toWarehouse', 'qty', 'transferredCostIrr'];
      if (immutableFields.some((key) => receipt[key] !== snapshot[key])) return [];
      return [receipt];
    }
    if (snapshot.status !== 'in_transit') return [];
    return [snapshot];
  });

  transfers.sort((a, b) =>
    Number(a.eventSequence || 0) - Number(b.eventSequence || 0)
    || String(a.id).localeCompare(String(b.id))
  );
  return {
    transfers,
    nextCursor: page.size === PAGE_DOCUMENTS ? page.docs[page.docs.length - 1].id : null,
    hasMore: page.size === PAGE_DOCUMENTS,
  };
});

/** Server-authoritative, atomic stock adjustment and permanent voucher posting. */
export const adjustWorkspaceProductStockWithVoucher = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (!['owner', 'finance_manager', 'accountant'].includes(role)) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه تعدیل موجودی همراه با سند حسابداری را ندارد.');
  }
  const productId = request.data?.productId;
  const voucherId = request.data?.voucherId;
  const operationId = request.data?.operationId;
  const expectedVersion = request.data?.expectedVersion;
  const countedStock = request.data?.countedStock;
  const date = request.data?.date;
  const reason = request.data?.reason;
  const deviceId = request.data?.deviceId;
  if (typeof productId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(productId)
      || typeof voucherId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(voucherId)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId)
      || !Number.isInteger(expectedVersion) || expectedVersion < 1
      || typeof countedStock !== 'number' || !Number.isFinite(countedStock) || countedStock < 0 || countedStock > 1e12
      || typeof date !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(date)
      || Number(date.slice(5, 7)) < 1 || Number(date.slice(5, 7)) > 12
      || Number(date.slice(8, 10)) < 1 || Number(date.slice(8, 10)) > (Number(date.slice(5, 7)) <= 6 ? 31 : Number(date.slice(5, 7)) <= 11 ? 30 : 29)
      || typeof reason !== 'string' || reason.length > 300
      || (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length > 64))) {
    throw new HttpsError('invalid-argument', 'پارامترهای تعدیل موجودی معتبر نیستند.');
  }
  const fiscalYear = date.slice(0, 4);
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const productRef = migrationDestination(workspaceId, 'products').doc(productId);
  const voucherRef = migrationDestination(workspaceId, 'vouchers').doc(voucherId);
  const counterRef = migrationDestination(workspaceId, 'counters').doc(workspaceId);
  const profileRef = db.collection('users').doc(workspaceId);
  const operationRef = db.collection('workspaceWriteOperations').doc(workspaceId + '_inventory_adjustment_' + operationId);
  const accountQuery = migrationDestination(workspaceId, 'accounts');
  const requestHash = createHash('sha256').update(JSON.stringify(stableMigrationValue({
    productId, voucherId, expectedVersion, countedStock, date, reason,
  }))).digest('hex');

  return db.runTransaction(async (tx) => {
    const [manifest, operationSnap, productSnap, voucherSnap, counterSnap, profileSnap, accountSnaps] = await Promise.all([
      tx.get(manifestRef), tx.get(operationRef), tx.get(productRef), tx.get(voucherRef),
      tx.get(counterRef), tx.get(profileRef), tx.get(accountQuery),
    ]);
    if (!manifest.exists || manifest.get('status') !== 'verified'
        || manifest.get('coreWritesFrozen') !== true
        || manifest.get('coreWriteMode') !== 'workspace_native'
        || manifest.get('readBarrier.status') !== 'frozen') {
      throw new HttpsError('failed-precondition', 'نوشتن تعدیل موجودی در Workspace فعال یا قفل‌شده نیست.');
    }
    if (operationSnap.exists) {
      if (operationSnap.get('requestHash') !== requestHash) {
        throw new HttpsError('already-exists', 'شناسه عملیات تعدیل برای درخواست دیگری استفاده شده است.');
      }
      return {
        status: 'replayed', operationId,
        version: operationSnap.get('resultVersion'),
        voucherNumber: operationSnap.get('voucherNumber') ?? null,
        adjustmentCostIrr: operationSnap.get('adjustmentCostIrr') ?? 0,
        product: {
          stock: productSnap.get('payload.stock'), buyPrice: productSnap.get('payload.buyPrice'),
          costingMethod: productSnap.get('payload.costingMethod'), costLayers: productSnap.get('payload.costLayers'),
          inventoryValueIrr: productSnap.get('payload.inventoryValueIrr'), _version: productSnap.get('payload._version'),
        },
        ...(voucherSnap.exists ? {
          voucher: Object.fromEntries(Object.entries(voucherSnap.get('payload') as Record<string, unknown>)
            .filter(([key]) => key !== 'createdAt' && key !== 'updatedAt')),
        } : {}),
      };
    }
    if (!productSnap.exists || productSnap.get('workspaceId') !== workspaceId
        || productSnap.get('sourceCollection') !== 'products' || productSnap.get('deleted') === true) {
      throw new HttpsError('not-found', 'کالای فعال در فضای کاری یافت نشد.');
    }
    if (voucherSnap.exists) throw new HttpsError('already-exists', 'شناسه سند تعدیل از قبل وجود دارد.');
    const currentVersion = Number(productSnap.get('version') || 1);
    if (currentVersion !== expectedVersion) {
      throw new HttpsError('aborted', 'نسخه کالا تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', {
        expectedVersion, currentVersion,
      });
    }
    const product = productSnap.get('payload') as Record<string, unknown>;
    if (!product || product.ownerId !== workspaceId
        || typeof product.stock !== 'number' || !Number.isFinite(product.stock) || product.stock < 0
        || typeof product.buyPrice !== 'number' || !Number.isFinite(product.buyPrice) || product.buyPrice < 0
        || typeof product.name !== 'string' || typeof product.sku !== 'string'
        || typeof product.warehouse !== 'string' || typeof product.unit !== 'string') {
      throw new HttpsError('failed-precondition', 'اطلاعات پایه یا موجودی کالا معتبر نیست.');
    }
    const closedFiscalYears = profileSnap.get('closedFiscalYears');
    if (Array.isArray(closedFiscalYears) && closedFiscalYears.includes(fiscalYear)) {
      throw new HttpsError('failed-precondition', 'سال مالی ' + fiscalYear + ' بسته است.');
    }
    const method = String(product.costingMethod || profileSnap.get('defaultCostingMethod') || 'fifo');
    if (!['fifo', 'moving_average', 'periodic_average'].includes(method)) {
      throw new HttpsError('failed-precondition', 'روش بهای تمام‌شده کالا پشتیبانی نمی‌شود.');
    }

    const roundQty = (value: number) => Math.round(value * 10000) / 10000;
    const roundQty2 = (value: number) => Math.round(value * 100) / 100;
    const stock = roundQty(product.stock);
    const layersRaw = product.costLayers;
    if (stock > 0 && (!Array.isArray(layersRaw) || layersRaw.length === 0)) {
      throw new HttpsError('failed-precondition', 'لایه‌های بهای تمام‌شده موجود نیست؛ ابتدا بهای FIFO کالا را بازسازی کنید.');
    }
    const rawLayers = (Array.isArray(layersRaw) ? layersRaw : []).map((layer) => ({ ...(layer as Record<string, unknown>) }));
    if (rawLayers.some((layer) => typeof layer.layerId !== 'string' || !layer.layerId
        || typeof layer.remainingQty !== 'number' || !Number.isFinite(layer.remainingQty) || layer.remainingQty < 0
        || typeof layer.totalCostIrr !== 'number' || !Number.isFinite(layer.totalCostIrr) || layer.totalCostIrr < 0
        || typeof layer.unitCostIrr !== 'number' || !Number.isFinite(layer.unitCostIrr) || layer.unitCostIrr < 0)) {
      throw new HttpsError('failed-precondition', 'ساختار لایه‌های بهای تمام‌شده نامعتبر است.');
    }
    const layers = rawLayers.filter((layer) => Number(layer.remainingQty) > 0.00005);
    const layerQty = roundQty(layers.reduce((sum, layer) => sum + Number(layer.remainingQty), 0));
    const layerValue = layers.reduce((sum, layer) => sum + Number(layer.totalCostIrr), 0);
    const inventoryValue = product.inventoryValueIrr === undefined
      ? (layers.length > 0 ? Math.round(layerValue) : Math.round(stock * product.buyPrice))
      : Number(product.inventoryValueIrr);
    if (!Number.isFinite(inventoryValue) || inventoryValue < 0
        || Math.abs(layerQty - stock) >= 0.005
        || Math.abs(layerValue - Math.round(inventoryValue)) >= 1) {
      throw new HttpsError('failed-precondition', 'مقدار یا ارزش لایه‌های بهای تمام‌شده با موجودی کالا تطبیق ندارد.');
    }

    const diffQty = roundQty(countedStock - stock);
    const operationNow = FieldValue.serverTimestamp();
    if (Math.abs(diffQty) < 0.001) {
      tx.create(operationRef, {
        workspaceId, uid: auth.uid, collection: 'products', documentId: productId,
        operation: 'inventory_adjustment_noop', requestHash, resultVersion: currentVersion,
        adjustmentCostIrr: 0, createdAt: operationNow,
      });
      return {
        status: 'no_change', operationId, version: currentVersion, adjustmentCostIrr: 0,
        product: {
          stock: product.stock, buyPrice: product.buyPrice, costingMethod: product.costingMethod,
          costLayers: product.costLayers, inventoryValueIrr: product.inventoryValueIrr, _version: product._version,
        },
      };
    }

    const totalValue = Math.round(inventoryValue);
    const weightedAverage = stock > 0 ? Math.round(totalValue / stock) : Math.round(product.buyPrice);
    const adjustmentQty = Math.abs(diffQty);
    let adjustmentCostIrr = 0;
    let nextLayers: Record<string, unknown>[];
    if (diffQty > 0) {
      adjustmentCostIrr = Math.max(0, Math.round(adjustmentQty * weightedAverage));
      nextLayers = [...layers, {
        layerId: 'lyr_' + operationId, date, sourceRef: operationId,
        warehouse: product.warehouse, originalQty: adjustmentQty, remainingQty: adjustmentQty,
        unitCostIrr: adjustmentQty > 0 ? Math.round(adjustmentCostIrr / adjustmentQty) : 0,
        totalCostIrr: adjustmentCostIrr,
      }];
    } else {
      if (stock + 0.0001 < adjustmentQty) {
        throw new HttpsError('failed-precondition', 'موجودی کافی نیست؛ ثبت موجودی منفی مجاز نیست.');
      }
      if (method === 'fifo') {
        let remaining = adjustmentQty;
        nextLayers = layers.map((layer) => ({ ...layer }));
        for (const layer of nextLayers) {
          if (remaining <= 0.00005) break;
          const available = Number(layer.remainingQty);
          if (available <= 0.00005) continue;
          const take = roundQty(Math.min(available, remaining));
          const cost = take >= available - 0.00005
            ? Number(layer.totalCostIrr)
            : Math.round((Number(layer.totalCostIrr) * take) / available);
          layer.remainingQty = roundQty(Math.max(0, available - take));
          layer.totalCostIrr = Math.max(0, Number(layer.totalCostIrr) - cost);
          remaining = roundQty(Math.max(0, remaining - take));
          adjustmentCostIrr += cost;
        }
        if (remaining > 0.00005) {
          throw new HttpsError('failed-precondition', 'لایه‌های FIFO برای پوشش کسری موجودی کافی نیستند.');
        }
        nextLayers = nextLayers.filter((layer) => Number(layer.remainingQty) > 0.00005);
      } else {
        adjustmentCostIrr = stock > 0 && adjustmentQty >= stock - 0.00005
          ? totalValue : Math.round((totalValue * adjustmentQty) / stock);
        let remaining = adjustmentQty;
        nextLayers = layers.map((layer) => ({ ...layer }));
        for (const layer of nextLayers) {
          if (remaining <= 0.00005) break;
          const available = Number(layer.remainingQty);
          if (available <= 0.00005) continue;
          const take = roundQty(Math.min(available, remaining));
          layer.remainingQty = roundQty(Math.max(0, available - take));
          layer.totalCostIrr = Math.round(Number(layer.remainingQty) * (adjustmentQty > 0 ? Math.round(adjustmentCostIrr / adjustmentQty) : 0));
          remaining = roundQty(Math.max(0, remaining - take));
        }
        nextLayers = nextLayers.filter((layer) => Number(layer.remainingQty) > 0.00005);
        const nextStockForLayers = roundQty(stock - adjustmentQty);
        const nextValueForLayers = Math.max(0, totalValue - adjustmentCostIrr);
        let runningValue = 0;
        for (let i = 0; i < nextLayers.length; i += 1) {
          const isLast = i === nextLayers.length - 1;
          const value = isLast ? Math.max(0, nextValueForLayers - runningValue)
            : nextStockForLayers > 0 ? Math.round((nextValueForLayers * Number(nextLayers[i].remainingQty)) / nextStockForLayers) : 0;
          nextLayers[i].totalCostIrr = value;
          nextLayers[i].unitCostIrr = Number(nextLayers[i].remainingQty) > 0
            ? Math.round(value / Number(nextLayers[i].remainingQty)) : 0;
          runningValue += value;
        }
      }
    }

    const nextStock = roundQty2(diffQty > 0 ? stock + adjustmentQty : stock - adjustmentQty);
    const nextInventoryValue = diffQty > 0 ? totalValue + adjustmentCostIrr : Math.max(0, totalValue - adjustmentCostIrr);
    const nextBuyPrice = nextStock > 0 ? Math.round(nextInventoryValue / nextStock) : weightedAverage;
    const nextPayload = {
      ...product, stock: nextStock, buyPrice: nextBuyPrice,
      costingMethod: method, costLayers: nextLayers,
      inventoryValueIrr: nextInventoryValue, _version: currentVersion + 1,
      updatedByDevice: typeof deviceId === 'string' ? deviceId : 'workspace_server',
      updatedAt: operationNow,
    };
    validateCoreWorkspacePayload('products', nextPayload, workspaceId);

    let voucherNumber: number | null = null;
    let voucherPayload: Record<string, unknown> | null = null;
    let voucherForClient: Record<string, unknown> | null = null;
    if (adjustmentCostIrr > 0) {
      const accountsByCode = new Map(accountSnaps.docs
        .filter((snapshot) => snapshot.get('deleted') !== true)
        .map((snapshot) => {
          const payload = snapshot.get('payload') as Record<string, unknown> | undefined;
          return [String(payload?.code || ''), payload || {}] as [string, Record<string, unknown>];
        }));
      const inventoryAccount = accountsByCode.get('10501');
      const offsetAccount = accountsByCode.get(diffQty > 0 ? '60301' : '80401');
      if (!inventoryAccount || inventoryAccount.active === false || !offsetAccount || offsetAccount.active === false) {
        throw new HttpsError('failed-precondition', 'حساب موجودی کالا یا حساب سود/زیان تعدیل در دفتر حساب‌های Workspace فعال نیست.');
      }
      const inventoryTitle = String(inventoryAccount.title || '').trim();
      const offsetTitle = String(offsetAccount.title || '').trim();
      if (!inventoryTitle || !offsetTitle) {
        throw new HttpsError('failed-precondition', 'عنوان حساب‌های لازم برای سند تعدیل معتبر نیست.');
      }
      const existingVoucherQuery = migrationDestination(workspaceId, 'vouchers')
        .where('payload.fiscalYear', '==', fiscalYear);
      const existingVouchers = await tx.get(existingVoucherQuery);
      const maxExisting = existingVouchers.docs.reduce((max, item) =>
        Math.max(max, Number(item.get('payload.voucherNumber')) || 0), 0);
      voucherNumber = Math.max(Number(counterSnap.get('payload.lastVoucherNumber')) || 0, maxExisting) + 1;
      const productLabel = String(product.name).slice(0, 160);
      const referenceId = ('stk_' + operationId).slice(0, 128);
      const description = 'سند تعدیل انبارگردانی «' + productLabel + '» (' + (diffQty > 0 ? '+' + diffQty : String(diffQty)) + ' ' + String(product.unit).slice(0, 24) + ')';
      const lines = diffQty > 0 ? [
        { accountCode: '10501', accountTitle: inventoryTitle, description: 'اضافی انبارگردانی ' + productLabel, debit: adjustmentCostIrr, credit: 0 },
        { accountCode: '60301', accountTitle: offsetTitle, description: reason || ('سود تعدیل اضافی انبارگردانی — کد ' + String(product.sku)), debit: 0, credit: adjustmentCostIrr },
      ] : [
        { accountCode: '80401', accountTitle: offsetTitle, description: reason || ('کسری انبارگردانی — ' + productLabel), debit: adjustmentCostIrr, credit: 0 },
        { accountCode: '10501', accountTitle: inventoryTitle, description: 'کاهش موجودی انبار بابت کسری/انبارگردانی ' + productLabel, debit: 0, credit: adjustmentCostIrr },
      ];
      const unsignedVoucher = {
        ownerId: workspaceId, voucherNumber, date, fiscalYear, description,
        voucherType: 'general', status: 'permanent', totalDebit: adjustmentCostIrr,
        totalCredit: adjustmentCostIrr, referenceId, lines,
        _version: 1, updatedByDevice: typeof deviceId === 'string' ? deviceId : 'workspace_server',
      };
      voucherForClient = {
        ...unsignedVoucher,
        integrityHash: workspaceVoucherIntegrityHash(unsignedVoucher),
      };
      voucherPayload = {
        ...voucherForClient,
        createdAt: operationNow, updatedAt: operationNow,
      };
    }

    tx.update(productRef, {
      version: currentVersion + 1, payload: nextPayload,
      sourceHash: workspaceMigrationHash(nextPayload), updatedAt: operationNow,
    });
    if (voucherPayload && voucherNumber !== null) {
      tx.create(voucherRef, {
        workspaceId, sourceCollection: 'vouchers', sourceId: voucherId,
        sourceHash: workspaceMigrationHash(voucherPayload), schemaVersion: 1,
        version: 1, deleted: false, payload: voucherPayload,
        createdAt: operationNow, updatedAt: operationNow,
      });
      tx.set(counterRef, {
        workspaceId, sourceCollection: 'counters', sourceId: workspaceId,
        schemaVersion: 1, version: Number(counterSnap.get('version') || 0) + 1,
        deleted: false,
        payload: { ownerId: workspaceId, lastVoucherNumber: voucherNumber, updatedAt: operationNow },
        createdAt: counterSnap.exists ? counterSnap.get('createdAt') || operationNow : operationNow,
        updatedAt: operationNow,
      });
    }
    tx.create(operationRef, {
      workspaceId, uid: auth.uid, collection: 'products', documentId: productId,
      operation: 'inventory_adjustment', requestHash, resultVersion: currentVersion + 1,
      voucherNumber, adjustmentCostIrr, voucherId: voucherPayload ? voucherId : null,
      createdAt: operationNow,
    });
    return {
      status: 'committed', operationId, version: currentVersion + 1, voucherNumber, adjustmentCostIrr,
      product: {
        stock: nextPayload.stock, buyPrice: nextPayload.buyPrice, costingMethod: nextPayload.costingMethod,
        costLayers: nextPayload.costLayers, inventoryValueIrr: nextPayload.inventoryValueIrr,
        _version: nextPayload._version,
      },
      ...(voucherForClient ? { voucher: voucherForClient } : {}),
    };
  });
});

function isValidWorkspaceShamsiDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\\d{4})\\/(\\d{2})\\/(\\d{2})$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1300 || year > 1500 || month < 1 || month > 12) return false;
  const maxDay = month <= 6 ? 31 : 30;
  return day >= 1 && day <= maxDay;
}

/** Server-side reference and fiscal-period validation for every workspace-native voucher transition. */
async function validateWorkspaceVoucherReferences(
  tx: FirebaseFirestore.Transaction,
  workspaceId: string,
  voucher: Record<string, unknown>,
  fiscalProfileSnap: FirebaseFirestore.DocumentSnapshot,
  ignoreVoucherId?: string,
): Promise<void> {
  const voucherDate = voucher.date;
  if (voucher.ownerId !== workspaceId
      || !isValidWorkspaceShamsiDate(voucherDate)
      || typeof voucher.description !== 'string' || voucher.description.length > 300
      || !['opening', 'general', 'sales', 'purchase', 'treasury', 'payroll', 'depreciation', 'closing'].includes(String(voucher.voucherType))
      || !['draft', 'permanent'].includes(String(voucher.status))) {
    throw new HttpsError('invalid-argument', 'ساختار پایه سند برای ثبت یا قطعی‌سازی معتبر نیست.');
  }
  const dateFiscalYear = voucherDate.slice(0, 4);
  if (typeof voucher.fiscalYear !== 'string' || voucher.fiscalYear !== dateFiscalYear) {
    throw new HttpsError('invalid-argument', 'سال مالی سند با سال درج‌شده در تاریخ آن مطابقت ندارد.');
  }
  const closedFiscalYears = fiscalProfileSnap.get('closedFiscalYears');
  if (Array.isArray(closedFiscalYears) && closedFiscalYears.includes(dateFiscalYear)) {
    throw new HttpsError('failed-precondition', `سال مالی ${dateFiscalYear} بسته شده است؛ ثبت یا تغییر سند مجاز نیست.`);
  }

  const lines = Array.isArray(voucher.lines) ? voucher.lines as Record<string, unknown>[] : [];
  if (lines.length < 2 || lines.length > 100) {
    throw new HttpsError('invalid-argument', 'تعداد آرتیکل‌های سند معتبر نیست.');
  }
  const totalDebit = voucher.totalDebit;
  const totalCredit = voucher.totalCredit;
  if (typeof totalDebit !== 'number' || !Number.isFinite(totalDebit) || totalDebit <= 0
      || typeof totalCredit !== 'number' || !Number.isFinite(totalCredit) || totalCredit <= 0
      || Math.abs(totalDebit - totalCredit) > 0.000001) {
    throw new HttpsError('failed-precondition', 'جمع بدهکار و بستانکار سند معتبر یا متوازن نیست.');
  }
  let calculatedDebit = 0;
  let calculatedCredit = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || typeof line !== 'object' || Array.isArray(line)
        || typeof line.accountCode !== 'string' || !line.accountCode.trim()
        || typeof line.debit !== 'number' || !Number.isFinite(line.debit) || line.debit < 0
        || typeof line.credit !== 'number' || !Number.isFinite(line.credit) || line.credit < 0
        || (line.debit > 0 && line.credit > 0)
        || (line.debit === 0 && line.credit === 0)
        || (line.partyId !== undefined && typeof line.partyId !== 'string')
        || (line.costCenterId !== undefined && typeof line.costCenterId !== 'string')) {
      throw new HttpsError('invalid-argument', `ساختار مبلغ یا ارجاع آرتیکل ${index + 1} معتبر نیست.`);
    }
    calculatedDebit += line.debit;
    calculatedCredit += line.credit;
  }
  if (Math.abs(calculatedDebit - totalDebit) > 0.000001
      || Math.abs(calculatedCredit - totalCredit) > 0.000001) {
    throw new HttpsError('failed-precondition', 'جمع آرتیکل‌ها با مبالغ کل سند مطابقت ندارد.');
  }
  const accountCodes = [...new Set(lines.map((line) =>
    typeof line?.accountCode === 'string' ? line.accountCode.trim() : ''
  ).filter(Boolean))];
  if (accountCodes.length === 0) {
    throw new HttpsError('invalid-argument', 'کد حساب‌های سند معتبر نیست.');
  }

  if (typeof voucher.referenceId === 'string' && voucher.referenceId.trim()
      && !voucher.reversalOfVoucherId) {
    const duplicateReferenceQuery = migrationDestination(workspaceId, 'vouchers')
      .where('payload.referenceId', '==', voucher.referenceId.trim());
    const duplicateReferences = await tx.get(duplicateReferenceQuery);
    if (duplicateReferences.docs.some((document) =>
      document.id !== ignoreVoucherId && document.get('deleted') !== true
        && !document.get('payload.reversalOfVoucherId')
    )) {
      throw new HttpsError('already-exists', 'برای این مرجع قبلاً سند حسابداری ثبت شده است.');
    }
  }

  const accountCollection = migrationDestination(workspaceId, 'accounts');
  const accountPages = await Promise.all(
    Array.from({ length: Math.ceil(accountCodes.length / 30) }, (_, index) =>
      tx.get(accountCollection.where('payload.code', 'in', accountCodes.slice(index * 30, (index + 1) * 30)))
    ),
  );
  const accountsByCode = new Map<string, Record<string, unknown>>();
  for (const page of accountPages) {
    for (const document of page.docs) {
      const payload = document.get('payload') as Record<string, unknown> | undefined;
      if (payload && payload.ownerId === workspaceId && typeof payload.code === 'string') {
        accountsByCode.set(payload.code, payload);
      }
    }
  }

  const partyIds = [...new Set(lines.map((line) =>
    typeof line?.partyId === 'string' ? line.partyId.trim() : ''
  ).filter(Boolean))];
  const costCenterIds = [...new Set(lines.map((line) =>
    typeof line?.costCenterId === 'string' ? line.costCenterId.trim() : ''
  ).filter(Boolean))];
  const [partySnapshots, costCenterSnapshots] = await Promise.all([
    Promise.all(partyIds.map((id) => tx.get(migrationDestination(workspaceId, 'parties').doc(id)))),
    Promise.all(costCenterIds.map((id) => tx.get(migrationDestination(workspaceId, 'costCenters').doc(id)))),
  ]);
  const partiesById = new Map(partyIds.map((id, index) => [id, partySnapshots[index]]));
  const costCentersById = new Map(costCenterIds.map((id, index) => [id, costCenterSnapshots[index]]));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const rowNumber = index + 1;
    const code = typeof line.accountCode === 'string' ? line.accountCode.trim() : '';
    const account = accountsByCode.get(code);
    if (!account) {
      throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: حساب ${code || 'نامشخص'} در کدینگ تأییدشده فضای کاری وجود ندارد.`);
    }
    if (account.active === false) {
      throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: حساب ${code} غیرفعال است.`);
    }
    if (account.level === 'group' || account.level === 'kol') {
      throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: ثبت مستقیم روی حساب گروه یا کل مجاز نیست.`);
    }

    const requiresParty = account.requiresParty === true
      || (account.requiresParty !== false && ['104', '301', '103', '302'].some((prefix) => code.startsWith(prefix)));
    const partyId = typeof line.partyId === 'string' ? line.partyId.trim() : '';
    if (requiresParty && !partyId) {
      throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: انتخاب طرف‌حساب برای حساب ${code} الزامی است.`);
    }
    if (partyId) {
      const party = partiesById.get(partyId);
      if (!party?.exists || party.get('payload.ownerId') !== workspaceId) {
        throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: طرف‌حساب انتخاب‌شده در فضای کاری یافت نشد.`);
      }
    }

    const costCenterId = typeof line.costCenterId === 'string' ? line.costCenterId.trim() : '';
    if (costCenterId) {
      const costCenter = costCentersById.get(costCenterId);
      if (!costCenter?.exists || costCenter.get('payload.ownerId') !== workspaceId
          || costCenter.get('payload.active') === false) {
        throw new HttpsError('failed-precondition', `ردیف ${rowNumber}: مرکز هزینه معتبر و فعال نیست.`);
      }
    }
  }
}

/** Workspace-native voucher create/finalize. Voucher and fiscal counter commit together. */
export const mutateWorkspaceVoucher = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  const auth = request.auth as CallableAuth | undefined;
  requireVerifiedAuth(auth);
  const { workspaceId, role } = await requireActiveWorkspaceMember(auth);
  if (!['owner', 'finance_manager', 'accountant', 'treasurer'].includes(role)) {
    throw new HttpsError('permission-denied', 'نقش فعلی اجازه ثبت یا قطعی‌سازی سند را ندارد.');
  }
  const operation = request.data?.operation;
  const operationId = request.data?.operationId;
  const documentId = request.data?.documentId;
  const expectedVersion = request.data?.expectedVersion;
  if (!['create', 'update', 'delete', 'finalize', 'reverse'].includes(operation)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId)
      || typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)
      || (['update', 'delete', 'finalize'].includes(String(operation))
        && (!Number.isInteger(expectedVersion) || expectedVersion < 1))) {
    throw new HttpsError('invalid-argument', 'پارامترهای عملیات سند معتبر نیستند.');
  }
  const manifestRef = db.collection('workspaceMigrations').doc(workspaceId);
  const voucherRef = migrationDestination(workspaceId, 'vouchers').doc(documentId);
  const operationRef = db.collection('workspaceWriteOperations').doc(`${workspaceId}_voucher_${operationId}`);
  const counterRef = migrationDestination(workspaceId, 'counters').doc(workspaceId);
  const input = request.data?.data as Record<string, unknown> | undefined;
  const sourceDocumentId = request.data?.sourceDocumentId;
  const expectedSourceVersion = request.data?.expectedSourceVersion;
  if (operation === 'reverse'
      && (typeof sourceDocumentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceDocumentId)
        || !Number.isInteger(expectedSourceVersion) || expectedSourceVersion < 1
        || !input || typeof input.date !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(input.date)
        || typeof input.fiscalYear !== 'string' || !input.fiscalYear || input.fiscalYear.length > 16
        || typeof input.description !== 'string' || input.description.length > 300
        || (input.updatedByDevice !== undefined && (typeof input.updatedByDevice !== 'string' || input.updatedByDevice.length > 64))
        || Object.keys(input).some((key) => !['date', 'fiscalYear', 'description', 'updatedByDevice'].includes(key)))) {
    throw new HttpsError('invalid-argument', 'پارامترهای معکوس‌سازی سند معتبر نیستند.');
  }
  if (operation === 'create' || operation === 'update') {
    if (!input || input.ownerId !== workspaceId || input.status !== 'draft'
        || typeof input.date !== 'string' || typeof input.fiscalYear !== 'string'
        || !input.fiscalYear || input.fiscalYear.length > 16
        || typeof input.description !== 'string' || input.description.length > 300
        || !['opening', 'general', 'sales', 'purchase', 'treasury', 'payroll', 'depreciation', 'closing'].includes(String(input.voucherType))
        || !Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 100
        || Object.keys(input).some((key) => ![
          'ownerId', 'date', 'fiscalYear', 'description', 'voucherType', 'status',
          'totalDebit', 'totalCredit', 'currencyCode', 'exchangeRate',
          'foreignTotalDebit', 'foreignTotalCredit', 'referenceId', 'reversalOfVoucherId',
          'lines', 'updatedByDevice',
        ].includes(key))
        || !/^\d{4}\/\d{2}\/\d{2}$/.test(input.date)
        || input.lines.some((line) => !line || typeof line !== 'object'
          || Object.keys(line as Record<string, unknown>).some((key) => ![
            'accountCode', 'accountTitle', 'partyId', 'partyName', 'costCenterId',
            'description', 'debit', 'credit', 'foreignDebit', 'foreignCredit', 'fxCurrencyCode',
          ].includes(key))
          || typeof (line as Record<string, unknown>).accountCode !== 'string'
          || !(line as Record<string, unknown>).accountCode
          || typeof (line as Record<string, unknown>).debit !== 'number'
          || typeof (line as Record<string, unknown>).credit !== 'number'
          || !Number.isFinite((line as Record<string, unknown>).debit as number)
          || !Number.isFinite((line as Record<string, unknown>).credit as number)
          || ((line as Record<string, unknown>).debit as number) < 0
          || ((line as Record<string, unknown>).credit as number) < 0
          || ((line as Record<string, unknown>).debit as number) > 0 && ((line as Record<string, unknown>).credit as number) > 0)
        || (input.currencyCode !== undefined && (typeof input.currencyCode !== 'string' || input.currencyCode.length > 10))
        || (input.exchangeRate !== undefined && (typeof input.exchangeRate !== 'number' || !Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0))
        || typeof input.totalDebit !== 'number' || typeof input.totalCredit !== 'number'
        || !Number.isFinite(input.totalDebit) || !Number.isFinite(input.totalCredit)
        || Math.abs(input.totalDebit - input.totalCredit) > 0.000001
        || Math.abs((input.lines as Record<string, unknown>[]).reduce((sum, line) => sum + Number(line.debit), 0) - input.totalDebit) > 0.000001
        || Math.abs((input.lines as Record<string, unknown>[]).reduce((sum, line) => sum + Number(line.credit), 0) - input.totalCredit) > 0.000001) {
      throw new HttpsError('invalid-argument', 'سند پیش‌نویس از نظر ساختار یا تراز بدهکار/بستانکار معتبر نیست.');
    }
  }
  const requestHash = createHash('sha256').update(JSON.stringify(stableMigrationValue({
    operation, documentId, expectedVersion: ['update', 'delete', 'finalize'].includes(String(operation)) ? expectedVersion : null,
    data: ['create', 'update'].includes(String(operation)) ? input : null,
    sourceDocumentId: operation === 'reverse' ? request.data?.sourceDocumentId : null,
    sourceExpectedVersion: operation === 'reverse' ? request.data?.expectedSourceVersion : null,
    reversalData: operation === 'reverse' ? input : null,
    integrityHash: operation === 'finalize' ? request.data?.integrityHash : null,
  }))).digest('hex');
  return db.runTransaction(async (tx) => {
    const sourceVoucherRef = operation === 'reverse'
      ? migrationDestination(workspaceId, 'vouchers').doc(String(sourceDocumentId))
      : null;
    const fiscalProfileRef = db.collection('users').doc(workspaceId);
    const [manifest, operationSnap, voucherSnap, counterSnap, sourceVoucherSnap, fiscalProfileSnap] = await Promise.all([
      tx.get(manifestRef), tx.get(operationRef), tx.get(voucherRef), tx.get(counterRef),
      sourceVoucherRef ? tx.get(sourceVoucherRef) : Promise.resolve(null),
      tx.get(fiscalProfileRef),
    ]);
    if (!manifest.exists || manifest.get('status') !== 'verified'
        || manifest.get('coreWritesFrozen') !== true || manifest.get('coreWriteMode') !== 'workspace_native'
        || manifest.get('readBarrier.status') !== 'frozen') {
      throw new HttpsError('failed-precondition', 'نوشتن اسناد در Workspace هنوز فعال نشده است.');
    }
    if (operationSnap.exists) {
      if (operationSnap.get('requestHash') !== requestHash) {
        throw new HttpsError('already-exists', 'شناسه عملیات سند برای درخواست دیگری استفاده شده است.');
      }
      return { status: 'replayed', operationId, version: operationSnap.get('resultVersion'),
        ...(Number(operationSnap.get('resultSourceVersion')) > 0 ? { sourceVersion: operationSnap.get('resultSourceVersion') } : {}),
        voucherNumber: operationSnap.get('voucherNumber') };
    }
    const now = FieldValue.serverTimestamp();
    if (operation === 'update' || operation === 'delete') {
      if (!voucherSnap.exists || voucherSnap.get('deleted') === true) {
        throw new HttpsError('not-found', 'سند موردنظر یافت نشد.');
      }
      const currentVersion = Number(voucherSnap.get('version') || 1);
      if (currentVersion !== expectedVersion) {
        throw new HttpsError('aborted', 'نسخه سند تغییر کرده است؛ ابتدا اطلاعات را تازه‌سازی کنید.', { expectedVersion, currentVersion });
      }
      const currentPayload = voucherSnap.get('payload') as Record<string, unknown>;
      if (currentPayload.status !== 'draft') {
        throw new HttpsError('failed-precondition', 'فقط سند پیش‌نویس قابل ویرایش یا حذف است.');
      }
      if (operation === 'update') {
        await validateWorkspaceVoucherReferences(tx, workspaceId, input!, fiscalProfileSnap, documentId);
      }
      const nextVersion = currentVersion + 1;
      let sourceVersion: number | undefined;
      if (operation === 'delete') {
        const reversalSourceId = typeof currentPayload.reversalOfVoucherId === 'string'
          ? currentPayload.reversalOfVoucherId : null;
        const reversalSourceRef = reversalSourceId
          ? migrationDestination(workspaceId, 'vouchers').doc(reversalSourceId) : null;
        const reversalSourceSnap = reversalSourceRef ? await tx.get(reversalSourceRef) : null;
        if (reversalSourceSnap?.exists && reversalSourceSnap.get('reversedByVoucherId') === documentId) {
          sourceVersion = Number(reversalSourceSnap.get('version') || 1) + 1;
          const sourcePayload = reversalSourceSnap.get('payload') as Record<string, unknown>;
          const nextSourcePayload = { ...sourcePayload, _version: sourceVersion };
          tx.update(reversalSourceRef!, {
            version: sourceVersion, payload: nextSourcePayload,
            sourceHash: workspaceMigrationHash(nextSourcePayload),
            reversedByVoucherId: FieldValue.delete(), reversedAt: FieldValue.delete(), updatedAt: now,
          });
        }
        tx.set(voucherRef, {
          ...voucherSnap.data(), version: nextVersion, deleted: true, updatedAt: now,
          deletedAt: now, deletedBy: auth.uid,
        });
      } else {
        const nextPayload = {
          ...input!, voucherNumber: currentPayload.voucherNumber,
          createdAt: currentPayload.createdAt || voucherSnap.get('createdAt') || now,
          updatedAt: now, _version: nextVersion,
        };
        tx.set(voucherRef, {
          ...voucherSnap.data(), version: nextVersion, deleted: false,
          sourceHash: workspaceMigrationHash(nextPayload), payload: nextPayload, updatedAt: now,
        });
      }
      tx.create(operationRef, {
        workspaceId, uid: auth.uid, collection: 'vouchers', documentId, operation,
        requestHash, resultVersion: nextVersion, resultSourceVersion: sourceVersion ?? null,
        voucherNumber: currentPayload.voucherNumber, createdAt: now,
      });
      return { status: 'committed', operationId, version: nextVersion,
        ...(sourceVersion ? { sourceVersion } : {}), voucherNumber: currentPayload.voucherNumber };
    }
    if (operation === 'reverse') {
      const closedFiscalYears = fiscalProfileSnap?.get('closedFiscalYears');
      if (Array.isArray(closedFiscalYears) && closedFiscalYears.includes(String(input!.fiscalYear))) {
        throw new HttpsError('failed-precondition', 'سال مالی سند معکوس بسته شده است؛ ثبت در این دوره مجاز نیست.');
      }
      if (voucherSnap.exists) throw new HttpsError('already-exists', 'شناسه سند معکوس از قبل وجود دارد.');
      if (!sourceVoucherSnap?.exists || sourceVoucherSnap.get('deleted') === true) {
        throw new HttpsError('not-found', 'سند اصلی برای معکوس‌سازی یافت نشد.');
      }
      const sourceVersion = Number(sourceVoucherSnap.get('version') || 1);
      if (sourceVersion !== expectedSourceVersion) {
        throw new HttpsError('aborted', 'نسخه سند اصلی تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', { expectedVersion: expectedSourceVersion, currentVersion: sourceVersion });
      }
      const sourcePayload = sourceVoucherSnap.get('payload') as Record<string, unknown>;
      if (sourcePayload.status !== 'permanent') {
        throw new HttpsError('failed-precondition', 'فقط سند قطعی قابل معکوس‌سازی است.');
      }
      if (typeof sourcePayload.integrityHash !== 'string'
          || workspaceVoucherIntegrityHash(sourcePayload) !== sourcePayload.integrityHash) {
        throw new HttpsError('failed-precondition', 'مهر اصالت سند اصلی معتبر نیست؛ معکوس‌سازی متوقف شد.');
      }
      if (sourceVoucherSnap.get('reversedByVoucherId')) {
        throw new HttpsError('already-exists', 'برای این سند قبلاً سند معکوس ثبت شده است.');
      }
      const duplicateReversalQuery = migrationDestination(workspaceId, 'vouchers')
        .where('payload.reversalOfVoucherId', '==', String(sourceDocumentId));
      const duplicateReversals = await tx.get(duplicateReversalQuery);
      if (duplicateReversals.docs.some((item) => item.get('deleted') !== true)) {
        throw new HttpsError('already-exists', 'برای این سند قبلاً سند معکوس ثبت شده است.');
      }
      const sourceLines = Array.isArray(sourcePayload.lines) ? sourcePayload.lines as Record<string, unknown>[] : [];
      if (sourceLines.length < 2 || sourceLines.length > 100) {
        throw new HttpsError('failed-precondition', 'ساختار آرتیکل‌های سند اصلی معتبر نیست.');
      }
      const reversalLines = sourceLines.map((line) => ({
        ...line,
        description: `برگشت/اصلاح سند #${sourcePayload.voucherNumber}: ${String(line.description || '').slice(0, 180)}`.slice(0, 300),
        debit: Number(line.credit) || 0,
        credit: Number(line.debit) || 0,
        ...(line.foreignCredit !== undefined ? { foreignDebit: line.foreignCredit } : { foreignDebit: null }),
        ...(line.foreignDebit !== undefined ? { foreignCredit: line.foreignDebit } : { foreignCredit: null }),
      })).map((line) => Object.fromEntries(Object.entries(line).filter(([, value]) => value !== null)));
      const totalDebit = Number(sourcePayload.totalCredit) || 0;
      const totalCredit = Number(sourcePayload.totalDebit) || 0;
      if (Math.abs(totalDebit - totalCredit) > 0.000001
          || Math.abs(reversalLines.reduce((sum, line) => sum + Number(line.debit), 0) - totalDebit) > 0.000001
          || Math.abs(reversalLines.reduce((sum, line) => sum + Number(line.credit), 0) - totalCredit) > 0.000001) {
        throw new HttpsError('failed-precondition', 'تراز سند اصلی برای ایجاد سند معکوس معتبر نیست.');
      }
      const fiscalYear = String(input!.fiscalYear);
      const voucherQuery = migrationDestination(workspaceId, 'vouchers')
        .where('payload.fiscalYear', '==', fiscalYear);
      const existingVouchers = await tx.get(voucherQuery);
      const maxExisting = existingVouchers.docs.reduce((max, item) => Math.max(max, Number(item.get('payload.voucherNumber')) || 0), 0);
      const nextNumber = Math.max(Number(counterSnap.get('payload.lastVoucherNumber')) || 0, maxExisting) + 1;
      const reversalPayload = {
        ownerId: workspaceId,
        date: String(input!.date),
        fiscalYear,
        description: String(input!.description),
        voucherType: 'general',
        status: 'draft',
        totalDebit,
        totalCredit,
        ...(typeof sourcePayload.currencyCode === 'string' ? { currencyCode: sourcePayload.currencyCode } : {}),
        ...(typeof sourcePayload.exchangeRate === 'number' ? { exchangeRate: sourcePayload.exchangeRate } : {}),
        ...(typeof sourcePayload.foreignTotalCredit === 'number' ? { foreignTotalDebit: sourcePayload.foreignTotalCredit } : {}),
        ...(typeof sourcePayload.foreignTotalDebit === 'number' ? { foreignTotalCredit: sourcePayload.foreignTotalDebit } : {}),
        referenceId: String(sourceDocumentId),
        reversalOfVoucherId: String(sourceDocumentId),
        lines: reversalLines,
        voucherNumber: nextNumber,
        createdAt: now, updatedAt: now, _version: 1,
        ...(typeof input!.updatedByDevice === 'string' ? { updatedByDevice: input!.updatedByDevice } : {}),
      };
      await validateWorkspaceVoucherReferences(tx, workspaceId, reversalPayload, fiscalProfileSnap);
      tx.create(voucherRef, {
        workspaceId, sourceCollection: 'vouchers', sourceId: documentId,
        sourceHash: workspaceMigrationHash(reversalPayload), schemaVersion: 1,
        version: 1, deleted: false, payload: reversalPayload, createdAt: now, updatedAt: now,
      });
      tx.set(counterRef, {
        workspaceId, sourceCollection: 'counters', sourceId: 'voucher',
        schemaVersion: 1, version: Number(counterSnap.get('version') || 0) + 1,
        deleted: false, payload: { ownerId: workspaceId, lastVoucherNumber: nextNumber, updatedAt: now },
        createdAt: counterSnap.exists ? counterSnap.get('createdAt') || now : now, updatedAt: now,
      });
      const nextSourcePayload = { ...sourcePayload, _version: sourceVersion + 1 };
      tx.update(sourceVoucherRef!, {
        version: sourceVersion + 1, payload: nextSourcePayload,
        sourceHash: workspaceMigrationHash(nextSourcePayload),
        reversedByVoucherId: documentId, reversedAt: now, updatedAt: now,
      });
      tx.create(operationRef, {
        workspaceId, uid: auth.uid, collection: 'vouchers', documentId, operation,
        requestHash, resultVersion: 1, voucherNumber: nextNumber,
        sourceDocumentId: String(sourceDocumentId), createdAt: now,
      });
      return { status: 'committed', operationId, version: 1, voucherNumber: nextNumber };
    }
    if (operation === 'create') {
      if (voucherSnap.exists) throw new HttpsError('already-exists', 'شناسه سند از قبل وجود دارد.');
      await validateWorkspaceVoucherReferences(tx, workspaceId, input!, fiscalProfileSnap);
      const fiscalYear = String(input!.fiscalYear);
      const voucherQuery = migrationDestination(workspaceId, 'vouchers')
        .where('payload.fiscalYear', '==', fiscalYear);
      const existingVouchers = await tx.get(voucherQuery);
      const maxExisting = existingVouchers.docs.reduce((max, item) => Math.max(max, Number(item.get('payload.voucherNumber')) || 0), 0);
      const nextNumber = Math.max(Number(counterSnap.get('payload.lastVoucherNumber')) || 0, maxExisting) + 1;
      const payload = { ...input!, voucherNumber: nextNumber, createdAt: now, updatedAt: now, _version: 1 };
      tx.create(voucherRef, {
        workspaceId, sourceCollection: 'vouchers', sourceId: documentId,
        sourceHash: workspaceMigrationHash(payload), schemaVersion: 1,
        version: 1, deleted: false, payload, createdAt: now, updatedAt: now,
      });
      tx.set(counterRef, {
        workspaceId, sourceCollection: 'counters', sourceId: 'voucher',
        schemaVersion: 1, version: Number(counterSnap.get('version') || 0) + 1,
        deleted: false, payload: { ownerId: workspaceId, lastVoucherNumber: nextNumber, updatedAt: now },
        createdAt: counterSnap.exists ? counterSnap.get('createdAt') || now : now, updatedAt: now,
      });
      tx.create(operationRef, {
        workspaceId, uid: auth.uid, collection: 'vouchers', documentId, operation,
        requestHash, resultVersion: 1, voucherNumber: nextNumber, createdAt: now,
      });
      return { status: 'committed', operationId, version: 1, voucherNumber: nextNumber };
    }
    if (!voucherSnap.exists || voucherSnap.get('deleted') === true) {
      throw new HttpsError('not-found', 'سند موردنظر یافت نشد.');
    }
    const currentVersion = Number(voucherSnap.get('version') || 1);
    if (currentVersion !== expectedVersion) {
      throw new HttpsError('aborted', 'نسخه سند تغییر کرده است؛ ابتدا اطلاعات را تازه‌سازی کنید.', { expectedVersion, currentVersion });
    }
    const currentPayload = voucherSnap.get('payload') as Record<string, unknown>;
    if (currentPayload.status !== 'draft') throw new HttpsError('failed-precondition', 'فقط سند پیش‌نویس قابل قطعی‌سازی است.');
    await validateWorkspaceVoucherReferences(tx, workspaceId, currentPayload, fiscalProfileSnap, documentId);
    const integrityHash = request.data?.integrityHash;
    if (typeof integrityHash !== 'string' || !/^vseal_[0-9a-f]{16}$/.test(integrityHash)
        || workspaceVoucherIntegrityHash(currentPayload) !== integrityHash) {
      throw new HttpsError('invalid-argument', 'مهر اصالت سند با محتوای فعلی سند تطبیق ندارد.');
    }
    const nextPayload = { ...currentPayload, status: 'permanent', integrityHash, updatedAt: now, _version: currentVersion + 1 };
    tx.set(voucherRef, {
      ...voucherSnap.data(), version: currentVersion + 1,
      sourceHash: workspaceMigrationHash(nextPayload), payload: nextPayload, updatedAt: now,
    });
    tx.create(operationRef, {
      workspaceId, uid: auth.uid, collection: 'vouchers', documentId, operation,
      requestHash, resultVersion: currentVersion + 1, createdAt: now,
    });
    return { status: 'committed', operationId, version: currentVersion + 1, voucherNumber: currentPayload.voucherNumber };
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
    const stagedCollection = migrationDestination(workspaceId, collectionName);
    const staged = stagedCollection.orderBy(FieldPath.documentId());
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
      const refs = page.docs.map((doc) => stagedCollection.doc(doc.id));
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
