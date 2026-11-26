import Dexie, { type Table } from 'dexie';

// ==================== TYPES ====================

export type MeshDevicePeerId =
  | 'holoo-mesh-mehran-laptop'
  | 'holoo-mesh-mehran-phone1'
  | 'holoo-mesh-mehran-phone2';

export interface MeshDeviceProfile {
  peerId: MeshDevicePeerId;
  shortLabel: string;
  fullLabel: string;
  deviceType: 'laptop' | 'phone';
}

export const MESH_DEVICES: readonly MeshDeviceProfile[] = [
  {
    peerId: 'holoo-mesh-mehran-laptop',
    shortLabel: 'لپ‌تاپ مهران',
    fullLabel: 'لپ‌تاپ مهران (ایستگاه اصلی)',
    deviceType: 'laptop',
  },
  {
    peerId: 'holoo-mesh-mehran-phone1',
    shortLabel: 'موبایل مهران',
    fullLabel: 'موبایل من (همگام‌ساز سیار ۱)',
    deviceType: 'phone',
  },
  {
    peerId: 'holoo-mesh-mehran-phone2',
    shortLabel: 'موبایل همکار',
    fullLabel: 'موبایل همکار (همگام‌ساز سیار ۲)',
    deviceType: 'phone',
  },
] as const;

export interface StoredFolderHandleRecord {
  key: 'primary_dir';
  handle: FileSystemDirectoryHandle;
  folderName: string;
  selectedAt: string;
  lastMirroredAt: string | null;
  lastDailySnapshotFile: string | null;
}

export interface TaggedLiveRecord {
  uuid: string;
  collection: string;
  recordId: string;
  deviceId: string;
  updatedAt: string;
  isDeleted: boolean;
  payload: Record<string, unknown>;
}

export type SyncQueueTarget = 'p2p_mesh' | 'local_folder' | 'supabase';
export type SyncQueueStatus = 'pending' | 'retrying' | 'synced' | 'conflict';

export interface MeshSyncOutboxItem {
  id?: number;
  operationId: string;
  target: SyncQueueTarget;
  originDeviceId: string;
  summary: string;
  payloadHash: string;
  snapshotJson?: string;
  deliveredToPeers: string[];
  requiredPeers: string[];
  status: SyncQueueStatus;
  retryCount: number;
  errorMessage?: string | null;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MeshMetaRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface StoragePersistenceInfo {
  supported: boolean;
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
}

export type FolderPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unconfigured';

export interface LocalFolderStatus {
  supported: boolean;
  configured: boolean;
  folderName: string | null;
  permission: FolderPermissionState;
  lastMirroredAt: string | null;
  lastDailySnapshotFile: string | null;
  lastError: string | null;
  fallbackMode: boolean;
}

export type MeshSyncEventType =
  | 'vector_hello'
  | 'state_push'
  | 'state_pull'
  | 'relay_forwarded'
  | 'ack_received'
  | 'auth_rejected'
  | 'peer_error'
  | 'connection_open'
  | 'connection_close';

export type MeshSyncEventStatus = 'success' | 'failed' | 'info';
export type MeshSyncEventDirection = 'inbound' | 'outbound' | 'local';

export interface MeshSyncEventLog {
  id?: number;
  eventId: string;
  timestamp: string;
  peerId: string;
  peerLabel: string;
  eventType: MeshSyncEventType;
  status: MeshSyncEventStatus;
  direction: MeshSyncEventDirection;
  localVectorClock: Record<string, number>;
  remoteVectorClock?: Record<string, number>;
  recordsMerged?: number;
  conflictsResolved?: number;
  summary: string;
  errorDetail?: string | null;
}

// ==================== DEXIE DATABASE ====================

class HolooApexMeshDB extends Dexie {
  folderHandles!: Table<StoredFolderHandleRecord, string>;
  liveRecords!: Table<TaggedLiveRecord, string>;
  syncOutbox!: Table<MeshSyncOutboxItem, number>;
  meshMeta!: Table<MeshMetaRecord, string>;
  meshSyncLogs!: Table<MeshSyncEventLog, number>;

