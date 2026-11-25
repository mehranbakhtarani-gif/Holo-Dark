import type { ConflictResolutionPolicy } from './dualCloudSync';
import { toPersianDigits } from './format';
import { safeParseJsonObject } from './localFolderDexieDb';

export type SyncConflictDefaultMode = 'ask' | 'keep_local' | 'restore_remote';
export type SyncConflictResolutionChoice = 'keep_local' | 'restore_remote';
export type SyncConflictSource = 'supabase' | 'firebase' | 'p2p_mesh';

export type AccountingConflictCollection =
  | 'vouchers'
  | 'invoices'
  | 'products'
  | 'parties'
  | 'cheques';

export interface SnapshotEntityCounts {
  vouchers: number;
  invoices: number;
  products: number;
  parties: number;
  cheques: number;
  total: number;
}

export interface ConflictingDocPreview {
  collection: AccountingConflictCollection;
  collectionLabel: string;
  id: string;
  title: string;
  conflictKind: 'modified' | 'local_only' | 'remote_only';
  localSummary: string;
  remoteSummary: string;
}

export interface AccountingConflictSummary {
  hasConflicts: boolean;
  totalConflictingDocs: number;
  modifiedCount: number;
  localOnlyCount: number;
  remoteOnlyCount: number;
  localCounts: SnapshotEntityCounts;
  remoteCounts: SnapshotEntityCounts;
  previews: ConflictingDocPreview[];
}

export interface PendingSyncConflict {
  id: string;
  source: SyncConflictSource;
  sourceLabel: string;
  remoteDeviceLabel: string;
  detectedAt: string;
  localRevision: number;
  remoteRevision: number;
  localSnapshotJson: string;
  remoteSnapshotJson: string;
  mergedSnapshotJson?: string;
  summary: AccountingConflictSummary;
}

export const SYNC_CONFLICT_DEFAULT_STORAGE_KEY = 'holoo_apex_sync_conflict_default_v1';

const COLLECTION_META: Array<{
  key: AccountingConflictCollection;
  label: string;
}> = [
  { key: 'vouchers', label: 'سند حسابداری' },
  { key: 'invoices', label: 'فاکتور' },
  { key: 'cheques', label: 'چک صیادی' },
  { key: 'products', label: 'کالا و انبار' },
  { key: 'parties', label: 'طرف‌حساب' },
];

export function loadSyncConflictDefaultMode(): SyncConflictDefaultMode {
  try {
    const val = localStorage.getItem(SYNC_CONFLICT_DEFAULT_STORAGE_KEY);
    if (val === 'keep_local' || val === 'restore_remote' || val === 'ask') {
      return val;
    }
    return 'ask';
  } catch {
    return 'ask';
  }
}

