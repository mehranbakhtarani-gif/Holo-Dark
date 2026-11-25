/**
 * Offline Document & Attachment Vault (مدیریت اسناد و مدارک آفلاین)
 *
 * Allows attaching images (JPEG/PNG/WEBP) and PDF files to:
 *  - Invoices, Accounting Vouchers, Cheques, Contracts, and General Operations
 *
 * Security & Integrity Guarantees:
 *  - Unique independent attachment ID
 *  - Cryptographic SHA-256 content integrity checksum verified on every read
 *  - Strict MIME-type allowlist & file size cap (10 MB max per document)
 *  - Role-based access control (`standard` | `confidential` | `restricted`)
 *  - 100% offline local persistence via dedicated IndexedDB store (with in-memory fallback)
 */

import { RbacRoleKey } from '../types/accounting';
import { computeSha256Hex } from './moneyMath';

export type AttachmentEntityType =
  | 'invoice'
  | 'voucher'
  | 'cheque'
  | 'contract'
  | 'operation';

export type DocumentSensitivity = 'standard' | 'confidential' | 'restricted';

export interface DocumentAttachmentMeta {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  entityLabel: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sensitivity: DocumentSensitivity;
  uploadedAt: string;
  uploadedBy: string;
  uploadedByRole: RbacRoleKey;
  notes?: string;
}

export interface DocumentAttachmentRecord extends DocumentAttachmentMeta {
  dataUrl: string; // Base64 Data URL stored locally in IndexedDB
}

export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

const VAULT_DB_NAME = 'holoo_apex_document_vault_v1';
const VAULT_DB_VERSION = 1;
const VAULT_STORE = 'attachments';

// In-memory store used automatically in Node test environments or when IndexedDB is unavailable
const memoryVault = new Map<string, DocumentAttachmentRecord>();

export function canRoleAccessSensitivity(
  role: RbacRoleKey,
  sensitivity: DocumentSensitivity
): boolean {
  if (sensitivity === 'standard') return true;
  if (sensitivity === 'confidential') {
    return (
      role === 'finance_manager' ||
      role === 'accountant' ||
      role === 'treasurer' ||
      role === 'auditor_readonly'
    );
  }
  // restricted: finance_manager & independent auditor only
  return role === 'finance_manager' || role === 'auditor_readonly';
}

function isIdbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        const store = db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
        store.createIndex('entityKey', ['entityType', 'entityId'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open Document Vault IndexedDB'));
  });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || 'document';
}

export async function saveDocumentAttachment(params: {
  entityType: AttachmentEntityType;
  entityId: string;
  entityLabel: string;
  fileName: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes?: number;
  sensitivity?: DocumentSensitivity;
  uploadedBy: string;
  uploadedByRole: RbacRoleKey;
  notes?: string;
}): Promise<{ ok: true; meta: DocumentAttachmentMeta } | { ok: false; error: string }> {
  const mime = params.mimeType.toLowerCase().trim();
  if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
    return {
      ok: false,
      error: 'تنها فایل‌های PDF و تصاویر استاندارد (JPEG, PNG, WEBP) مجاز به پیوست هستند.',
    };
  }
  if (!params.entityId.trim()) {
    return { ok: false, error: 'شناسه سند یا عملیات مرتبط الزامی است.' };
  }
  if (!params.dataUrl.startsWith('data:')) {
    return { ok: false, error: 'قالب محتوای فایل معتبر نیست.' };
  }

  const estimatedBytes =
    params.sizeBytes ?? Math.round((params.dataUrl.length * 3) / 4);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: 'حجم فایل پیوست باید کمتر از ۱۰ مگابایت باشد.',
    };
  }

  const sha256 = await computeSha256Hex(params.dataUrl);
  const record: DocumentAttachmentRecord = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    entityType: params.entityType,
    entityId: params.entityId.trim(),
    entityLabel: params.entityLabel.trim() || params.entityId.trim(),
    fileName: sanitizeFileName(params.fileName),
    mimeType: mime,
    sizeBytes: estimatedBytes,
    sha256,
    sensitivity: params.sensitivity || 'standard',
    uploadedAt: new Date().toISOString(),
    uploadedBy: params.uploadedBy,
    uploadedByRole: params.uploadedByRole,
    notes: params.notes?.trim() || undefined,
    dataUrl: params.dataUrl,
  };

  if (isIdbAvailable()) {
    try {
      const db = await openVaultDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readwrite');
        tx.objectStore(VAULT_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      memoryVault.set(record.id, record);
    }
  } else {
    memoryVault.set(record.id, record);
  }

  const { dataUrl: _omit, ...meta } = record;
  return { ok: true, meta };
}

