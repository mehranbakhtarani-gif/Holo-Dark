/**
 * Operational Local IndexedDB Engine for Holoo Apex 9.6
 * Elevates IndexedDB from a backup-only store to the primary operational local
 * database with dedicated entity object stores, atomic multi-store commits, and
 * an idempotent multi-device sync outbox.
 */

import {
  Account,
  AuditActivityLog,
  Cheque,
  CompanyProfile,
  CostCenter,
  CurrencyDefinition,
  ExchangeRateEntry,
  FixedAsset,
  ImportDossier,
  Invoice,
  Party,
  Product,
  RbacOperator,
  SalesOrder,
  SubcontractJob,
  Voucher,
} from '../types/accounting';

const OP_DB_NAME = 'holoo_apex_operational_db_v1';
const OP_DB_VERSION = 1;

export const OPERATIONAL_STORES = [
  'meta',
  'accounts',
  'parties',
  'products',
  'vouchers',
  'invoices',
  'cheques',
  'employees',
  'assets',
  'costCenters',
  'currencies',
  'exchangeRates',
  'importDossiers',
  'salesOrders',
  'subcontractJobs',
  'rbacOperators',
  'auditLogs',
  'syncOutbox',
] as const;

export type OperationalStoreName = (typeof OPERATIONAL_STORES)[number];

export interface OperationalWorkspaceData {
  profile: CompanyProfile;
  accounts: Account[];
  parties: Party[];
  products: Product[];
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
  employees: import('../types/accounting').Employee[];
  assets: FixedAsset[];
  costCenters: CostCenter[];
  currencies: CurrencyDefinition[];
  exchangeRates: ExchangeRateEntry[];
  importDossiers: ImportDossier[];
  salesOrders: SalesOrder[];
  subcontractJobs: SubcontractJob[];
  rbacOperators: RbacOperator[];
  auditLogs: AuditActivityLog[];
  localRevision?: number;
  updatedAt?: string;
}

export interface SyncOutboxOperation {
  operationId: string;
  target: 'supabase' | 'firebase';
  workspaceId: string;
  deviceId: string;
  clientRevision: number;
  payloadHash: string;
  createdAt: string;
  retryCount: number;
  status: 'pending' | 'synced' | 'conflict';
}

export interface OperationalDbStats {
  supported: boolean;
  ready: boolean;
  dbName: string;
  storeCount: number;
  totalRecords: number;
  pendingOutboxCount: number;
  localRevision: number;
  lastCommitAt: string | null;
}

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openOperationalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(OP_DB_NAME, OP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const storeName of OPERATIONAL_STORES) {
        if (!db.objectStoreNames.contains(storeName)) {
          if (storeName === 'meta') {
            db.createObjectStore(storeName, { keyPath: 'key' });
          } else if (storeName === 'syncOutbox') {
            const outbox = db.createObjectStore(storeName, { keyPath: 'operationId' });
            outbox.createIndex('status', 'status', { unique: false });
            outbox.createIndex('createdAt', 'createdAt', { unique: false });
          } else {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open operational IndexedDB'));
    req.onblocked = () =>
      reject(new Error('Operational IndexedDB is blocked by another open tab/connection'));
  });
}

