import { getTodayShamsi } from './format';
import { computeDeterministicHash256 } from './moneyMath';

export type LocalBackupReason = 'auto_change' | 'before_close' | 'manual' | 'pre_migration';

export interface LocalBackupSnapshotMeta {
  id: string;
  schemaVersion?: number;
  checksum256?: string;
  savedAt: string; // ISO string
  savedAtShamsi: string; // Shamsi date + time
  reason: LocalBackupReason;
  deviceId: string;
  deviceLabel: string;
  companyName: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
  sizeKb: number;
}

export interface LocalBackupSnapshot extends LocalBackupSnapshotMeta {
  payloadJson: string;
}

export interface BackupIntegrityResult {
  valid: boolean;
  checksumVerified: boolean;
  errors: string[];
  warnings: string[];
  parsedSummary?: {
    companyName: string;
    voucherCount: number;
    invoiceCount: number;
    productCount: number;
    accountCount: number;
  };
}

const DB_NAME = 'holoo_apex_local_backups_v1';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const MAX_SNAPSHOTS = 12;

const DEVICE_ID_KEY = 'holoo_apex_device_id_v1';
const DEVICE_LABEL_KEY = 'holoo_apex_device_label_v1';
const LAST_CLOSE_KEY = 'holoo_apex_last_close_snapshot_v1';
const AUTO_CLOSE_PREF_KEY = 'holoo_apex_auto_backup_close_v1';

function detectDefaultDeviceLabel(): string {
  if (typeof window === 'undefined') return 'دستگاه کاری';
  const ua = navigator.userAgent || '';
  const width = window.innerWidth || 1024;
  if (/iPad|Tablet/i.test(ua) || (width >= 640 && width < 1024 && 'ontouchstart' in window)) {
    return 'تبلت مالی';
  }
  if (/Mobile|Android|iPhone/i.test(ua) || width < 640) {
    return 'گوشی موبایل';
  }
  return 'کامپیوتر دسکتاپ';
}

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length >= 6) return existing;
    const generated = `dev_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return `dev_session_${Date.now().toString(36)}`;
  }
}

export function getDeviceLabel(): string {
  try {
    const existing = localStorage.getItem(DEVICE_LABEL_KEY);
    if (existing && existing.trim()) return existing.trim();
    const detected = detectDefaultDeviceLabel();
    localStorage.setItem(DEVICE_LABEL_KEY, detected);
    return detected;
  } catch {
    return detectDefaultDeviceLabel();
  }
}

export function saveDeviceLabel(label: string): string {
  const clean = label.trim().slice(0, 48) || detectDefaultDeviceLabel();
  try {
    localStorage.setItem(DEVICE_LABEL_KEY, clean);
  } catch {
    // ignore storage quota errors
  }
  return clean;
}

export function getAutoBackupOnClosePref(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_CLOSE_PREF_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function setAutoBackupOnClosePref(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CLOSE_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

function openBackupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function buildSnapshotObject(params: {
  payloadJson: string;
  reason: LocalBackupReason;
  companyName: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
}): LocalBackupSnapshot {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  const sizeKb = Math.max(1, Math.round(new Blob([params.payloadJson]).size / 1024));
  const checksum256 = computeDeterministicHash256(params.payloadJson);
  return {
    id: `bak_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    schemaVersion: 2,
    checksum256,
    savedAt: now.toISOString(),
    savedAtShamsi: `${getTodayShamsi()} · ${timeStr}`,
    reason: params.reason,
    deviceId: getOrCreateDeviceId(),
    deviceLabel: getDeviceLabel(),
    companyName: params.companyName,
    voucherCount: params.voucherCount,
    invoiceCount: params.invoiceCount,
    productCount: params.productCount,
    sizeKb,
    payloadJson: params.payloadJson,
  };
}

/**
 * Verifies a local or exported backup snapshot for JSON corruption, checksum tampering,
 * prototype pollution keys, and presence of essential accounting collections.
 */
