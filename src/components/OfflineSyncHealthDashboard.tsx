import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  Database,
  Flag,
  FolderOpen,
  GitCompareArrows,
  HardDrive,
  Lock,
  Network,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { useOnlineStatus } from '../hooks/usePWAInstall';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import {
  getOperationalDbDetailedReport,
  type OperationalDbDetailedReport,
} from '../lib/operationalDb';
import {
  requestPersistentDeviceStorage,
  type StoragePersistenceInfo,
} from '../lib/localFolderDexieDb';
import { formatShamsiFromIso } from '../lib/dualCloudSync';
import {
  getConflictDefaultModeLabel,
  resolveConflictDecision,
  SYNC_CONFLICT_DEFAULT_STORAGE_KEY,
  syncConflictModeToCloudPolicy,
  type SyncConflictDefaultMode,
} from '../lib/syncConflictResolver';
import { toPersianDigits } from '../lib/format';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

function formatByteSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '۰ کیلوبایت';
  if (bytes < 1024) return `${toPersianDigits(bytes)} بایت`;
  if (bytes < 1024 * 1024) {
    return `${toPersianDigits((bytes / 1024).toFixed(1))} کیلوبایت`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(2))} مگابایت`;
  }
  return `${toPersianDigits((bytes / (1024 * 1024 * 1024)).toFixed(2))} گیگابایت`;
}

function formatIsoToShamsiSafe(isoOrShamsi: string | null | undefined): string {
  if (!isoOrShamsi) return 'ثبت نشده';
  if (isoOrShamsi.includes('T') && isoOrShamsi.includes('-')) {
    return toPersianDigits(formatShamsiFromIso(isoOrShamsi));
  }
  return toPersianDigits(isoOrShamsi);
}

const CONFLICT_MODES: {
  id: SyncConflictDefaultMode;
  label: string;
  shortDesc: string;
}[] = [
  {
    id: 'ask',
    label: 'پرسش تعاملی (ask)',
    shortDesc: 'توقف و نمایش مقایسه پیش از بازنویسی',
  },
  {
    id: 'keep_local',
    label: 'اولویت محلی (LWW)',
    shortDesc: 'حفظ خودکار آخرین تغییر همین دستگاه',
  },
  {
    id: 'restore_remote',
    label: 'اولویت ابر/همتا (FWW)',
    shortDesc: 'بازگردانی خودکار نسخه مرجع سرور یا همتا',
  },
];

export interface OfflineSyncHealthDashboardProps {
  dualCloud?: DualCloudSyncController;
  localMesh?: LocalFirstMeshController;
  onOpenQueueMonitor?: () => void;
  onOpenSystemHealth?: () => void;
  onOpenAuditSyncTab?: () => void;
  compact?: boolean;
  instanceId?: string;
}

export const OfflineSyncHealthDashboard: React.FC<OfflineSyncHealthDashboardProps> = ({
  dualCloud,
  localMesh,
  onOpenQueueMonitor,
  onOpenSystemHealth,
  onOpenAuditSyncTab,
  compact = false,
  instanceId = 'main',
}) => {
  const {
    operationalDbStats,
    lastLocalBackupAt,
    localSnapshots,
    isCloudMode,
    isSyncing,
    deviceId,
    deviceLabel,
    showToast,
  } = useAccounting();

  const isOnline = useOnlineStatus();

  const [idbReport, setIdbReport] = useState<OperationalDbDetailedReport | null>(null);
  const [probingIdb, setProbingIdb] = useState(false);
  const [lastProbedAt, setLastProbedAt] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<StoragePersistenceInfo | null>(null);
  const [requestingPersist, setRequestingPersist] = useState(false);
  const [showAllStores, setShowAllStores] = useState(false);

  const probeIndexedDb = useCallback(async () => {
    setProbingIdb(true);
    try {
      const [detailed, storage] = await Promise.all([
        getOperationalDbDetailedReport(),
        (async (): Promise<StoragePersistenceInfo> => {
          if (localMesh?.storagePersistence) {
            return localMesh.storagePersistence;
          }
          try {
            if (typeof navigator !== 'undefined' && navigator.storage) {
              const persisted = navigator.storage.persisted
                ? await navigator.storage.persisted()
                : false;
              const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
              return {
                supported: true,
                persisted,
                usageBytes: est?.usage ?? 0,
                quotaBytes: est?.quota ?? 0,
              };
            }
          } catch {
            // ignore
          }
          return { supported: false, persisted: false, usageBytes: 0, quotaBytes: 0 };
        })(),
      ]);
      setIdbReport(detailed);
      setStorageInfo(storage);
      setLastProbedAt(
        new Date().toLocaleTimeString('fa-IR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    } finally {
      setProbingIdb(false);
    }
  }, [localMesh?.storagePersistence]);

  useEffect(() => {
    void probeIndexedDb();
  }, [probeIndexedDb, operationalDbStats?.localRevision, localMesh?.dexieRecordCount]);

  const effectiveStorage = localMesh?.storagePersistence ?? storageInfo;

  const handleRequestPersistentStorage = async () => {
    setRequestingPersist(true);
    try {
      const info = await requestPersistentDeviceStorage();
      setStorageInfo(info);
      showToast(
        info.persisted
          ? 'قفل حافظه دائمی (Persistent Storage) برای IndexedDB با موفقیت فعال شد.'
          : 'درخواست حافظه دائمی ثبت شد؛ مرورگر بر اساس سیاست خود مجوز را مدیریت می‌کند.'
      );
      await probeIndexedDb();
    } finally {
      setRequestingPersist(false);
    }
  };

  // ---- Computed Sync Timestamps ----
  const latestPeerSyncAt = useMemo(() => {
    if (!localMesh?.peerStates?.length) return null;
    const timestamps = localMesh.peerStates
      .map((p) => p.lastSyncedAt)
      .filter((t): t is string => Boolean(t))
      .sort()
      .reverse();
    return timestamps[0] || null;
  }, [localMesh?.peerStates]);

  const dexieOutboxBreakdown = useMemo(() => {
    const items = localMesh?.dexieOutbox ?? [];
    let pending = 0;
    let retrying = 0;
    let conflict = 0;
    let synced = 0;
    for (const item of items) {
      if (item.status === 'pending') pending += 1;
      else if (item.status === 'retrying') retrying += 1;
      else if (item.status === 'conflict') conflict += 1;
      else if (item.status === 'synced') synced += 1;
    }
    return { pending, retrying, conflict, synced, total: items.length };
  }, [localMesh?.dexieOutbox]);

  const totalPendingOutbox =
    (dualCloud?.pendingQueueCount ?? 0) +
    (localMesh?.pendingOutboxCount ?? 0) +
    (idbReport?.outboxBreakdown.pending ?? 0);

  // ---- ConflictResolution Live Flags ----
  const activeConflictMode: SyncConflictDefaultMode = dualCloud?.conflictDefaultMode ?? 'ask';
  const activeCloudPolicy =
    dualCloud?.conflictPolicy ?? syncConflictModeToCloudPolicy(activeConflictMode);
  const decisionMeta = resolveConflictDecision(activeConflictMode);
  const hasPendingCloudConflict = Boolean(dualCloud?.pendingConflict);
  const hasPendingMeshConflict = Boolean(localMesh?.pendingMeshConflict);
  const isResolvingAnyConflict = Boolean(
    dualCloud?.isResolvingConflict || localMesh?.isResolvingMeshConflict
  );
  const totalOutboxConflicts =
    dexieOutboxBreakdown.conflict + (idbReport?.outboxBreakdown.conflict ?? 0);

  const conflictFlags = useMemo(
    () => [
      {
        flagKey: 'conflictDefaultMode',
        title: 'حالت پیش‌فرض حل تداخل',
        valueText: getConflictDefaultModeLabel(activeConflictMode),
        codeVal: activeConflictMode,
        tone: activeConflictMode === 'ask' ? ('info' as const) : ('ok' as const),
        hint: `کلید ذخیره: ${SYNC_CONFLICT_DEFAULT_STORAGE_KEY}`,
      },
      {
        flagKey: 'cloudConflictPolicy',
        title: 'سیاست پروتکل ابری (Supabase)',
        valueText:
          activeCloudPolicy === 'last_write_wins'
            ? 'آخرین نوشتن برنده (LWW)'
            : 'محافظت نسخه مرجع (FWW)',
        codeVal: activeCloudPolicy,
        tone: 'ok' as const,
        hint:
          activeConflictMode === 'ask'
            ? 'در حالت ask با FWW بررسی می‌شود تا داده بدون اجازه بازنویسی نشود'
            : 'همگام با حالت انتخابی کاربر',
      },
      {
        flagKey: 'autoResolved',
        title: 'پرچم حل خودکار تداخل',
        valueText: decisionMeta.autoResolved ? 'فعال (بدون توقف)' : 'غیرفعال (تأیید دستی کاربر)',
        codeVal: String(decisionMeta.autoResolved),
        tone: decisionMeta.autoResolved ? ('warn' as const) : ('info' as const),
        hint: decisionMeta.choice
          ? `تصمیم خودکار: ${decisionMeta.choice}`
          : 'در صورت تداخل، پنجره مقایسه اسناد باز می‌شود',
      },
      {
        flagKey: 'pendingCloudConflict',
        title: 'تداخل معلق ابری (Supabase)',
        valueText: hasPendingCloudConflict
          ? `فعال (${toPersianDigits(dualCloud?.pendingConflict?.summary.totalConflictingDocs ?? 0)} سند)`
          : 'پاک (بدون تداخل)',
        codeVal: String(hasPendingCloudConflict),
        tone: hasPendingCloudConflict ? ('error' as const) : ('ok' as const),
        hint: hasPendingCloudConflict
          ? `دستگاه مقابل: ${dualCloud?.pendingConflict?.remoteDeviceLabel}`
          : 'تضاد نسخه‌ای با سرور ثبت نشده است',
      },
      {
        flagKey: 'pendingMeshConflict',
        title: 'تداخل معلق شبکه P2P (Mesh)',
        valueText: hasPendingMeshConflict
          ? `فعال (${toPersianDigits(localMesh?.pendingMeshConflict?.summary.totalConflictingDocs ?? 0)} سند)`
          : 'پاک (بدون تداخل)',
        codeVal: String(hasPendingMeshConflict),
        tone: hasPendingMeshConflict ? ('error' as const) : ('ok' as const),
        hint: hasPendingMeshConflict
          ? `دستگاه همتا: ${localMesh?.pendingMeshConflict?.remoteDeviceLabel}`
          : 'ادغام قطعی LWW بین دستگاه‌ها هم‌تراز است',
      },
      {
        flagKey: 'isResolvingConflict',
        title: 'قفل پردازش حل تداخل (Mutex)',
        valueText: isResolvingAnyConflict ? 'در حال اعمال تصمیم...' : 'آزاد (آماده)',
        codeVal: String(isResolvingAnyConflict),
        tone: isResolvingAnyConflict ? ('warn' as const) : ('ok' as const),
        hint: 'جلوگیری از تداخل همزمان هنگام اعمال نسخه انتخاب‌شده',
      },
      {
        flagKey: 'outboxConflictCount',
        title: 'بسته‌های دارای خطا/تداخل در Outbox',
        valueText:
          totalOutboxConflicts > 0
            ? `${toPersianDigits(totalOutboxConflicts)} بسته نیازمند بررسی`
            : 'صفر (صف سالم)',
        codeVal: String(totalOutboxConflicts),
        tone: totalOutboxConflicts > 0 ? ('error' as const) : ('ok' as const),
        hint: 'شامل صف Dexie P2P و صف IndexedDB عملیاتی',
      },
    ],
    [
      activeConflictMode,
      activeCloudPolicy,
      decisionMeta.autoResolved,
      decisionMeta.choice,
      hasPendingCloudConflict,
      dualCloud?.pendingConflict,
      hasPendingMeshConflict,
      localMesh?.pendingMeshConflict,
      isResolvingAnyConflict,
      totalOutboxConflicts,
    ]
  );

  // ---- Overall Health Classification ----
  const overallHealth = useMemo(() => {
    if (
      !idbReport?.supported ||
      Boolean(idbReport?.errorMessage) ||
      hasPendingCloudConflict ||
      hasPendingMeshConflict ||
      totalOutboxConflicts > 0
    ) {
      return {
        status: 'critical' as const,
        label: 'نیازمند توجه فوری',
        sublabel: hasPendingCloudConflict || hasPendingMeshConflict
          ? 'تداخل همگام‌سازی منتظر تصمیم کاربر است'
          : totalOutboxConflicts > 0
            ? `${toPersianDigits(totalOutboxConflicts)} بسته دارای خطا در صف خروجی`
            : 'خطا در دسترسی به پایگاه داده محلی IndexedDB',
      };
    }
    if (!isOnline || totalPendingOutbox > 0 || !effectiveStorage?.persisted) {
      return {
        status: 'watch' as const,
        label: !isOnline ? 'حالت آفلاین پایدار' : 'پایدار با موارد قابل بهبود',
        sublabel: !isOnline
          ? 'تغییرات در IndexedDB ذخیره و در صف ارسال خودکار ثبت می‌شوند'
          : totalPendingOutbox > 0
            ? `${toPersianDigits(totalPendingOutbox)} بسته در صف انتظار ارسال`
            : 'توصیه می‌شود قفل حافظه دائمی IndexedDB را فعال کنید',
      };
    }
    return {
      status: 'healthy' as const,
      label: 'سالم و همگام',
      sublabel: 'پایگاه داده IndexedDB، صف خروجی و پرچم‌های ConflictResolution کاملاً پایدارند',
    };
  }, [
    idbReport?.supported,
    idbReport?.errorMessage,
    hasPendingCloudConflict,
    hasPendingMeshConflict,
    totalOutboxConflicts,
    isOnline,
    totalPendingOutbox,
    effectiveStorage?.persisted,
  ]);

  const quotaPct = useMemo(() => {
    if (!effectiveStorage || !effectiveStorage.quotaBytes) return 0;
    return Math.min(100, (effectiveStorage.usageBytes / effectiveStorage.quotaBytes) * 100);
  }, [effectiveStorage]);

  const syncChannels = useMemo(
    () => [
      {
        id: 'indexeddb',
        title: 'پایگاه داده عملیاتی IndexedDB',
        subtitle: idbReport?.dbName ?? operationalDbStats?.dbName ?? 'holoo_apex_operational_db_v1',
        lastSync: formatIsoToShamsiSafe(
          idbReport?.lastCommitAt ?? operationalDbStats?.lastCommitAt
        ),
        revision: `نسخه #${toPersianDigits(idbReport?.localRevision ?? operationalDbStats?.localRevision ?? 0)}`,
        statusLabel: idbReport?.ready || operationalDbStats?.ready ? 'آماده و فعال' : 'در حال راه‌اندازی',
        isHealthy: Boolean(idbReport?.supported && !idbReport?.errorMessage),
        icon: Database,
      },
      {
        id: 'local_folder',
        title: 'آینه پوشه محلی دستگاه',
        subtitle: localMesh?.localFolderStatus.folderName
          ? `پوشه: ${localMesh.localFolderStatus.folderName}`
          : 'پوشه انتخابی (File System API)',
        lastSync: formatIsoToShamsiSafe(localMesh?.localFolderStatus.lastMirroredAt),
        revision:
          localMesh?.localFolderStatus.permission === 'granted'
            ? 'مجوز نوشتن فعال'
            : localMesh?.localFolderStatus.permission === 'prompt'
              ? 'نیاز به تأیید مجوز'
              : 'پیکربندی نشده',
        statusLabel:
          localMesh?.localFolderStatus.configured &&
          localMesh.localFolderStatus.permission === 'granted'
            ? 'متصل'
            : 'اختیاری / غیرفعال',
        isHealthy: Boolean(
          localMesh?.localFolderStatus.configured &&
            localMesh.localFolderStatus.permission === 'granted'
        ),
        icon: FolderOpen,
      },
      {
        id: 'p2p_mesh',
        title: 'شبکه همتا-به-همتا (P2P Mesh)',
        subtitle: localMesh?.selectedDeviceProfile
          ? `نقش این دستگاه: ${localMesh.selectedDeviceProfile.fullLabel}`
          : 'همگام‌سازی مستقیم ۳ دستگاه',
        lastSync: formatIsoToShamsiSafe(latestPeerSyncAt),
        revision: `${toPersianDigits(localMesh?.connectedPeerCount ?? 0)} از ${toPersianDigits(localMesh?.peerStates.length ?? 0)} همتا آنلاین`,
        statusLabel: localMesh?.meshSelfOnline
          ? 'آنلاین در مش'
          : localMesh?.selectedPeerId
            ? 'آفلاین / صف رله'
            : 'تنظیم نشده',
        isHealthy: Boolean(localMesh?.meshSelfOnline),
        icon: Network,
      },
      {
        id: 'supabase',
        title: 'ابر مستقل Supabase PostgreSQL',
        subtitle: dualCloud?.supabaseStatus.projectRef
          ? `پروژه ${dualCloud.supabaseStatus.projectRef}`
          : 'پشتیبان‌گیری ابری مستقل',
        lastSync: formatIsoToShamsiSafe(dualCloud?.lastSupabaseSyncAt),
        revision:
          dualCloud && dualCloud.lastSupabaseRevision > 0
            ? `نسخه سرور #${toPersianDigits(dualCloud.lastSupabaseRevision)}`
            : 'بدون نسخه ابری',
        statusLabel: dualCloud?.isSupabaseAuthenticated
          ? dualCloud.supabaseStatus.connected
            ? `متصل${dualCloud.supabaseStatus.latencyMs ? ` (${toPersianDigits(dualCloud.supabaseStatus.latencyMs)}ms)` : ''}`
            : 'عدم دسترسی به سرور'
          : 'غیرفعال',
        isHealthy: Boolean(
          dualCloud?.isSupabaseAuthenticated && dualCloud?.supabaseStatus.connected
        ),
        icon: Cloud,
      },
      {
        id: 'firebase_backup',
        title: 'پشتیبان Firebase و اسنپ‌شات محلی',
        subtitle: isCloudMode ? 'حساب ابری Firebase فعال' : 'ذخیره‌سازی محلی دستگاه',
        lastSync: formatIsoToShamsiSafe(dualCloud?.lastFirebaseBackupAt ?? lastLocalBackupAt),
        revision: `${toPersianDigits(localSnapshots.length)} اسنپ‌شات محلی`,
        statusLabel: isSyncing ? 'در حال همگام‌سازی...' : 'آماده بازیابی',
        isHealthy: Boolean(lastLocalBackupAt || dualCloud?.lastFirebaseBackupAt),
        icon: HardDrive,
      },
    ],
    [
      idbReport,
      operationalDbStats,
      localMesh,
      latestPeerSyncAt,
      dualCloud,
      isCloudMode,
      lastLocalBackupAt,
      localSnapshots.length,
      isSyncing,
    ]
  );

  const visibleStores = useMemo(() => {
    if (!idbReport?.storeBreakdown) return [];
    const sorted = [...idbReport.storeBreakdown].sort((a, b) => b.count - a.count);
    return showAllStores ? sorted : sorted.slice(0, compact ? 6 : 10);
  }, [idbReport?.storeBreakdown, showAllStores, compact]);

  const vectorClockEntries = useMemo(
    () => Object.entries(localMesh?.vectorClock ?? {}),
    [localMesh?.vectorClock]
  );

  return (
    <section
      dir="rtl"
      aria-label="داشبورد وضعیت سلامت سیستم همگام‌سازی آفلاین"
      className="space-y-4"
    >
      {/* Top Header Strip */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-[0_2px_10px_-4px_rgba(15,23,42,0.04)]">
        <div className="flex items-start gap-3.5 min-w-0">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
              overallHealth.status === 'critical'
                ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
                : overallHealth.status === 'watch'
                  ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300'
                  : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {overallHealth.status === 'critical' ? (
              <ShieldAlert className="w-5 h-5" />
            ) : (
              <ShieldCheck className="w-5 h-5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                داشبورد سلامت همگام‌سازی آفلاین و IndexedDB
              </h2>
              <span
                className={`text-xs font-semibold ${
                  overallHealth.status === 'critical'
                    ? 'text-rose-700 dark:text-rose-400'
                    : overallHealth.status === 'watch'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                · {overallHealth.label}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              {overallHealth.sublabel}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
              <span className="inline-flex items-center gap-1 font-medium">
                {isOnline ? (
                  <Wifi className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                )}
                <span>{isOnline ? 'شبکه متصل' : 'حالت کاملاً آفلاین'}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>دستگاه: {deviceLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="font-code tabular-nums">شناسه: {deviceId.slice(0, 10)}</span>
              {lastProbedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-code tabular-nums">
                    آخرین پایش: {toPersianDigits(lastProbedAt)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={snappySpring}
            onClick={() => void probeIndexedDb()}
            disabled={probingIdb}
            className="h-11 sm:h-10 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${probingIdb ? 'animate-spin' : ''}`} />
            <span>{probingIdb ? 'در حال پایش...' : 'بروزرسانی زنده'}</span>
          </motion.button>

          {onOpenQueueMonitor && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={snappySpring}
              onClick={onOpenQueueMonitor}
              className="h-11 sm:h-10 px-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>
                صف آفلاین ({toPersianDigits(totalPendingOutbox)})
              </span>
            </motion.button>
          )}

          {onOpenAuditSyncTab && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={snappySpring}
              onClick={onOpenAuditSyncTab}
              className="h-11 sm:h-10 px-3.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <GitCompareArrows className="w-3.5 h-3.5" />
              <span>نمای کامل</span>
            </motion.button>
          )}

          {onOpenSystemHealth && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={snappySpring}
              onClick={onOpenSystemHealth}
              className="h-11 sm:h-10 px-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>اسکن کل سیستم</span>
            </motion.button>
          )}
        </div>
      </div>

      {/* 3-Card Bento KPI Row: Last Sync · IndexedDB Engine · ConflictResolution Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Last Sync Snapshot */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...snappySpring, delay: 0.02 }}
          className="p-5 rounded-2xl bg-slate-900 dark:bg-indigo-950/90 text-white border border-slate-800 dark:border-indigo-800/70 flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-slate-300">
            <span className="font-medium">آخرین ثبت و همگام‌سازی</span>
            <Clock className="w-4 h-4 text-indigo-300 shrink-0" />
          </div>
          <div className="my-3.5">
            <div className="text-lg sm:text-xl font-bold font-code tabular-nums tracking-tight">
              {formatIsoToShamsiSafe(
                dualCloud?.lastSupabaseSyncAt ||
                  latestPeerSyncAt ||
                  idbReport?.lastCommitAt ||
                  lastLocalBackupAt
              )}
            </div>
            <div className="text-xs text-slate-300 mt-1.5 flex flex-wrap items-center gap-2 font-code tabular-nums">
              <span>نسخه محلی: #{toPersianDigits(idbReport?.localRevision ?? operationalDbStats?.localRevision ?? 0)}</span>
              <span aria-hidden="true">·</span>
              <span>
                نسخه ابر: #{toPersianDigits(dualCloud?.lastSupabaseRevision ?? 0)}
              </span>
            </div>
          </div>
          <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-300">
            <span>صف انتظار کل:</span>
            <span
              className={`font-code tabular-nums font-semibold ${
                totalPendingOutbox > 0 ? 'text-amber-300' : 'text-emerald-300'
              }`}
            >
              {toPersianDigits(totalPendingOutbox)} بسته
            </span>
          </div>
        </motion.div>

        {/* Card 2: IndexedDB Storage Health */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...snappySpring, delay: 0.06 }}
          className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium">وضعیت پایگاه داده IndexedDB</span>
            <span
              className={`font-semibold ${
                idbReport?.ready || operationalDbStats?.ready
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-400'
              }`}
            >
              {idbReport?.supported === false
                ? 'پشتیبانی نمی‌شود'
                : idbReport?.ready || operationalDbStats?.ready
                  ? `سالم · ${toPersianDigits(idbReport?.probeLatencyMs ?? 1)}ms`
                  : 'در انتظار اولین ثبت'}
            </span>
          </div>

          <div className="my-3.5">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold font-code tabular-nums text-slate-900 dark:text-white">
                {toPersianDigits(idbReport?.totalRecords ?? operationalDbStats?.totalRecords ?? 0)}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                رکورد در {toPersianDigits(idbReport?.storeCount ?? operationalDbStats?.storeCount ?? 18)} جدول
              </span>
            </div>

            {/* Quota progress bar */}
            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-code tabular-nums">
                <span>مصرف فضا: {formatByteSize(effectiveStorage?.usageBytes ?? 0)}</span>
                <span>
                  {effectiveStorage?.quotaBytes
                    ? `سقف: ${formatByteSize(effectiveStorage.quotaBytes)} (${toPersianDigits(quotaPct.toFixed(2))}٪)`
                    : 'سقف نامشخص'}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-600 dark:bg-indigo-400 transition-transform"
                  style={{ width: `${Math.max(2, Math.min(100, quotaPct))}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <Lock className="w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
              <span>
                حافظه دائمی:{' '}
                <strong
                  className={
                    effectiveStorage?.persisted
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }
                >
                  {effectiveStorage?.persisted ? 'قفل‌شده (Persistent)' : 'موقت مرورگر'}
                </strong>
              </span>
            </span>
            {!effectiveStorage?.persisted && (
              <button
                type="button"
                disabled={requestingPersist}
                onClick={() => void handleRequestPersistentStorage()}
                className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap cursor-pointer"
              >
                {requestingPersist ? 'در حال فعال‌سازی...' : 'فعال‌سازی قفل'}
              </button>
            )}
          </div>
        </motion.div>

        {/* Card 3: ConflictResolution Flag Summary */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...snappySpring, delay: 0.1 }}
          className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium">وضعیت پرچم‌های ConflictResolution</span>
            <Flag
              className={`w-4 h-4 shrink-0 ${
                hasPendingCloudConflict || hasPendingMeshConflict
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            />
          </div>

          <div className="my-3.5">
            <div className="text-base font-bold text-slate-900 dark:text-white leading-snug">
              {getConflictDefaultModeLabel(activeConflictMode)}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 flex flex-wrap items-center gap-2 font-code">
              <span>Policy: {activeCloudPolicy}</span>
              <span aria-hidden="true">·</span>
              <span>Auto: {decisionMeta.autoResolved ? 'true' : 'false'}</span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
            <span
              className={`font-semibold ${
                hasPendingCloudConflict || hasPendingMeshConflict || totalOutboxConflicts > 0
                  ? 'text-rose-700 dark:text-rose-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {hasPendingCloudConflict || hasPendingMeshConflict
                ? 'تداخل فعال نیازمند تصمیم'
                : totalOutboxConflicts > 0
                  ? `${toPersianDigits(totalOutboxConflicts)} خطای صف Outbox`
                  : 'بدون تداخل معلق'}
            </span>
            <span className="font-code tabular-nums text-slate-500 dark:text-slate-400">
              Dexie: {toPersianDigits(localMesh?.dexieRecordCount ?? 0)} رکورد
            </span>
          </div>
        </motion.div>
      </div>

      {/* Main 12-Col Bento Breakdown: Left/Right Split (Sync Channels & IndexedDB Stores vs ConflictResolution Flags) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        {/* 7-Col: Last Sync Matrix + IndexedDB Object Stores Inspector */}
        <div className="xl:col-span-7 space-y-4 flex flex-col">
          {/* Sync Timestamps Matrix */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  جدول زمانی آخرین همگام‌سازی لایه‌ها
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  پایش همزمان IndexedDB، پوشه محلی، شبکه ۳ دستگاه P2P و ابر
                </p>
              </div>
              <div className="flex items-center gap-2">
                {localMesh?.selectedPeerId && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    transition={snappySpring}
                    onClick={() => void localMesh.triggerP2PSyncNow()}
                    disabled={localMesh.isP2PSyncing}
                    className="h-9 px-3 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    {localMesh.isP2PSyncing ? 'در حال سینک P2P...' : 'سینک P2P'}
                  </motion.button>
                )}
                {dualCloud?.isSupabaseAuthenticated && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    transition={snappySpring}
                    onClick={() => void dualCloud.syncSupabaseNow(false)}
                    disabled={dualCloud.isSupabaseSyncing}
                    className="h-9 px-3 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-200 text-xs font-semibold whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    {dualCloud.isSupabaseSyncing ? 'در حال ارسال...' : 'سینک ابری'}
                  </motion.button>
                )}
              </div>
            </div>

            {/* Desktop Table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-50/70 dark:bg-slate-950/40 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
                    <th className="py-3 px-4 font-medium">لایه همگام‌سازی</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">آخرین زمان سینک</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">نسخه / جزئیات</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">وضعیت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {syncChannels.map((ch) => {
                    const Icon = ch.icon;
                    return (
                      <tr
                        key={ch.id}
                        className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {ch.title}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-code">
                                {ch.subtitle}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4 font-code tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                          {ch.lastSync}
                        </td>
                        <td className="py-3 px-4 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {ch.revision}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 font-semibold ${
                              ch.isHealthy
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {ch.isHealthy ? (
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span>{ch.statusLabel}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="sm:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {syncChannels.map((ch) => {
                const Icon = ch.icon;
                return (
                  <div key={ch.id} className="p-4 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {ch.title}
                        </span>
                      </div>
                      <span
                        className={`text-[11px] font-semibold shrink-0 ${
                          ch.isHealthy
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {ch.statusLabel}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-code tabular-nums">
                      <span>آخرین سینک: {ch.lastSync}</span>
                      <span>{ch.revision}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* IndexedDB Per-Store Live Telemetry */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  جزئیات جداول IndexedDB و صف‌های خروجی (Outbox)
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-code tabular-nums">
                  {idbReport
                    ? `${idbReport.dbName} (v${toPersianDigits(idbReport.dbVersion)}) · ${toPersianDigits(idbReport.storeCount)} Object Store`
                    : 'در حال بررسی ساختار IndexedDB...'}
                </p>
              </div>
              {idbReport && idbReport.storeBreakdown.length > (compact ? 6 : 10) && (
                <button
                  type="button"
                  onClick={() => setShowAllStores((prev) => !prev)}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap cursor-pointer"
                >
                  {showAllStores
                    ? 'نمایش فشرده'
                    : `نمایش همه ${toPersianDigits(idbReport.storeBreakdown.length)} جدول`}
                </button>
              )}
            </div>

            {idbReport?.errorMessage ? (
              <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 text-xs text-rose-800 dark:text-rose-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{idbReport.errorMessage}</span>
              </div>
            ) : !idbReport ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 animate-pulse">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <div
                    key={n}
                    className="h-12 rounded-xl bg-slate-100 dark:bg-slate-800/70"
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {visibleStores.map((st) => (
                    <div
                      key={st.store}
                      className="px-3 py-2.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/50 border border-slate-200/70 dark:border-slate-800 flex items-center justify-between gap-2 text-xs"
                    >
                      <span
                        className="text-slate-700 dark:text-slate-300 truncate"
                        title={st.label}
                      >
                        {st.label.split('(')[0].trim()}
                      </span>
                      <span className="font-code tabular-nums font-bold text-slate-900 dark:text-white shrink-0">
                        {toPersianDigits(st.count)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Outbox Health Footer */}
                <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <div className="flex flex-wrap items-center gap-3 font-code tabular-nums">
                    <span>
                      در انتظار:{' '}
                      <strong className="text-amber-700 dark:text-amber-400">
                        {toPersianDigits(
                          dexieOutboxBreakdown.pending + idbReport.outboxBreakdown.pending
                        )}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      در حال تلاش:{' '}
                      <strong className="text-sky-700 dark:text-sky-400">
                        {toPersianDigits(dexieOutboxBreakdown.retrying)}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      تحویل‌شده:{' '}
                      <strong className="text-emerald-700 dark:text-emerald-400">
                        {toPersianDigits(
                          dexieOutboxBreakdown.synced + idbReport.outboxBreakdown.synced
                        )}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      تداخل/خطا:{' '}
                      <strong className="text-rose-700 dark:text-rose-400">
                        {toPersianDigits(totalOutboxConflicts)}
                      </strong>
                    </span>
                  </div>
                  {vectorClockEntries.length > 0 && (
                    <span className="text-[11px] font-code tabular-nums text-slate-500 dark:text-slate-400">
                      VectorClock:{' '}
                      {vectorClockEntries
                        .map(([k, v]) => `${k.slice(-6)}:${toPersianDigits(v)}`)
                        .join(' | ')}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* 5-Col: ConflictResolution Flags Inspector & Policy Switcher */}
        <div className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                کنترل و وضعیت پرچم‌های ConflictResolution
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                سیاست حل تداخل میان نسخه محلی IndexedDB، شبکه همتا (P2P) و سرور ابری را مشاهده یا
                به‌صورت زنده تنظیم کنید.
              </p>
            </div>

            {/* Interactive Segmented Control with Framer Motion layoutId */}
            {dualCloud && (
              <div
                className="p-1.5 rounded-xl bg-slate-100/90 dark:bg-slate-950/70 border border-slate-200/70 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-1"
                role="radiogroup"
                aria-label="انتخاب سیاست پیش‌فرض حل تداخل"
              >
                {CONFLICT_MODES.map((m) => {
                  const isActive = activeConflictMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => dualCloud.setConflictDefaultMode(m.id, false)}
                      className={`relative min-h-[44px] px-2.5 py-2 rounded-lg text-center transition-colors cursor-pointer ${
                        isActive
                          ? 'text-indigo-700 dark:text-indigo-200 font-bold'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 font-medium'
                      }`}
                    >
                      {isActive && (
                        <motion.div
                          layoutId={`conflictModeIndicator_${instanceId}`}
                          transition={snappySpring}
                          className="absolute inset-0 rounded-lg bg-white dark:bg-slate-800 shadow-xs border border-indigo-200/80 dark:border-indigo-700/70"
                        />
                      )}
                      <span className="relative z-10 block text-[11px] leading-tight">
                        {m.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Detailed Flags List */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-b border-slate-100 dark:border-slate-800">
              {conflictFlags.map((flag) => (
                <div key={flag.flagKey} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {flag.title}
                      </span>
                      <span className="text-[10.5px] font-code text-slate-400 dark:text-slate-500">
                        ({flag.flagKey})
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      {flag.hint}
                    </div>
                  </div>
                  <div className="text-left shrink-0">
                    <div
                      className={`text-xs font-semibold whitespace-nowrap ${
                        flag.tone === 'error'
                          ? 'text-rose-700 dark:text-rose-400'
                          : flag.tone === 'warn'
                            ? 'text-amber-700 dark:text-amber-400'
                            : flag.tone === 'info'
                              ? 'text-indigo-700 dark:text-indigo-400'
                              : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {flag.valueText}
                    </div>
                    <div className="text-[10.5px] font-code tabular-nums text-slate-400 dark:text-slate-500 mt-0.5">
                      {flag.codeVal}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Last Conflict Audit Note / Safe Footer */}
          {dualCloud?.lastConflictNote ? (
            <div className="p-3.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-900/70 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              <div className="font-bold mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>آخرین رویداد تداخل ثبت‌شده</span>
              </div>
              <p>{dualCloud.lastConflictNote}</p>
            </div>
          ) : (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/70 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>ادغام قطعی LWW و محافظت Revision فعال است.</span>
              </span>
              {dualCloud && totalPendingOutbox > 0 && isOnline && (
                <button
                  type="button"
                  onClick={() => void dualCloud.flushOutboxNow()}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap cursor-pointer"
                >
                  تخلیه صف اکنون
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