function readAllFromStore<T>(tx: IDBTransaction, storeName: OperationalStoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

function replaceStoreContents<T extends { id: string }>(
  tx: IDBTransaction,
  storeName: OperationalStoreName,
  items: T[]
): void {
  const store = tx.objectStore(storeName);
  store.clear();
  for (const item of items) {
    if (item && typeof item.id === 'string' && item.id.length > 0) {
      store.put(item);
    }
  }
}

/**
 * Persists the entire operational accounting dataset atomically in a single
 * IndexedDB readwrite transaction across all entity object stores.
 */
export async function saveOperationalWorkspaceTx(
  data: OperationalWorkspaceData
): Promise<{ localRevision: number; committedAt: string } | null> {
  if (!isIndexedDbAvailable()) return null;
  const db = await openOperationalDb();
  const committedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const entityStores: OperationalStoreName[] = [
      'meta',
      'accounts',
      'parties',
      'products',
      'vouchers',
      'invoices',
      'cheques',
      'employees',
      'assets',
      'costCenters',
      'currencies',
      'exchangeRates',
      'importDossiers',
      'salesOrders',
      'subcontractJobs',
      'rbacOperators',
      'auditLogs',
    ];
    try {
      const tx = db.transaction(entityStores, 'readwrite');
      const metaStore = tx.objectStore('meta');
      const revReq = metaStore.get('workspace_meta');

      let nextRevision = Math.max(1, Number(data.localRevision) || 1);

      revReq.onsuccess = () => {
        const existing = revReq.result as { localRevision?: number } | undefined;
        if (existing && typeof existing.localRevision === 'number') {
          nextRevision = Math.max(nextRevision, existing.localRevision + 1);
        }

        metaStore.put({
          key: 'profile',
          value: data.profile,
          updatedAt: committedAt,
        });
        metaStore.put({
          key: 'workspace_meta',
          localRevision: nextRevision,
          updatedAt: committedAt,
          schemaVersion: OP_DB_VERSION,
        });

        replaceStoreContents(tx, 'accounts', data.accounts);
        replaceStoreContents(tx, 'parties', data.parties);
        replaceStoreContents(tx, 'products', data.products);
        replaceStoreContents(tx, 'vouchers', data.vouchers);
        replaceStoreContents(tx, 'invoices', data.invoices);
        replaceStoreContents(tx, 'cheques', data.cheques);
        replaceStoreContents(tx, 'employees', data.employees);
        replaceStoreContents(tx, 'assets', data.assets);
        replaceStoreContents(tx, 'costCenters', data.costCenters);
        replaceStoreContents(tx, 'currencies', data.currencies);
        replaceStoreContents(tx, 'exchangeRates', data.exchangeRates);
        replaceStoreContents(tx, 'importDossiers', data.importDossiers);
        replaceStoreContents(tx, 'salesOrders', data.salesOrders);
        replaceStoreContents(tx, 'subcontractJobs', data.subcontractJobs);
        replaceStoreContents(tx, 'rbacOperators', data.rbacOperators);
        replaceStoreContents(tx, 'auditLogs', data.auditLogs);
      };

      tx.oncomplete = () => {
        db.close();
        resolve({ localRevision: nextRevision, committedAt });
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('Operational IndexedDB commit failed'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Operational IndexedDB transaction aborted'));
      };
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

/**
 * Atomic Invoice Commit directly in Operational IndexedDB:
 * Writes updated products, voucher, optional Sayadi cheque, and invoice in a
 * SINGLE IndexedDB readwrite transaction. Either all 4 succeed or the entire
 * transaction rolls back cleanly.
 */
export async function commitInvoiceOperationalTx(payload: {
  updatedProducts: Product[];
  voucher?: Voucher;
  cheque?: Cheque;
  invoice: Invoice;
}): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  const db = await openOperationalDb();
  const committedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    try {
      tx = db.transaction(['meta', 'products', 'vouchers', 'cheques', 'invoices'], 'readwrite');
      const prodStore = tx.objectStore('products');
      for (const prod of payload.updatedProducts) {
        prodStore.put(prod);
      }
      if (payload.voucher) {
        tx.objectStore('vouchers').put(payload.voucher);
      }
      if (payload.cheque) {
        tx.objectStore('cheques').put(payload.cheque);
      }
      tx.objectStore('invoices').put(payload.invoice);

      const metaStore = tx.objectStore('meta');
      const revReq = metaStore.get('workspace_meta');
      revReq.onsuccess = () => {
        const existing = revReq.result as { localRevision?: number } | undefined;
        metaStore.put({
          key: 'workspace_meta',
          localRevision: (existing?.localRevision ?? 0) + 1,
          updatedAt: committedAt,
          schemaVersion: OP_DB_VERSION,
        });
      };

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx?.error ?? new Error('Atomic invoice IndexedDB commit failed'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx?.error ?? new Error('Atomic invoice IndexedDB transaction aborted'));
      };
    } catch (err) {
      if (tx) {
        try {
          tx.abort();
        } catch {
          // ignore if transaction already finished/aborted
        }
      }
      db.close();
      reject(err);
    }
  });
}

/**
 * Commits an inventory stocktaking adjustment and its ledger voucher atomically.
 * No in-memory state should be updated unless this transaction completes.
 */