export function verifyLocalBackupIntegrity(
  snapshot: Pick<LocalBackupSnapshot, 'payloadJson' | 'checksum256' | 'voucherCount'>
): BackupIntegrityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!snapshot || typeof snapshot.payloadJson !== 'string' || !snapshot.payloadJson.trim()) {
    return {
      valid: false,
      checksumVerified: false,
      errors: ['محتوای فایل پشتیبان خالی یا نامعتبر است.'],
      warnings: [],
    };
  }

  let checksumVerified = false;
  if (snapshot.checksum256) {
    const actualHash = computeDeterministicHash256(snapshot.payloadJson);
    if (actualHash !== snapshot.checksum256) {
      errors.push('مهر صحت (Checksum) نسخه پشتیبان مطابقت ندارد؛ فایل ممکن است خراب یا دستکاری شده باشد.');
    } else {
      checksumVerified = true;
    }
  } else {
    warnings.push('این نسخه پشتیبان مربوط به فرمت قدیمی فاقد Checksum است؛ صرفاً سلامت ساختاری JSON بررسی شد.');
  }

  if (/"(__proto__|constructor|prototype)"\s*:/.test(snapshot.payloadJson)) {
    warnings.push('کلیدهای غیرمجاز شیء در JSON شناسایی و هنگام بازیابی پاکسازی خواهند شد.');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(snapshot.payloadJson, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    }) as Record<string, unknown>;
  } catch {
    errors.push('فایل پشتیبان خراب است و JSON آن قابل تجزیه نیست.');
    return { valid: false, checksumVerified, errors, warnings };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('ساختار ریشه نسخه پشتیبان نامعتبر است.');
    return { valid: false, checksumVerified, errors, warnings };
  }

  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : null;
  const vouchers = Array.isArray(parsed.vouchers) ? parsed.vouchers : null;
  const invoices = Array.isArray(parsed.invoices) ? parsed.invoices : [];
  const products = Array.isArray(parsed.products) ? parsed.products : [];

  if (!accounts || accounts.length === 0) {
    errors.push('کدینگ حساب‌ها در فایل پشتیبان یافت نشد یا خالی است.');
  }
  if (!vouchers) {
    errors.push('جدول اسناد حسابداری در فایل پشتیبان یافت نشد.');
  } else if (
    typeof snapshot.voucherCount === 'number' &&
    snapshot.voucherCount > 0 &&
    vouchers.length !== snapshot.voucherCount
  ) {
    errors.push(
      `تعداد اسناد داخل فایل (${vouchers.length}) با متادیتای ثبت‌شده (${snapshot.voucherCount}) همخوانی ندارد.`
    );
  }

  const profileObj = parsed.profile as { companyName?: string } | undefined;

  return {
    valid: errors.length === 0,
    checksumVerified,
    errors,
    warnings,
    parsedSummary: {
      companyName: profileObj?.companyName || 'نامشخص',
      voucherCount: vouchers ? vouchers.length : 0,
      invoiceCount: invoices.length,
      productCount: products.length,
      accountCount: accounts ? accounts.length : 0,
    },
  };
}

/**
 * Synchronous backup flush used on beforeunload / pagehide / visibilitychange so closing the app
 * on mobile, tablet, or desktop ALWAYS saves the latest complete snapshot into internal device storage.
 */
export function saveSyncCloseSnapshot(params: {
  payloadJson: string;
  reason: LocalBackupReason;
  companyName: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
}): LocalBackupSnapshot | null {
  try {
    const snap = buildSnapshotObject(params);
    localStorage.setItem(LAST_CLOSE_KEY, JSON.stringify(snap));
    return snap;
  } catch {
    return null;
  }
}

export function readSyncCloseSnapshot(): LocalBackupSnapshot | null {
  try {
    const raw = localStorage.getItem(LAST_CLOSE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalBackupSnapshot;
    if (parsed && typeof parsed.payloadJson === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function saveLocalSnapshot(params: {
  payloadJson: string;
  reason: LocalBackupReason;
  companyName: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
}): Promise<LocalBackupSnapshotMeta | null> {
  const snap = buildSnapshotObject(params);
  // Always update the synchronous latest-snapshot slot too
  try {
    localStorage.setItem(LAST_CLOSE_KEY, JSON.stringify(snap));
  } catch {
    // ignore quota error on localStorage and rely on IndexedDB
  }

  try {
    const db = await openBackupDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(snap);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Prune oldest snapshots beyond MAX_SNAPSHOTS
    const all = await listLocalSnapshotsRaw(db);
    if (all.length > MAX_SNAPSHOTS) {
      const toDelete = all.slice(MAX_SNAPSHOTS);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        toDelete.forEach((s) => store.delete(s.id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  } catch {
    // Fallback already saved in localStorage
  }

  const { payloadJson: _ignored, ...meta } = snap;
  return meta;
}

function listLocalSnapshotsRaw(db: IDBDatabase): Promise<LocalBackupSnapshot[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = (req.result as LocalBackupSnapshot[]) || [];
      rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listLocalSnapshots(): Promise<LocalBackupSnapshotMeta[]> {
  const syncSnap = readSyncCloseSnapshot();
  try {
    const db = await openBackupDb();
    const rows = await listLocalSnapshotsRaw(db);
    // If sync close snapshot is newer than anything in IndexedDB, promote it into IndexedDB
    if (syncSnap && !rows.some((r) => r.id === syncSnap.id)) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(syncSnap);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      rows.unshift(syncSnap);
      rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    }
    db.close();
    return rows.slice(0, MAX_SNAPSHOTS).map(({ payloadJson: _p, ...meta }) => meta);
  } catch {
    if (syncSnap) {
      const { payloadJson: _p, ...meta } = syncSnap;
      return [meta];
    }
    return [];
  }
}

export async function loadLocalSnapshotPayload(snapshotId: string): Promise<string | null> {
  const syncSnap = readSyncCloseSnapshot();
  if (syncSnap && syncSnap.id === snapshotId) {
    return syncSnap.payloadJson;
  }
  try {
    const db = await openBackupDb();
    const found = await new Promise<LocalBackupSnapshot | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(snapshotId);
      req.onsuccess = () => resolve(req.result as LocalBackupSnapshot | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return found?.payloadJson ?? null;
  } catch {
    return null;
  }
}

export async function deleteLocalSnapshot(snapshotId: string): Promise<void> {
  const syncSnap = readSyncCloseSnapshot();
  if (syncSnap && syncSnap.id === snapshotId) {
    try {
      localStorage.removeItem(LAST_CLOSE_KEY);
    } catch {
      // ignore
    }
  }
  try {
    const db = await openBackupDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(snapshotId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export function downloadBackupFileToDevice(payloadJson: string, fiscalYear: string): void {
  const stamp = getTodayShamsi().replace(/\//g, '-');
  const blob = new Blob([payloadJson], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `holoo-apex-backup-${fiscalYear}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