export async function listDocumentAttachments(filter?: {
  entityType?: AttachmentEntityType;
  entityId?: string;
  viewerRole?: RbacRoleKey;
}): Promise<DocumentAttachmentMeta[]> {
  let rows: DocumentAttachmentRecord[] = [];
  if (isIdbAvailable()) {
    try {
      const db = await openVaultDb();
      rows = await new Promise<DocumentAttachmentRecord[]>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readonly');
        const req = tx.objectStore(VAULT_STORE).getAll();
        req.onsuccess = () => resolve((req.result as DocumentAttachmentRecord[]) || []);
        req.onerror = () => reject(req.error);
      });
      db.close();
    } catch {
      rows = Array.from(memoryVault.values());
    }
  } else {
    rows = Array.from(memoryVault.values());
  }

  return rows
    .filter((r) => {
      if (filter?.entityType && r.entityType !== filter.entityType) return false;
      if (filter?.entityId && r.entityId !== filter.entityId) return false;
      if (filter?.viewerRole && !canRoleAccessSensitivity(filter.viewerRole, r.sensitivity)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .map(({ dataUrl: _omit, ...meta }) => meta);
}

/**
 * Retrieves an attachment offline with RBAC enforcement and cryptographic SHA-256 integrity check.
 */
export async function retrieveVerifiedAttachment(
  attachmentId: string,
  viewerRole: RbacRoleKey
): Promise<
  | { ok: true; record: DocumentAttachmentRecord; integrityValid: boolean }
  | { ok: false; error: string }
> {
  let record: DocumentAttachmentRecord | undefined;
  if (isIdbAvailable()) {
    try {
      const db = await openVaultDb();
      record = await new Promise<DocumentAttachmentRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readonly');
        const req = tx.objectStore(VAULT_STORE).get(attachmentId);
        req.onsuccess = () => resolve(req.result as DocumentAttachmentRecord | undefined);
        req.onerror = () => reject(req.error);
      });
      db.close();
    } catch {
      record = memoryVault.get(attachmentId);
    }
  } else {
    record = memoryVault.get(attachmentId);
  }

  if (!record) {
    return { ok: false, error: 'مدرک مورد نظر در بایگانی محلی یافت نشد.' };
  }
  if (!canRoleAccessSensitivity(viewerRole, record.sensitivity)) {
    return {
      ok: false,
      error: 'سطح دسترسی نقش فعلی برای مشاهده این مدرک محرمانه کافی نیست.',
    };
  }

  const recomputed = await computeSha256Hex(record.dataUrl);
  const integrityValid = recomputed === record.sha256;
  return { ok: true, record, integrityValid };
}

export async function deleteDocumentAttachment(
  attachmentId: string,
  operatorRole: RbacRoleKey
): Promise<{ ok: boolean; error?: string }> {
  if (operatorRole !== 'finance_manager' && operatorRole !== 'accountant') {
    return { ok: false, error: 'فقط مدیر مالی یا حسابدار ارشد مجاز به حذف مدرک پیوست هستند.' };
  }
  if (isIdbAvailable()) {
    try {
      const db = await openVaultDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readwrite');
        tx.objectStore(VAULT_STORE).delete(attachmentId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      memoryVault.delete(attachmentId);
    }
  } else {
    memoryVault.delete(attachmentId);
  }
  return { ok: true };
}

/** Test/diagnostics helper to verify tampering detection without altering production DB */
export async function verifyAttachmentRecordIntegrity(
  record: DocumentAttachmentRecord
): Promise<boolean> {
  const hash = await computeSha256Hex(record.dataUrl);
  return hash === record.sha256;
}