export async function commitInventoryAdjustmentOperationalTx(payload: {
  updatedProducts: Product[];
  voucher?: Voucher;
}): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  const db = await openOperationalDb();
  const committedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    let versionConflict = false;
    try {
      tx = db.transaction(['meta', 'products', 'vouchers'], 'readwrite');
      const productStore = tx.objectStore('products');
      for (const product of payload.updatedProducts) {
        const readRequest = productStore.get(product.id);
        readRequest.onsuccess = () => {
          const existing = readRequest.result as Product | undefined;
          const expectedVersion = Math.max(1, (product._version ?? 2) - 1);
          const liveVersion = existing?._version ?? 1;
          if (!existing || liveVersion !== expectedVersion) {
            versionConflict = true;
            tx?.abort();
            return;
          }
          productStore.put(product);
        };
      }
      if (payload.voucher) {
        tx.objectStore('vouchers').put(payload.voucher);
      }

      const metaStore = tx.objectStore('meta');
      const revisionRequest = metaStore.get('workspace_meta');
      revisionRequest.onsuccess = () => {
        const existing = revisionRequest.result as { localRevision?: number } | undefined;
        metaStore.put({
          key: 'workspace_meta',
          localRevision: (existing?.localRevision ?? 0) + 1,
          updatedAt: committedAt,
          schemaVersion: OP_DB_VERSION,
        });
      };

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx?.error ?? new Error('Atomic inventory adjustment transaction failed'));
      };
      tx.onabort = () => {
        db.close();
        reject(
          versionConflict
            ? new Error('موجودی کالا در دستگاه یا زبانه دیگری تغییر کرده است؛ اطلاعات را تازه‌سازی و انبارگردانی را دوباره اجرا کنید.')
            : tx?.error ?? new Error('Atomic inventory adjustment transaction aborted')
        );
      };
    } catch (err) {
      if (tx) {
        try {
          tx.abort();
        } catch {
          // Ignore an already completed or aborted transaction.
        }
      }
      db.close();
      reject(err);
    }
  });
}

/**
 * Hydrates the full operational workspace from IndexedDB on application boot.
 * Returns null if the operational database has not been seeded yet.
 */
export async function loadOperationalWorkspace(): Promise<OperationalWorkspaceData | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    const db = await openOperationalDb();
    const entityStores: OperationalStoreName[] = [
      'meta',
      'accounts',
      'parties',
      'products',
      'vouchers',
      'invoices',
      'cheques',
      'employees',
      'assets',
      'costCenters',
      'currencies',
      'exchangeRates',
      'importDossiers',
      'salesOrders',
      'subcontractJobs',
      'rbacOperators',
      'auditLogs',
    ];
    const tx = db.transaction(entityStores, 'readonly');
    const [
      metaRows,
      accounts,
      parties,
      products,
      vouchers,
      invoices,
      cheques,
      employees,
      assets,
      costCenters,
      currencies,
      exchangeRates,
      importDossiers,
      salesOrders,
      subcontractJobs,
      rbacOperators,
      auditLogs,
    ] = await Promise.all([
      readAllFromStore<{ key: string; value?: unknown; localRevision?: number; updatedAt?: string }>(
        tx,
        'meta'
      ),
      readAllFromStore<Account>(tx, 'accounts'),
      readAllFromStore<Party>(tx, 'parties'),
      readAllFromStore<Product>(tx, 'products'),
      readAllFromStore<Voucher>(tx, 'vouchers'),
      readAllFromStore<Invoice>(tx, 'invoices'),
      readAllFromStore<Cheque>(tx, 'cheques'),
      readAllFromStore<import('../types/accounting').Employee>(tx, 'employees'),
      readAllFromStore<FixedAsset>(tx, 'assets'),
      readAllFromStore<CostCenter>(tx, 'costCenters'),
      readAllFromStore<CurrencyDefinition>(tx, 'currencies'),
      readAllFromStore<ExchangeRateEntry>(tx, 'exchangeRates'),
      readAllFromStore<ImportDossier>(tx, 'importDossiers'),
      readAllFromStore<SalesOrder>(tx, 'salesOrders'),
      readAllFromStore<SubcontractJob>(tx, 'subcontractJobs'),
      readAllFromStore<RbacOperator>(tx, 'rbacOperators'),
      readAllFromStore<AuditActivityLog>(tx, 'auditLogs'),
    ]);
    db.close();

    const profileRow = metaRows.find((r) => r.key === 'profile');
    const wsMeta = metaRows.find((r) => r.key === 'workspace_meta');
    if (!profileRow?.value || accounts.length === 0) {
      return null;
    }

    return {
      profile: profileRow.value as CompanyProfile,
      accounts,
      parties,
      products,
      vouchers: vouchers.sort((a, b) => a.voucherNumber - b.voucherNumber),
      invoices: invoices.sort((a, b) => b.date.localeCompare(a.date)),
      cheques,
      employees,
      assets,
      costCenters,
      currencies,
      exchangeRates,
      importDossiers,
      salesOrders,
      subcontractJobs,
      rbacOperators,
      auditLogs,
      localRevision: wsMeta?.localRevision ?? 1,
      updatedAt: wsMeta?.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function enqueueSyncOutboxOperation(op: SyncOutboxOperation): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      tx.objectStore('syncOutbox').put(op);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore silently
  }
}