  constructor() {
    super('holoo_apex_mesh_dexie_v1');
    this.version(1).stores({
      folderHandles: 'key, folderName, lastMirroredAt',
      liveRecords: 'uuid, collection, recordId, deviceId, updatedAt, isDeleted',
      syncOutbox: '++id, &operationId, target, status, originDeviceId, createdAt, updatedAt',
      meshMeta: 'key, updatedAt',
    });
    this.version(2).stores({
      folderHandles: 'key, folderName, lastMirroredAt',
      liveRecords: 'uuid, collection, recordId, deviceId, updatedAt, isDeleted',
      syncOutbox: '++id, &operationId, target, status, originDeviceId, createdAt, updatedAt',
      meshMeta: 'key, updatedAt',
      meshSyncLogs: '++id, &eventId, timestamp, peerId, status, eventType',
    });
  }
}

let dbInstance: HolooApexMeshDB | null = null;

export function getMeshDexieDb(): HolooApexMeshDB | null {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return null;
  }
  if (!dbInstance) {
    dbInstance = new HolooApexMeshDB();
  }
  return dbInstance;
}

// ==================== PERSISTENT DEVICE STORAGE ====================

export async function requestPersistentDeviceStorage(): Promise<StoragePersistenceInfo> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { supported: false, persisted: false, usageBytes: 0, quotaBytes: 0 };
  }
  try {
    let persisted = false;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
    }
    if (!persisted && typeof navigator.storage.persist === 'function') {
      persisted = await navigator.storage.persist();
    }
    let usageBytes = 0;
    let quotaBytes = 0;
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      usageBytes = Number(est.usage) || 0;
      quotaBytes = Number(est.quota) || 0;
    }
    return { supported: true, persisted, usageBytes, quotaBytes };
  } catch {
    return { supported: true, persisted: false, usageBytes: 0, quotaBytes: 0 };
  }
}

// ==================== FILE SYSTEM ACCESS API + FALLBACK ====================

type DirectoryHandleWithPermissions = FileSystemDirectoryHandle & {
  queryPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

type WindowWithFSA = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
};

export const LIVE_DB_FILENAME = 'holoo_live_db.json';
const DAILY_SNAPSHOT_PREFIX = 'holoo_daily_';
const MAX_DAILY_SNAPSHOTS = 14;

export function isDirectoryPickerSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as WindowWithFSA;
  return typeof w.showDirectoryPicker === 'function';
}

export async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandle | null
): Promise<FolderPermissionState> {
  if (!handle) return 'unconfigured';
  const h = handle as DirectoryHandleWithPermissions;
  try {
    if (typeof h.queryPermission === 'function') {
      const state = await h.queryPermission({ mode: 'readwrite' });
      if (state === 'granted' || state === 'prompt' || state === 'denied') {
        return state;
      }
    }
    return 'granted';
  } catch {
    return 'prompt';
  }
}