export function saveSyncConflictDefaultMode(mode: SyncConflictDefaultMode): void {
  try {
    localStorage.setItem(SYNC_CONFLICT_DEFAULT_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

export function syncConflictModeToCloudPolicy(
  mode: SyncConflictDefaultMode
): ConflictResolutionPolicy {
  // When 'ask' is active, probe with 'first_write_wins' so server never silently overwrites
  // remote state before the user decides.
  return mode === 'keep_local' ? 'last_write_wins' : 'first_write_wins';
}

export function resolveConflictDecision(mode: SyncConflictDefaultMode): {
  autoResolved: boolean;
  choice: SyncConflictResolutionChoice | null;
} {
  if (mode === 'keep_local') {
    return { autoResolved: true, choice: 'keep_local' };
  }
  if (mode === 'restore_remote') {
    return { autoResolved: true, choice: 'restore_remote' };
  }
  return { autoResolved: false, choice: null };
}

export function getConflictDefaultModeLabel(mode: SyncConflictDefaultMode): string {
  switch (mode) {
    case 'keep_local':
      return 'خودکار: حفظ آخرین تغییر محلی';
    case 'restore_remote':
      return 'خودکار: بازگردانی نسخه ابری / همتا';
    default:
      return 'پرسش از کاربر هنگام بروز تداخل';
  }
}

/** Extracts the root accounting payload object safely (supports top-level or nested `.data`). */
function extractWorkspacePayload(rawJson: string): Record<string, unknown> {
  const parsed = safeParseJsonObject(rawJson);
  if (!parsed) return {};
  if (
    parsed.data &&
    typeof parsed.data === 'object' &&
    !Array.isArray(parsed.data) &&
    !Array.isArray(parsed.vouchers)
  ) {
    return parsed.data as Record<string, unknown>;
  }
  return parsed;
}

function getCollectionArray(
  payload: Record<string, unknown>,
  key: AccountingConflictCollection
): Record<string, unknown>[] {
  const raw = payload[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  );
}

function normalizeRecordForComparison(item: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  const keys = Object.keys(item).sort();
  for (const k of keys) {
    if (
      k === 'updatedAt' ||
      k === 'deviceId' ||
      k === 'uuid' ||
      k === '_version' ||
      k === 'exportedAt'
    ) {
      continue;
    }
    cleaned[k] = item[k];
  }
  return JSON.stringify(cleaned);
}

function formatMoneyMini(amount: unknown): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  return `${toPersianDigits(Math.round(n).toLocaleString('en-US'))} ریال`;
}

function describeAccountingRecord(
  collection: AccountingConflictCollection,
  item: Record<string, unknown>
): { title: string; summary: string } {
  const id = String(item.id || item.uuid || 'بدون‌شناسه');

  if (collection === 'vouchers') {
    const num = item.number != null ? `#${toPersianDigits(String(item.number))}` : id.slice(0, 8);
    const desc = typeof item.description === 'string' && item.description.trim()
      ? item.description.trim().slice(0, 42)
      : 'سند حسابداری';
    const statusLabel =
      item.status === 'final' ? 'قطعی' : item.status === 'draft' ? 'موقت' : String(item.status || 'ثبت‌شده');
    const lines = Array.isArray(item.lines) ? item.lines : [];
    const totalDebit = lines.reduce((sum, ln) => {
      if (ln && typeof ln === 'object') {
        return sum + (Number((ln as Record<string, unknown>).debit) || 0);
      }
      return sum;
    }, 0);
    return {
      title: `سند ${num} — ${desc}`,
      summary: `${statusLabel} · ${toPersianDigits(lines.length)} ردیف · جمع ${formatMoneyMini(totalDebit)}`,
    };
  }

  if (collection === 'invoices') {
    const num = item.number != null ? `#${toPersianDigits(String(item.number))}` : id.slice(0, 8);
    const kind =
      item.type === 'sale'
        ? 'فروش'
        : item.type === 'purchase'
          ? 'خرید'
          : item.type === 'proforma'
            ? 'پیش‌فاکتور'
            : 'فاکتور';
    const partyName = typeof item.partyName === 'string' ? item.partyName.trim() : '';
    const total = item.grandTotal ?? item.totalAmount ?? item.netTotal;
    return {
      title: `فاکتور ${kind} ${num}${partyName ? ` — ${partyName.slice(0, 28)}` : ''}`,
      summary: `جمع کل: ${formatMoneyMini(total)} · تاریخ ${toPersianDigits(String(item.date || '—'))}`,
    };
  }

  if (collection === 'cheques') {
    const serial = item.serial || item.sayadiId || id.slice(0, 8);
    const amount = formatMoneyMini(item.amount);
    const due = item.dueDate ? toPersianDigits(String(item.dueDate)) : '—';
    return {
      title: `چک ${toPersianDigits(String(serial))}`,
      summary: `مبلغ ${amount} · سررسید ${due}`,
    };
  }

  if (collection === 'products') {
    const name = typeof item.name === 'string' ? item.name.trim() : id;
    const stock = item.stock ?? item.quantity ?? 0;
    const price = item.salePrice ?? item.unitPrice ?? 0;
    return {
      title: `کالا: ${name.slice(0, 38)}`,
      summary: `موجودی ${toPersianDigits(String(stock))} · قیمت ${formatMoneyMini(price)}`,
    };
  }

  // parties
  const partyName = typeof item.name === 'string' ? item.name.trim() : id;
  const code = item.code ? ` (${toPersianDigits(String(item.code))})` : '';
  return {
    title: `طرف‌حساب: ${partyName.slice(0, 34)}${code}`,
    summary: `مانده/اعتبار: ${formatMoneyMini(item.openingBalance ?? item.creditLimit ?? 0)}`,
  };
}

/**
 * Compares local and remote accounting workspace snapshots safely (prototype-pollution safe)
 * and builds an actionable Persian summary of conflicting accounting documents.
 */
export function analyzeAccountingSnapshotConflict(
  localSnapshotJson: string,
  remoteSnapshotJson: string
): AccountingConflictSummary {
  const localPayload = extractWorkspacePayload(localSnapshotJson);
  const remotePayload = extractWorkspacePayload(remoteSnapshotJson);

  const localCounts: SnapshotEntityCounts = {
    vouchers: 0,
    invoices: 0,
    products: 0,
    parties: 0,
    cheques: 0,
    total: 0,
  };
  const remoteCounts: SnapshotEntityCounts = {
    vouchers: 0,
    invoices: 0,
    products: 0,
    parties: 0,
    cheques: 0,
    total: 0,
  };

  const modifiedPreviews: ConflictingDocPreview[] = [];
  const otherPreviews: ConflictingDocPreview[] = [];
  let modifiedCount = 0;
  let localOnlyCount = 0;
  let remoteOnlyCount = 0;

  for (const { key, label } of COLLECTION_META) {
    const localItems = getCollectionArray(localPayload, key).filter((i) => !i.isDeleted);
    const remoteItems = getCollectionArray(remotePayload, key).filter((i) => !i.isDeleted);

    localCounts[key] = localItems.length;
    remoteCounts[key] = remoteItems.length;
    localCounts.total += localItems.length;
    remoteCounts.total += remoteItems.length;

    const localMap = new Map<string, Record<string, unknown>>();
    for (const item of localItems) {
      const id = String(item.id || item.uuid || '');
      if (id) localMap.set(id, item);
    }

    const remoteMap = new Map<string, Record<string, unknown>>();
    for (const item of remoteItems) {
      const id = String(item.id || item.uuid || '');
      if (id) remoteMap.set(id, item);
    }

    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    for (const id of allIds) {
      const localItem = localMap.get(id);
      const remoteItem = remoteMap.get(id);

      if (localItem && remoteItem) {
        const localSig = normalizeRecordForComparison(localItem);
        const remoteSig = normalizeRecordForComparison(remoteItem);
        if (localSig !== remoteSig) {
          modifiedCount += 1;
          if (modifiedPreviews.length < 8) {
            const locDesc = describeAccountingRecord(key, localItem);
            const remDesc = describeAccountingRecord(key, remoteItem);
            modifiedPreviews.push({
              collection: key,
              collectionLabel: label,
              id,
              title: locDesc.title,
              conflictKind: 'modified',
              localSummary: locDesc.summary,
              remoteSummary: remDesc.summary,
            });
          }
        }
      } else if (localItem && !remoteItem) {
        localOnlyCount += 1;
        if (otherPreviews.length < 8) {
          const locDesc = describeAccountingRecord(key, localItem);
          otherPreviews.push({
            collection: key,
            collectionLabel: label,
            id,
            title: locDesc.title,
            conflictKind: 'local_only',
            localSummary: locDesc.summary,
            remoteSummary: 'در نسخه ابری / همتا وجود ندارد',
          });
        }
      } else if (!localItem && remoteItem) {
        remoteOnlyCount += 1;
        if (otherPreviews.length < 8) {
          const remDesc = describeAccountingRecord(key, remoteItem);
          otherPreviews.push({
            collection: key,
            collectionLabel: label,
            id,
            title: remDesc.title,
            conflictKind: 'remote_only',
            localSummary: 'در نسخه محلی این دستگاه وجود ندارد',
            remoteSummary: remDesc.summary,
          });
        }
      }
    }
  }

  const totalConflictingDocs = modifiedCount + localOnlyCount + remoteOnlyCount;
  const previews = [...modifiedPreviews, ...otherPreviews].slice(0, 8);

  return {
    hasConflicts: totalConflictingDocs > 0,
    totalConflictingDocs,
    modifiedCount,
    localOnlyCount,
    remoteOnlyCount,
    localCounts,
    remoteCounts,
    previews,
  };
}