export async function listPendingSyncOutboxOperations(): Promise<SyncOutboxOperation[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const db = await openOperationalDb();
    const tx = db.transaction('syncOutbox', 'readonly');
    const all = await readAllFromStore<SyncOutboxOperation>(tx, 'syncOutbox');
    db.close();
    return all
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function markSyncOutboxOperationStatus(
  operationId: string,
  status: 'synced' | 'conflict'
): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      const store = tx.objectStore('syncOutbox');
      if (status === 'synced') {
        store.delete(operationId);
      } else {
        const req = store.get(operationId);
        req.onsuccess = () => {
          const item = req.result as SyncOutboxOperation | undefined;
          if (item) {
            store.put({ ...item, status, retryCount: item.retryCount + 1 });
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore silently
  }
}

export async function clearPendingSyncOutboxOperations(): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['syncOutbox'], 'readwrite');
      tx.objectStore('syncOutbox').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore silently
  }
}

export async function getOperationalDbStats(): Promise<OperationalDbStats> {
  if (!isIndexedDbAvailable()) {
    return {
      supported: false,
      ready: false,
      dbName: OP_DB_NAME,
      storeCount: 0,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
    };
  }
  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readonly');
    let totalRecords = 0;
    let pendingOutboxCount = 0;
    let localRevision = 0;
    let lastCommitAt: string | null = null;

    for (const storeName of OPERATIONAL_STORES) {
      const rows = await readAllFromStore<Record<string, unknown>>(tx, storeName);
      if (storeName === 'meta') {
        const meta = rows.find((r) => r.key === 'workspace_meta');
        localRevision = Number(meta?.localRevision || 0);
        lastCommitAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : null;
      } else if (storeName === 'syncOutbox') {
        pendingOutboxCount = rows.filter((r) => r.status === 'pending').length;
      } else {
        totalRecords += rows.length;
      }
    }
    db.close();
    return {
      supported: true,
      ready: totalRecords > 0,
      dbName: OP_DB_NAME,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords,
      pendingOutboxCount,
      localRevision,
      lastCommitAt,
    };
  } catch {
    return {
      supported: true,
      ready: false,
      dbName: OP_DB_NAME,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
    };
  }
}

export interface OperationalStoreCount {
  store: OperationalStoreName;
  label: string;
  count: number;
}

export interface OperationalDbDetailedReport extends OperationalDbStats {
  dbVersion: number;
  probeLatencyMs: number;
  outboxBreakdown: {
    pending: number;
    synced: number;
    conflict: number;
    total: number;
  };
  storeBreakdown: OperationalStoreCount[];
  errorMessage: string | null;
}

const OPERATIONAL_STORE_LABELS: Record<OperationalStoreName, string> = {
  meta: 'ابرداده و نسخه محلی (meta)',
  accounts: 'کدینگ حساب‌ها (accounts)',
  parties: 'طرف‌حساب‌ها (parties)',
  products: 'کالاها و انبار (products)',
  vouchers: 'اسناد حسابداری (vouchers)',
  invoices: 'فاکتورها (invoices)',
  cheques: 'چک‌های صیادی (cheques)',
  employees: 'پرسنل و حقوق (employees)',
  assets: 'اموال و دارایی‌ها (assets)',
  costCenters: 'مراکز هزینه (costCenters)',
  currencies: 'ارزها (currencies)',
  exchangeRates: 'نرخ‌های ارز (exchangeRates)',
  importDossiers: 'پرونده‌های واردات (importDossiers)',
  salesOrders: 'سفارش‌ها و باسکول (salesOrders)',
  subcontractJobs: 'پیمانکاری رنگرزی (subcontractJobs)',
  rbacOperators: 'اپراتورها و دسترسی (rbacOperators)',
  auditLogs: 'گزارش فعالیت‌ها (auditLogs)',
  syncOutbox: 'صف خروجی سینک (syncOutbox)',
};