export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle | null
): Promise<FolderPermissionState> {
  if (!handle) return 'unconfigured';
  const h = handle as DirectoryHandleWithPermissions;
  try {
    if (typeof h.requestPermission === 'function') {
      const state = await h.requestPermission({ mode: 'readwrite' });
      if (state === 'granted' || state === 'prompt' || state === 'denied') {
        return state;
      }
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function loadStoredDirectoryHandle(): Promise<StoredFolderHandleRecord | null> {
  const db = getMeshDexieDb();
  if (!db) return null;
  try {
    const rec = await db.folderHandles.get('primary_dir');
    return rec ?? null;
  } catch {
    return null;
  }
}

export async function clearStoredDirectoryHandle(): Promise<void> {
  const db = getMeshDexieDb();
  if (!db) return;
  try {
    await db.folderHandles.delete('primary_dir');
  } catch {
    // ignore
  }
}

export async function pickLocalStorageDirectory(): Promise<{
  ok: boolean;
  handle?: FileSystemDirectoryHandle;
  folderName?: string;
  permission: FolderPermissionState;
  fallbackRequired?: boolean;
  error?: string;
}> {
  if (!isDirectoryPickerSupported()) {
    return {
      ok: false,
      permission: 'unsupported',
      fallbackRequired: true,
      error:
        'مرورگر فعلی از انتخاب مستقیم پوشه (File System Access API) پشتیبانی نمی‌کند. حالت جایگزین امن (IndexedDB دائمی + ذخیره در پوشه دانلودها) فعال است.',
    };
  }

  try {
    const w = window as WindowWithFSA;
    const handle = await w.showDirectoryPicker!({
      id: 'holoo_apex_local_data',
      mode: 'readwrite',
      startIn: 'documents',
    });

    const permission = await requestDirectoryPermission(handle);
    if (permission !== 'granted') {
      return {
        ok: false,
        permission,
        error: 'مجوز نوشتن در پوشه انتخابی داده نشد. لطفاً دوباره مجوز را تایید کنید.',
      };
    }

    const db = getMeshDexieDb();
    const nowIso = new Date().toISOString();
    if (db) {
      await db.folderHandles.put({
        key: 'primary_dir',
        handle,
        folderName: handle.name || 'Holoo_Data',
        selectedAt: nowIso,
        lastMirroredAt: null,
        lastDailySnapshotFile: null,
      });
    }

    return {
      ok: true,
      handle,
      folderName: handle.name || 'Holoo_Data',
      permission: 'granted',
    };
  } catch (err) {
    const domErr = err as { name?: string; message?: string };
    if (domErr?.name === 'AbortError') {
      return { ok: false, permission: 'unconfigured', error: 'انتخاب پوشه توسط کاربر لغو شد.' };
    }
    if (domErr?.name === 'SecurityError' || /cross-origin|sub frame|iframe/i.test(domErr?.message || '')) {
      return {
        ok: false,
        permission: 'unsupported',
        fallbackRequired: true,
        error:
          'انتخاب مستقیم پوشه در نمای پنجره تودرتو (iframe) محدود است. برای انتخاب پوشه، برنامه را در تب مستقل (یا PWA نصب‌شده) باز کنید یا از دکمه «ذخیره در پوشه دانلودها» استفاده نمایید.',
      };
    }
    return {
      ok: false,
      permission: 'denied',
      fallbackRequired: true,
      error: domErr?.message || 'خطا در دسترسی به پوشه محلی دستگاه.',
    };
  }
}

async function writeTextFileToDirectory(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  content: string
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function pruneOldDailySnapshots(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  const h = dirHandle as DirectoryHandleWithPermissions;
  if (typeof h.entries !== 'function') return;
  try {
    const dailyFiles: string[] = [];
    for await (const [name, entry] of h.entries()) {
      if (entry.kind === 'file' && name.startsWith(DAILY_SNAPSHOT_PREFIX) && name.endsWith('.json')) {
        dailyFiles.push(name);
      }
    }
    dailyFiles.sort((a, b) => b.localeCompare(a));
    const stale = dailyFiles.slice(MAX_DAILY_SNAPSHOTS);
    for (const fileName of stale) {
      try {
        await dirHandle.removeEntry(fileName);
      } catch {
        // ignore individual delete errors
      }
    }
  } catch {
    // ignore listing errors on restricted filesystems
  }
}

export async function writeMirrorToSelectedFolder(
  dirHandle: FileSystemDirectoryHandle,
  snapshotJson: string
): Promise<{
  ok: boolean;
  mirroredAt?: string;
  dailySnapshotFile?: string;
  permissionNeeded?: boolean;
  error?: string;
}> {
  const perm = await queryDirectoryPermission(dirHandle);
  if (perm !== 'granted') {
    return {
      ok: false,
      permissionNeeded: true,
      error: 'نیاز به تایید مجدد دسترسی پوشه انتخابی است (با یک کلیک مجوز را فعال کنید).',
    };
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const dateStamp = nowIso.slice(0, 10);
    const dailyFile = `${DAILY_SNAPSHOT_PREFIX}${dateStamp}.json`;

    await writeTextFileToDirectory(dirHandle, LIVE_DB_FILENAME, snapshotJson);
    await writeTextFileToDirectory(dirHandle, dailyFile, snapshotJson);
    void pruneOldDailySnapshots(dirHandle);

    const db = getMeshDexieDb();
    if (db) {
      const existing = await db.folderHandles.get('primary_dir');
      await db.folderHandles.put({
        key: 'primary_dir',
        handle: dirHandle,
        folderName: existing?.folderName || dirHandle.name || 'Holoo_Data',
        selectedAt: existing?.selectedAt || nowIso,
        lastMirroredAt: nowIso,
        lastDailySnapshotFile: dailyFile,
      });
    }

    return {
      ok: true,
      mirroredAt: nowIso,
      dailySnapshotFile: dailyFile,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'خطا در نوشتن فایل پایگاه داده داخل پوشه محلی.',
    };
  }
}

export async function readMirrorFromSelectedFolder(
  dirHandle: FileSystemDirectoryHandle
): Promise<{
  ok: boolean;
  snapshotJson?: string;
  modifiedAt?: string;
  sizeBytes?: number;
  permissionNeeded?: boolean;
  error?: string;
}> {
  const perm = await queryDirectoryPermission(dirHandle);
  if (perm !== 'granted') {
    return {
      ok: false,
      permissionNeeded: true,
      error: 'برای خواندن از پوشه انتخابی، ابتدا روی «تایید مجدد دسترسی پوشه» کلیک کنید.',
    };
  }

  try {
    const fileHandle = await dirHandle.getFileHandle(LIVE_DB_FILENAME, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = safeParseJsonObject(text);
    if (!parsed) {
      return { ok: false, error: 'ساختار فایل holoo_live_db.json معتبر نیست.' };
    }
    return {
      ok: true,
      snapshotJson: JSON.stringify(parsed),
      modifiedAt: new Date(file.lastModified).toISOString(),
      sizeBytes: file.size,
    };
  } catch (err) {
    const domErr = err as { name?: string };
    if (domErr?.name === 'NotFoundError') {
      return {
        ok: false,
        error: `فایل ${LIVE_DB_FILENAME} هنوز در پوشه انتخابی وجود ندارد.`,
      };
    }
    return {
      ok: false,
      error: 'خواندن فایل پایگاه داده از پوشه انتخابی با خطا مواجه شد.',
    };
  }
}

/** Smart mobile/restricted-browser fallback: Save via showSaveFilePicker or direct Downloads file */
export async function saveSnapshotFallbackToDownloads(
  snapshotJson: string,
  suggestedName?: string
): Promise<{ ok: boolean; fileName: string; method: 'save_picker' | 'download'; error?: string }> {
  const datePart = new Date().toISOString().slice(0, 10);
  const fileName = suggestedName || `holoo_live_db_${datePart}.json`;
  const w = typeof window !== 'undefined' ? (window as WindowWithFSA) : null;

  if (w && typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'Holoo Apex Live Database JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(snapshotJson);
      await writable.close();
      return { ok: true, fileName: handle.name || fileName, method: 'save_picker' };
    } catch (err) {
      const domErr = err as { name?: string };
      if (domErr?.name === 'AbortError') {
        return { ok: false, fileName, method: 'save_picker', error: 'ذخیره‌سازی توسط کاربر لغو شد.' };
      }
      // Fall through to standard anchor download if iframe restricts showSaveFilePicker
    }
  }

  try {
    const blob = new Blob([snapshotJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, fileName, method: 'download' };
  } catch {
    return { ok: false, fileName, method: 'download', error: 'دانلود فایل پشتیبان ناموفق بود.' };
  }
}

// ==================== DEXIE OUTBOX (MESH RELAY + FOLDER + CLOUD) ====================

export async function enqueueDexieOutboxItem(
  item: Omit<MeshSyncOutboxItem, 'id' | 'createdAt' | 'updatedAt'>
): Promise<MeshSyncOutboxItem> {
  const nowIso = new Date().toISOString();
  const record: MeshSyncOutboxItem = {
    ...item,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const db = getMeshDexieDb();
  if (!db) return record;

  try {
    const existing = await db.syncOutbox.where('operationId').equals(item.operationId).first();
    if (existing?.id != null) {
      const mergedPeers = Array.from(
        new Set([...(existing.deliveredToPeers || []), ...(item.deliveredToPeers || [])])
      );
      const updated: MeshSyncOutboxItem = {
        ...existing,
        ...item,
        deliveredToPeers: mergedPeers,
        id: existing.id,
        updatedAt: nowIso,
      };
      await db.syncOutbox.put(updated);
      return updated;
    }
    const id = await db.syncOutbox.add(record);
    // Cap history at 120 items to prevent unbounded growth
    const total = await db.syncOutbox.count();
    if (total > 120) {
      const oldest = await db.syncOutbox.orderBy('createdAt').limit(total - 120).toArray();
      const syncedIds = oldest
        .filter((o) => o.status === 'synced' && o.id != null)
        .map((o) => o.id as number);
      if (syncedIds.length > 0) {
        await db.syncOutbox.bulkDelete(syncedIds);
      }
    }
    return { ...record, id };
  } catch {
    return record;
  }
}

export function isDurableOutboxItemVerified(
  persisted: Pick<MeshSyncOutboxItem, 'target' | 'payloadHash' | 'snapshotJson' | 'requiredPeers' | 'deliveredToPeers'> | null | undefined,
  expected: Pick<MeshSyncOutboxItem, 'target' | 'payloadHash' | 'snapshotJson' | 'requiredPeers' | 'deliveredToPeers'>
): boolean {
  return Boolean(
    persisted &&
    persisted.target === expected.target &&
    persisted.payloadHash === expected.payloadHash &&
    persisted.snapshotJson === expected.snapshotJson &&
    expected.requiredPeers.every((peerId) => persisted.requiredPeers.includes(peerId)) &&
    expected.deliveredToPeers.every((peerId) => persisted.deliveredToPeers.includes(peerId))
  );
}

/**
 * Strict outbox write used by the mesh receive path. Legacy enqueue remains
 * best-effort for UI/background callers; inbound relay ACKs require a verified
 * record in IndexedDB before the operation can be acknowledged upstream.
 */
export async function enqueueDexieOutboxItemDurably(
  item: Omit<MeshSyncOutboxItem, 'id' | 'createdAt' | 'updatedAt'>
): Promise<MeshSyncOutboxItem> {
  const db = getMeshDexieDb();
  if (!db) throw new Error('Mesh IndexedDB is unavailable; outbox operation was not persisted');

  await enqueueDexieOutboxItem(item);
  const persisted = await db.syncOutbox.where('operationId').equals(item.operationId).first();
  if (!persisted || !isDurableOutboxItemVerified(persisted, item)) {
    throw new Error('Mesh outbox persistence verification failed');
  }
  return persisted;
}

export async function listDexieOutboxItems(): Promise<MeshSyncOutboxItem[]> {
  const db = getMeshDexieDb();
  if (!db) return [];
  try {
    const rows = await db.syncOutbox.orderBy('updatedAt').reverse().toArray();
    return rows;
  } catch {
    return [];
  }
}

export async function updateDexieOutboxItem(
  operationId: string,
  patch: Partial<Omit<MeshSyncOutboxItem, 'id' | 'operationId'>>
): Promise<void> {
  const db = getMeshDexieDb();
  if (!db) return;
  try {
    const existing = await db.syncOutbox.where('operationId').equals(operationId).first();
    if (!existing || existing.id == null) return;
    await db.syncOutbox.update(existing.id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // ignore
  }
}

export function isAuthorizedOutboxPeerAck(
  item: Pick<MeshSyncOutboxItem, 'target' | 'requiredPeers'>,
  peerId: string
): boolean {
  return item.target === 'p2p_mesh' && item.requiredPeers.includes(peerId);
}

export async function markDexieOutboxPeerDelivered(
  operationId: string,
  peerId: string
): Promise<boolean> {
  const db = getMeshDexieDb();
  if (!db) return false;
  try {
    const existing = await db.syncOutbox.where('operationId').equals(operationId).first();
    if (!existing || existing.id == null || !isAuthorizedOutboxPeerAck(existing, peerId)) {
      return false;
    }
    const delivered = Array.from(new Set([...(existing.deliveredToPeers || []), peerId]));
    const allDelivered =
      existing.requiredPeers.length === 0 ||
      existing.requiredPeers.every((reqPeer) => delivered.includes(reqPeer));
    await db.syncOutbox.update(existing.id, {
      deliveredToPeers: delivered,
      status: allDelivered ? 'synced' : existing.status,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    });
    return allDelivered;
  } catch {
    return false;
  }
}

export async function clearSyncedDexieOutboxItems(): Promise<void> {
  const db = getMeshDexieDb();
  if (!db) return;
  try {
    const synced = await db.syncOutbox.where('status').equals('synced').toArray();
    const ids = synced.map((s) => s.id).filter((id): id is number => typeof id === 'number');
    if (ids.length > 0) {
      await db.syncOutbox.bulkDelete(ids);
    }
  } catch {
    // ignore
  }
}

export async function clearAllDexieOutboxItems(): Promise<void> {
  const db = getMeshDexieDb();
  if (!db) return;
  try {
    await db.syncOutbox.clear();
  } catch {
    // ignore
  }
}

// ==================== PEERJS MESH SYNC EVENT LOGS (AUDIT TRAIL) ====================

export async function appendMeshSyncEventLog(
  event: Omit<MeshSyncEventLog, 'id'>
): Promise<MeshSyncEventLog> {
  const db = getMeshDexieDb();
  if (!db) return event;
  try {
    const id = await db.meshSyncLogs.add(event);
    const total = await db.meshSyncLogs.count();
    if (total > 300) {
      const oldest = await db.meshSyncLogs.orderBy('timestamp').limit(total - 300).toArray();
      const ids = oldest.map((o) => o.id).filter((x): x is number => typeof x === 'number');
      if (ids.length > 0) {
        await db.meshSyncLogs.bulkDelete(ids);
      }
    }
    return { ...event, id };
  } catch {
    return event;
  }
}

export async function listMeshSyncEventLogs(limit = 200): Promise<MeshSyncEventLog[]> {
  const db = getMeshDexieDb();
  if (!db) return [];
  try {
    const rows = await db.meshSyncLogs.orderBy('timestamp').reverse().limit(limit).toArray();
    return rows;
  } catch {
    return [];
  }
}

export async function clearMeshSyncEventLogs(): Promise<void> {
  const db = getMeshDexieDb();
  if (!db) return;
  try {
    await db.meshSyncLogs.clear();
  } catch {
    // ignore
  }
}

// ==================== DETERMINISTIC FIELD-LEVEL LWW MERGE ENGINE ====================

export const SYNCABLE_WORKSPACE_COLLECTIONS = [
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
  'trackedWarehouseTransfers',
] as const;

export interface SyncTaggedEntity extends Record<string, unknown> {
  id: string;
  uuid: string;
  deviceId: string;
  updatedAt: string;
  isDeleted: boolean;
}

export function safeParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw, (key, val) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : val
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Stamps every entity across all accounting collections with deterministic sync metadata
 * (`uuid`, `deviceId`, `updatedAt`, `isDeleted`) while preserving 100% of existing fields.
 */
export function tagSnapshotWithSyncMetadata(
  snapshotJson: string,
  deviceId: string,
  timestampIso?: string
): string {
  const obj = safeParseJsonObject(snapshotJson);
  if (!obj) return snapshotJson;
  const nowIso = timestampIso || new Date().toISOString();

  for (const col of SYNCABLE_WORKSPACE_COLLECTIONS) {
    const arr = obj[col];
    if (!Array.isArray(arr)) continue;
    obj[col] = arr.map((rawItem) => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return rawItem;
      const item = rawItem as Record<string, unknown>;
      const id = String(item.id || item.uuid || `rec_${Math.random().toString(36).slice(2, 10)}`);
      return {
        ...item,
        id,
        uuid: typeof item.uuid === 'string' && item.uuid.length > 0 ? item.uuid : id,
        deviceId:
          typeof item.deviceId === 'string' && item.deviceId.length > 0 ? item.deviceId : deviceId,
        updatedAt: (() => {
          if (typeof item.updatedAt === 'string' && !Number.isNaN(Date.parse(item.updatedAt))) {
            return item.updatedAt;
          }
          const timestamp = item.updatedAt;
          try {
            let date: Date | null = null;
            if (timestamp instanceof Date) {
              date = timestamp;
            } else if (
              timestamp &&
              typeof timestamp === 'object' &&
              typeof (timestamp as { toDate?: unknown }).toDate === 'function'
            ) {
              date = (timestamp as { toDate: () => Date }).toDate();
            }
            if (date && !Number.isNaN(date.getTime())) return date.toISOString();
            return col === 'trackedWarehouseTransfers' ? '1970-01-01T00:00:00.000Z' : nowIso;
          } catch {
            return col === 'trackedWarehouseTransfers' ? '1970-01-01T00:00:00.000Z' : nowIso;
          }
        })(),
        isDeleted: Boolean(item.isDeleted),
      };
    });
  }

  obj._meshSyncMeta = {
    schema: 'holoo_mesh_lww_v1',
    originDeviceId: deviceId,
    updatedAt: nowIso,
  };

  return JSON.stringify(obj);
}

/** Mirror tagged live records into Dexie `liveRecords` store for instant local inspection */
export async function persistTaggedSnapshotToDexie(
  taggedSnapshotJson: string,
  deviceId: string
): Promise<number> {
  const db = getMeshDexieDb();
  if (!db) return 0;
  const obj = safeParseJsonObject(taggedSnapshotJson);
  if (!obj) return 0;

  const nowIso = new Date().toISOString();
  const batch: TaggedLiveRecord[] = [];
  for (const col of SYNCABLE_WORKSPACE_COLLECTIONS) {
    const arr = obj[col];
    if (!Array.isArray(arr)) continue;
    for (const rawItem of arr) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      const recordId = String(item.id || item.uuid || '');
      if (!recordId) continue;
      const uuid = `${col}:${String(item.uuid || recordId)}`;
      batch.push({
        uuid,
        collection: col,
        recordId,
        deviceId: String(item.deviceId || deviceId),
        updatedAt: String(item.updatedAt || nowIso),
        isDeleted: Boolean(item.isDeleted),
        payload: item,
      });
    }
  }

  try {
    await db.transaction('rw', db.liveRecords, db.meshMeta, async () => {
      await db.liveRecords.clear();
      if (batch.length > 0) {
        await db.liveRecords.bulkPut(batch);
      }
      await db.meshMeta.put({
        key: 'last_live_snapshot_meta',
        value: { count: batch.length, deviceId, updatedAt: nowIso },
        updatedAt: nowIso,
      });
    });
    return batch.length;
  } catch {
    return 0;
  }
}

export interface LwwMergeStats {
  mergedSnapshotJson: string;
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  conflictsResolved: number;
  changed: boolean;
}

function stableSerializeForLww(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeForLww).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerializeForLww(record[key])}`
  ).join(',')}}`;
}

function compareLwwWinner(
  a: { updatedAt?: unknown; deviceId?: unknown },
  b: { updatedAt?: unknown; deviceId?: unknown }
): number {
  const tA = typeof a.updatedAt === 'string' ? Date.parse(a.updatedAt) : 0;
  const tB = typeof b.updatedAt === 'string' ? Date.parse(b.updatedAt) : 0;
  const safeA = Number.isFinite(tA) ? tA : 0;
  const safeB = Number.isFinite(tB) ? tB : 0;
  if (safeA !== safeB) return safeA > safeB ? 1 : -1;
  const dA = String(a.deviceId || '');
  const dB = String(b.deviceId || '');
  const deviceOrder = dA.localeCompare(dB);
  if (deviceOrder !== 0) return deviceOrder;
  // Same-device writes can share a millisecond timestamp. Use canonical payload
  // ordering as a final tie-break so merge(A, B) and merge(B, A) choose the same winner.
  return stableSerializeForLww(a).localeCompare(stableSerializeForLww(b));
}

/**
 * Deterministic field-level Last-Write-Wins (LWW) merger across two workspace snapshots.
 * Guarantees all 3 devices converge to the exact same accounting state regardless of sync order.
 */
export function mergeWorkspacesDeterministicLWW(
  localSnapshotJson: string,
  remoteSnapshotJson: string,
  localDeviceId: string
): LwwMergeStats {
  const localObj = safeParseJsonObject(localSnapshotJson);
  const remoteObj = safeParseJsonObject(remoteSnapshotJson);
  if (!localObj || !remoteObj) {
    return {
      mergedSnapshotJson: localSnapshotJson,
      addedCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      conflictsResolved: 0,
      changed: false,
    };
  }

  let addedCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let conflictsResolved = 0;

  const merged: Record<string, unknown> = { ...localObj };

  // Merge CompanyProfile by LWW updatedAt
  const localProfile = (localObj.profile || {}) as Record<string, unknown>;
  const remoteProfile = (remoteObj.profile || {}) as Record<string, unknown>;
  const localMeta = (localObj._meshSyncMeta || {}) as Record<string, unknown>;
  const remoteMeta = (remoteObj._meshSyncMeta || {}) as Record<string, unknown>;
  if (
    Object.keys(remoteProfile).length > 0 &&
    compareLwwWinner(
      { updatedAt: remoteProfile.updatedAt || remoteMeta.updatedAt, deviceId: remoteMeta.originDeviceId },
      { updatedAt: localProfile.updatedAt || localMeta.updatedAt, deviceId: localMeta.originDeviceId || localDeviceId }
    ) > 0
  ) {
    merged.profile = { ...localProfile, ...remoteProfile };
    updatedCount += 1;
  }

  for (const col of SYNCABLE_WORKSPACE_COLLECTIONS) {
    const localArr = Array.isArray(localObj[col]) ? (localObj[col] as Record<string, unknown>[]) : [];
    const remoteArr = Array.isArray(remoteObj[col]) ? (remoteObj[col] as Record<string, unknown>[]) : [];

    const byKey = new Map<string, Record<string, unknown>>();
    for (const item of localArr) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.id || item.uuid || '');
      if (!key) continue;
      byKey.set(key, item);
    }

    for (const rItem of remoteArr) {
      if (!rItem || typeof rItem !== 'object') continue;
      const key = String(rItem.id || rItem.uuid || '');
      if (!key) continue;
      const lItem = byKey.get(key);

      if (!lItem) {
        if (!rItem.isDeleted) {
          byKey.set(key, rItem);
          addedCount += 1;
        }
        continue;
      }

      // Check whether contents actually differ
      const lStr = JSON.stringify(lItem);
      const rStr = JSON.stringify(rItem);
      if (lStr === rStr) continue;

      const cmp = compareLwwWinner(rItem, lItem);
      if (cmp > 0) {
        if (rItem.isDeleted) {
          byKey.delete(key);
          deletedCount += 1;
        } else {
          // Field-level LWW merge: preserve non-undefined local fields absent on remote while remote newer fields win
          const mergedItem: Record<string, unknown> = { ...lItem };
          for (const [k, v] of Object.entries(rItem)) {
            if (v !== undefined) {
              mergedItem[k] = v;
            }
          }
          byKey.set(key, mergedItem);
          updatedCount += 1;
        }
        conflictsResolved += 1;
      } else if (cmp < 0) {
        // Local is newer; keep local fields, fill any missing keys from remote
        if (!lItem.isDeleted) {
          const mergedItem: Record<string, unknown> = { ...rItem, ...lItem };
          byKey.set(key, mergedItem);
        }
        conflictsResolved += 1;
      }
    }

    // Filter out tombstoned items from active operational arrays
    const finalList = Array.from(byKey.values()).filter((item) => !item.isDeleted);
    merged[col] = finalList;
  }

  const changed = addedCount > 0 || updatedCount > 0 || deletedCount > 0;
  const nowIso = new Date().toISOString();
  merged._meshSyncMeta = {
    schema: 'holoo_mesh_lww_v1',
    originDeviceId: localDeviceId,
    updatedAt: nowIso,
  };

  return {
    mergedSnapshotJson: JSON.stringify(merged),
    addedCount,
    updatedCount,
    deletedCount,
    conflictsResolved,
    changed,
  };
}
