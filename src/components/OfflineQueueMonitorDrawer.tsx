import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  Database,
  FolderOpen,
  HardDrive,
  Laptop,
  Network,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import { MESH_DEVICES, type SyncQueueStatus, type SyncQueueTarget } from '../lib/localFolderDexieDb';
import { formatShamsiFromIso } from '../lib/dualCloudSync';
import { toPersianDigits } from '../lib/format';

type QueueFilter = 'all' | 'p2p_mesh' | 'local_folder' | 'supabase' | 'failed';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '۰ کیلوبایت';
  if (bytes < 1024 * 1024) {
    return `${toPersianDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
  }
  return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
}

function targetLabel(target: SyncQueueTarget): string {
  if (target === 'p2p_mesh') return 'شبکه P2P (۳ دستگاه)';
  if (target === 'local_folder') return 'پوشه محلی کاربر';
  return 'ابر Supabase';
}

function statusMeta(status: SyncQueueStatus): {
  label: string;
  badgeClass: string;
} {
  switch (status) {
    case 'synced':
      return {
        label: 'تحویل کامل',
        badgeClass:
          'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
      };
    case 'retrying':
      return {
        label: 'در حال ارسال',
        badgeClass:
          'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
      };
    case 'conflict':
      return {
        label: 'نیازمند بررسی / خطا',
        badgeClass:
          'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
      };
    default:
      return {
        label: 'در صف انتظار',
        badgeClass:
          'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
      };
  }
}

export const OfflineQueueMonitorDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  localMesh: LocalFirstMeshController;
  dualCloud: DualCloudSyncController;
  onOpenAuditLog?: () => void;
}> = ({ open, onClose, localMesh, dualCloud, onOpenAuditLog }) => {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [isRetryingAll, setIsRetryingAll] = useState(false);

  const cloudOutboxMapped = useMemo(
    () =>
      dualCloud.outboxItems.map((c) => ({
        operationId: `sb_${c.id}`,
        target: 'supabase' as SyncQueueTarget,
        originDeviceId: localMesh.selectedPeerId || 'local',
        summary: c.summary || 'پشتیبان ابری در صف انتظار Supabase',
        deliveredToPeers: [] as string[],
        requiredPeers: [] as string[],
        status: 'pending' as SyncQueueStatus,
        retryCount: 0,
        errorMessage: dualCloud.lastSupabaseError,
        voucherCount: c.voucherCount,
        invoiceCount: c.invoiceCount,
        productCount: c.productCount,
        createdAt: c.queuedAt,
        updatedAt: c.queuedAt,
        isCloudQueue: true,
      })),
    [dualCloud.outboxItems, dualCloud.lastSupabaseError, localMesh.selectedPeerId]
  );

  const combinedItems = useMemo(() => {
    const dexieMapped = localMesh.dexieOutbox.map((d) => ({
      ...d,
      isCloudQueue: false,
    }));
    const all = [...dexieMapped, ...cloudOutboxMapped].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );

    if (filter === 'all') return all;
    if (filter === 'failed') {
      return all.filter((i) => i.status === 'conflict' || Boolean(i.errorMessage));
    }
    return all.filter((i) => i.target === filter);
  }, [localMesh.dexieOutbox, cloudOutboxMapped, filter]);

  const counts = useMemo(() => {
    const pendingP2P = localMesh.dexieOutbox.filter(
      (i) => i.target === 'p2p_mesh' && i.status !== 'synced'
    ).length;
    const pendingFolder = localMesh.dexieOutbox.filter(
      (i) => i.target === 'local_folder' && i.status !== 'synced'
    ).length;
    const syncedTotal = localMesh.dexieOutbox.filter((i) => i.status === 'synced').length;
    const pendingCloud = dualCloud.pendingQueueCount;
    return { pendingP2P, pendingFolder, pendingCloud, syncedTotal };
  }, [localMesh.dexieOutbox, dualCloud.pendingQueueCount]);

  if (!open) return null;

  const handleRetryAll = async () => {
    setIsRetryingAll(true);
    try {
      await localMesh.retryAllPendingOutbox();
      if (dualCloud.pendingQueueCount > 0) {
        await dualCloud.flushOutboxNow();
      }
    } finally {
      setIsRetryingAll(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/55 backdrop-blur-xs no-print"
      role="dialog"
      aria-modal="true"
      aria-label="مانیتور صف آفلاین و همگام‌سازی سه‌دستگاهی"
    >
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-2xl bg-white dark:bg-slate-950 h-full shadow-2xl border-r border-slate-200 dark:border-slate-800 flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-teal-600/12 dark:bg-teal-500/15 border border-teal-500/25 flex items-center justify-center shrink-0">
              <Database className="w-4 h-4 text-teal-700 dark:text-teal-300" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                مانیتور صف آفلاین (sync_outbox) و رله ۳ دستگاه
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                رصد زنده صف ارسال P2P، نوشتن در پوشه انتخابی کاربر و همگام‌سازی ابری Supabase
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="بستن مانیتور صف"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary KPI Strip + Storage Persistence Banner */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50/70 dark:bg-slate-900/50">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>صف رله P2P</span>
                <Network className="w-3.5 h-3.5 text-teal-600" />
              </div>
              <div className="mt-1.5 text-lg font-bold font-code tabular-nums text-slate-900 dark:text-white">
                {toPersianDigits(counts.pendingP2P)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>صف پوشه محلی</span>
                <FolderOpen className="w-3.5 h-3.5 text-amber-600" />
              </div>
              <div className="mt-1.5 text-lg font-bold font-code tabular-nums text-slate-900 dark:text-white">
                {toPersianDigits(counts.pendingFolder)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>صف ابر Supabase</span>
                <Cloud className="w-3.5 h-3.5 text-sky-600" />
              </div>
              <div className="mt-1.5 text-lg font-bold font-code tabular-nums text-slate-900 dark:text-white">
                {toPersianDigits(counts.pendingCloud)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>تحویل کامل</span>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              </div>
              <div className="mt-1.5 text-lg font-bold font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                {toPersianDigits(counts.syncedTotal)}
              </div>
            </div>
          </div>

          {/* Persistent Storage & Active Path Indicator */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px]">
            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
              <HardDrive className="w-3.5 h-3.5 text-teal-600 shrink-0" />
              <span>
                حافظه دائمی IndexedDB:{' '}
                <strong
                  className={
                    localMesh.storagePersistence.persisted
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }
                >
                  {localMesh.storagePersistence.persisted ? 'محافظت‌شده (Persistent)' : 'فعال'}
                </strong>
              </span>
              {localMesh.storagePersistence.usageBytes > 0 && (
                <span className="text-slate-400 font-code">
                  ({formatBytes(localMesh.storagePersistence.usageBytes)} از{' '}
                  {formatBytes(localMesh.storagePersistence.quotaBytes)})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {localMesh.localFolderStatus.configured &&
                localMesh.localFolderStatus.permission === 'prompt' && (
                  <button
                    type="button"
                    onClick={() => void localMesh.regrantFolderPermission()}
                    className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                  >
                    تایید مجدد پوشه (۱ کلیک)
                  </button>
                )}
              {onOpenAuditLog && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuditLog();
                  }}
                  className="text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                >
                  مشاهده گزارش همگام‌سازی P2P
                </button>
              )}
            </div>
          </div>

          {/* Filter Tabs + Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'all', label: 'همه' },
                  { id: 'p2p_mesh', label: 'شبکه P2P' },
                  { id: 'local_folder', label: 'پوشه محلی' },
                  { id: 'supabase', label: 'ابر Supabase' },
                  { id: 'failed', label: 'خطادار' },
                ] as { id: QueueFilter; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                    filter === tab.id
                      ? 'bg-teal-700 text-white'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleRetryAll()}
                disabled={isRetryingAll}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-semibold disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRetryingAll ? 'animate-spin' : ''}`} />
                <span>تلاش مجدد همه صف</span>
              </button>
              <button
                type="button"
                onClick={() => void localMesh.clearSyncedOutbox()}
                title="پاکسازی آیتم‌های تحویل‌شده"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>پاکسازی ارسال‌شده‌ها</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void localMesh.clearAllOutbox();
                  if (dualCloud.pendingQueueCount > 0) {
                    dualCloud.clearPendingOutbox();
                  }
                }}
                title="پاکسازی کامل صف"
                className="p-1.5 rounded-lg border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {combinedItems.length === 0 ? (
            <div className="py-14 text-center space-y-2">
              <ShieldCheck className="w-10 h-10 text-emerald-500 mx-auto opacity-80" />
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                صف آفلاین کاملاً خالی و همگام است
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-5">
                هر تغییر حسابداری جدید به‌صورت خودکار در حافظه دائمی Dexie، پوشه انتخابی کاربر و صف رله ۳ دستگاه PeerJS ثبت می‌شود.
              </p>
            </div>
          ) : (
            combinedItems.map((item) => {
              const st = statusMeta(item.status);
              return (
                <div
                  key={item.operationId}
                  className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                          {targetLabel(item.target)}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${st.badgeClass}`}
                        >
                          {st.label}
                        </span>
                        {item.retryCount > 0 && (
                          <span className="text-[10px] font-code text-slate-400">
                            تلاش #{toPersianDigits(item.retryCount)}
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-white mt-1.5">
                        {item.summary}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex flex-wrap items-center gap-2 font-code">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatShamsiFromIso(item.updatedAt)}
                        </span>
                        <span>·</span>
                        <span>{toPersianDigits(item.voucherCount)} سند</span>
                        <span>·</span>
                        <span>{toPersianDigits(item.invoiceCount)} فاکتور</span>
                      </div>
                    </div>

                    {item.status !== 'synced' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (item.isCloudQueue) {
                            void dualCloud.flushOutboxNow();
                          } else {
                            void localMesh.retryOutboxItem(item.operationId);
                          }
                        }}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/50 text-[11px] font-semibold"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>ارسال مجدد</span>
                      </button>
                    )}
                  </div>

                  {/* Per-Peer Delivery Indicators for 3-Device Mesh */}
                  {item.target === 'p2p_mesh' && item.requiredPeers.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <span className="text-[10px] text-slate-500 ml-1">وضعیت تحویل به دستگاه‌ها:</span>
                      {item.requiredPeers.map((peerId) => {
                        const dev = MESH_DEVICES.find((d) => d.peerId === peerId);
                        const delivered = item.deliveredToPeers.includes(peerId);
                        return (
                          <span
                            key={peerId}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
                              delivered
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                                : 'bg-slate-50 dark:bg-slate-800/70 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {dev?.deviceType === 'laptop' ? (
                              <Laptop className="w-3 h-3" />
                            ) : (
                              <Smartphone className="w-3 h-3" />
                            )}
                            <span>{dev?.shortLabel || peerId}</span>
                            <span>{delivered ? '✓' : '⏳'}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {item.errorMessage && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{item.errorMessage}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