export async function getOperationalDbDetailedReport(): Promise<OperationalDbDetailedReport> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const emptyOutbox = { pending: 0, synced: 0, conflict: 0, total: 0 };

  if (!isIndexedDbAvailable()) {
    return {
      supported: false,
      ready: false,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: 0,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
      probeLatencyMs: 0,
      outboxBreakdown: emptyOutbox,
      storeBreakdown: [],
      errorMessage: 'مرورگر فعلی از IndexedDB پشتیبانی نمی‌کند یا دسترسی محدود شده است.',
    };
  }

  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readonly');
    let totalRecords = 0;
    let localRevision = 0;
    let lastCommitAt: string | null = null;
    const outboxBreakdown = { pending: 0, synced: 0, conflict: 0, total: 0 };
    const storeBreakdown: OperationalStoreCount[] = [];

    for (const storeName of OPERATIONAL_STORES) {
      const rows = await readAllFromStore<Record<string, unknown>>(tx, storeName);
      storeBreakdown.push({
        store: storeName,
        label: OPERATIONAL_STORE_LABELS[storeName],
        count: rows.length,
      });

      if (storeName === 'meta') {
        const meta = rows.find((r) => r.key === 'workspace_meta');
        localRevision = Number(meta?.localRevision || 0);
        lastCommitAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : null;
      } else if (storeName === 'syncOutbox') {
        outboxBreakdown.total = rows.length;
        for (const r of rows) {
          if (r.status === 'pending') outboxBreakdown.pending += 1;
          else if (r.status === 'synced') outboxBreakdown.synced += 1;
          else if (r.status === 'conflict') outboxBreakdown.conflict += 1;
        }
      } else {
        totalRecords += rows.length;
      }
    }

    db.close();
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      supported: true,
      ready: totalRecords > 0,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords,
      pendingOutboxCount: outboxBreakdown.pending,
      localRevision,
      lastCommitAt,
      probeLatencyMs: Math.max(1, Math.round(ended - started)),
      outboxBreakdown,
      storeBreakdown,
      errorMessage: null,
    };
  } catch (err) {
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      supported: true,
      ready: false,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
      probeLatencyMs: Math.max(1, Math.round(ended - started)),
      outboxBreakdown: emptyOutbox,
      storeBreakdown: [],
      errorMessage: err instanceof Error ? err.message : 'خطا در خواندن وضعیت IndexedDB',
    };
  }
}

export const ALL_HOLOO_INDEXED_DBS = [
  OP_DB_NAME,
  'holoo_apex_local_backups_v1',
  'holoo_apex_document_vault_v1',
  'holoo_apex_health_probe_v1',
] as const;

function deleteSingleIndexedDb(dbName: string): Promise<'deleted' | 'blocked' | 'error'> {
  return new Promise((resolve) => {
    if (!isIndexedDbAvailable()) {
      resolve('error');
      return;
    }
    try {
      const req = window.indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve('deleted');
      req.onerror = () => resolve('error');
      req.onblocked = () => resolve('blocked');
    } catch {
      resolve('error');
    }
  });
}

/**
 * Clears all operational IndexedDB stores and deletes all Holoo IndexedDB databases
 * (operational DB, local snapshot vault, document attachment vault, health probe).
 */
export async function wipeAllLocalIndexedDbs(): Promise<{
  deletedDbs: string[];
  blockedDbs: string[];
  failedDbs: string[];
}> {
  const deletedDbs: string[] = [];
  const blockedDbs: string[] = [];
  const failedDbs: string[] = [];

  if (!isIndexedDbAvailable()) {
    return { deletedDbs, blockedDbs, failedDbs: [...ALL_HOLOO_INDEXED_DBS] };
  }

  // First empty every objectStore in the primary operational DB so even blocked handles hold 0 records
  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readwrite');
    for (const storeName of OPERATIONAL_STORES) {
      tx.objectStore(storeName).clear();
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    // proceed directly to deleteDatabase
  }

  for (const name of ALL_HOLOO_INDEXED_DBS) {
    const outcome = await deleteSingleIndexedDb(name);
    if (outcome === 'deleted') deletedDbs.push(name);
    else if (outcome === 'blocked') blockedDbs.push(name);
    else failedDbs.push(name);
  }

  return { deletedDbs, blockedDbs, failedDbs };
}

/**
 * Removes all Holoo Apex localStorage preferences, caches, revisions, and offline outbox entries.
 */
export function clearHolooLocalStorageKeys(options?: { preserveTheme?: boolean }): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const key of keys) {
      if (options?.preserveTheme && (key === 'holoo_theme' || key === 'theme')) {
        continue;
      }
      if (key.startsWith('holoo') || key.startsWith('sbw_') || key.startsWith('atlasris')) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // ignore storage access issues
  }
  return removed;
}

