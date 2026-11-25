import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccounting } from '../context/AccountingContext';
import {
  checkSupabaseWorkspaceState,
  clearOfflineOutbox,
  ConflictResolutionPolicy,
  deleteSupabaseBackup,
  enqueueOfflineOutboxItem,
  fetchServerDiagnostics,
  fetchSupabaseBackups,
  fetchSupabaseServerStatus,
  fetchSupabaseSessionMe,
  formatShamsiFromIso,
  LiveServerTestResult,
  loadConflictPolicy,
  loadLastSupabaseRevision,
  loadLastSupabaseSyncAt,
  loadOfflineOutbox,
  loadSavedSupabaseWorkspaceId,
  loadSupabaseAutoBackupEnabled,
  loginSupabaseWorkspaceAuth,
  logoutSupabaseWorkspaceAuth,
  normalizeSupabaseBackups,
  OfflineOutboxItem,
  pullSnapshotFromSupabase,
  pushSnapshotToSupabase,
  resetSupabaseCloudStorage,
  runLiveServerAndSupabaseTest,
  saveConflictPolicy,
  saveLastSupabaseRevision,
  saveLastSupabaseSyncAt,
  saveSupabaseAutoBackupEnabled,
  saveSupabaseWorkspaceId,
  ServerDiagnosticsResponse,
  setupSupabaseWorkspaceAuth,
  SupabaseStatusInfo,
} from '../lib/dualCloudSync';
import {
  CloudBackupMeta,
  deleteFirebaseBackupById,
  listAndPruneFirebaseBackups,
  MAX_CLOUD_BACKUPS,
  pullFirebaseBackupSnapshot,
  saveAndPruneFirebaseBackup,
  wipeAllFirebaseCloudData,
} from '../lib/firebaseCloudBackup';
import {
  clearPendingSyncOutboxOperations,
  enqueueSyncOutboxOperation,
  markSyncOutboxOperationStatus,
} from '../lib/operationalDb';
import { getTodayShamsi, toPersianDigits } from '../lib/format';
import { playSuccessChime, playWarningTone } from '../lib/audioFeedback';
import {
  analyzeAccountingSnapshotConflict,
  getConflictDefaultModeLabel,
  loadSyncConflictDefaultMode,
  resolveConflictDecision,
  saveSyncConflictDefaultMode,
  syncConflictModeToCloudPolicy,
  type PendingSyncConflict,
  type SyncConflictDefaultMode,
  type SyncConflictResolutionChoice,
} from '../lib/syncConflictResolver';
import { useOnlineStatus } from './usePWAInstall';

/** Fast deterministic FNV-1a fingerprint ignoring volatile exportedAt timestamp */
function fingerprintWorkspacePayload(rawJson: string): string {
  const normalized = rawJson.replace(/"exportedAt"\s*:\s*"[^"]*"/, '"exportedAt":""');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length}_${(hash >>> 0).toString(16)}`;
}

const LAST_FB_BACKUP_KEY = 'holoo_apex_firebase_last_backup_v1';

function loadLastFirebaseBackupAt(): string | null {
  try {
    return localStorage.getItem(LAST_FB_BACKUP_KEY) || null;
  } catch {
    return null;
  }
}

function saveLastFirebaseBackupAt(stamp: string): void {
  try {
    localStorage.setItem(LAST_FB_BACKUP_KEY, stamp);
  } catch {
    // ignore
  }
}

export function useDualCloudSync() {
  const {
    user,
    profile,
    accounts,
    vouchers,
    invoices,
    products,
    parties,
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
    deviceId,
    deviceLabel,
    exportBackupJson,
    importBackupJson,
    logActivity,
    showToast,
  } = useAccounting();

  const isOnline = useOnlineStatus();

  // ---- Independent Supabase Session State (100% Decoupled from Firebase!) ----
  // Persists across page reloads & PWA launches via server-issued HttpOnly; Secure; SameSite=None; Partitioned cookie.
  const [supabaseWorkspaceId, setSupabaseWorkspaceIdState] = useState<string>(() =>
    loadSavedSupabaseWorkspaceId()
  );
  const [supabaseSessionToken, setSupabaseSessionToken] = useState<string | null>(null);
  const [supabaseCookieAuthenticated, setSupabaseCookieAuthenticated] = useState<boolean>(false);
  const [supabaseWorkspaceInitialized, setSupabaseWorkspaceInitialized] = useState<boolean | null>(
    null
  );
  const [isSupabaseAuthLoading, setIsSupabaseAuthLoading] = useState(false);
  const [supabaseAutoBackupEnabled, setSupabaseAutoBackupEnabledState] = useState<boolean>(() =>
    loadSupabaseAutoBackupEnabled()
  );
  const [lastSupabaseError, setLastSupabaseError] = useState<string | null>(null);
  const [lastActivationErrorCode, setLastActivationErrorCode] = useState<string | null>(null);
  const [lastActivationFailedAt, setLastActivationFailedAt] = useState<string | null>(null);
  const [autoDiagnosticRunCount, setAutoDiagnosticRunCount] = useState<number>(0);

  // Live Server Diagnostics & Interactive Server Test State
  const [serverDiagnostics, setServerDiagnostics] = useState<ServerDiagnosticsResponse | null>(null);
  const [isTestingServer, setIsTestingServer] = useState(false);
  const [serverTestResult, setServerTestResult] = useState<LiveServerTestResult | null>(null);
  const runServerTestRef = useRef<(silent?: boolean) => Promise<LiveServerTestResult>>(async () => ({
    ok: false,
    testedAt: new Date().toISOString(),
    totalLatencyMs: 0,
    projectRef: null,
    serverRevision: 0,
    backupCount: 0,
    authSource: 'disconnected',
    checks: [],
  }));

  // Strictly independent Supabase auth key — ZERO dependency on Firebase/Google Login!
  const isSupabaseAuthenticated = Boolean(supabaseSessionToken || supabaseCookieAuthenticated);
  const supabaseActorKey = isSupabaseAuthenticated ? `sbw_${supabaseWorkspaceId}` : null;
  const supabaseAuthMode: 'independent' | 'disconnected' = isSupabaseAuthenticated
    ? 'independent'
    : 'disconnected';

  const setSupabaseAutoBackupEnabled = useCallback(
    (enabled: boolean) => {
      setSupabaseAutoBackupEnabledState(enabled);
      saveSupabaseAutoBackupEnabled(enabled);
      logActivity(
        'همگام‌سازی Supabase',
        enabled ? 'فعال‌سازی پشتیبان‌گیری خودکار مستقل' : 'توقف پشتیبان‌گیری خودکار مستقل',
        enabled
          ? 'پشتیبان‌گیری خودکار مستقل روی Supabase PostgreSQL (بدون نیاز به Firebase) فعال شد.'
          : 'پشتیبان‌گیری خودکار Supabase غیرفعال شد؛ همچنان می‌توانید به‌صورت دستی ارسال کنید.'
      );
      showToast(
        enabled
          ? 'پشتیبان‌گیری خودکار مستقل Supabase (بدون نیاز به Firebase) فعال شد.'
          : 'پشتیبان‌گیری خودکار Supabase موقتاً متوقف شد.'
      );
    },
    [logActivity, showToast]
  );

  // ---- Supabase State ----
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseStatusInfo>({
    configured: false,
    connected: false,
    tableReady: false,
    projectRef: null,
    tableName: 'holoo_apex_workspaces',
    latencyMs: null,
    errorCode: 'NOT_CONFIGURED',
    checkedAt: null,
  });

  const [conflictDefaultMode, setConflictDefaultModeState] = useState<SyncConflictDefaultMode>(() =>
    loadSyncConflictDefaultMode()
  );
  const conflictDefaultModeRef = useRef<SyncConflictDefaultMode>(conflictDefaultMode);
  conflictDefaultModeRef.current = conflictDefaultMode;

  const [conflictPolicy, setConflictPolicyState] = useState<ConflictResolutionPolicy>(() => {
    const savedMode = loadSyncConflictDefaultMode();
    return savedMode === 'ask' ? loadConflictPolicy() : syncConflictModeToCloudPolicy(savedMode);
  });
  const [pendingConflict, setPendingConflict] = useState<PendingSyncConflict | null>(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const [outbox, setOutbox] = useState<OfflineOutboxItem[]>(() => loadOfflineOutbox());
  const [lastSupabaseRevision, setLastSupabaseRevision] = useState<number>(() =>
    loadLastSupabaseRevision()
  );
  const [lastSupabaseSyncAt, setLastSupabaseSyncAt] = useState<string | null>(() =>
    loadLastSupabaseSyncAt()
  );
  const [isSupabaseSyncing, setIsSupabaseSyncing] = useState(false);
  const [lastConflictNote, setLastConflictNote] = useState<string | null>(null);
  const [supabaseBackups, setSupabaseBackups] = useState<CloudBackupMeta[]>([]);

  // ---- Firebase Cloud Backup State (100% optional & decoupled from Supabase) ----
  const [firebaseBackups, setFirebaseBackups] = useState<CloudBackupMeta[]>([]);
  const [isFirebaseBackingUp, setIsFirebaseBackingUp] = useState(false);
  const [lastFirebaseBackupAt, setLastFirebaseBackupAt] = useState<string | null>(() =>
    loadLastFirebaseBackupAt()
  );
  const [lastFirebaseRevision, setLastFirebaseRevision] = useState<number>(0);

  // Guard refs prevent overlapping requests, infinite revision loops, and pull-echo loops
  const sbInFlightRef = useRef(false);
  const fbInFlightRef = useRef(false);
  const lastSbSyncedHashRef = useRef<string | null>(null);
  const lastFbSyncedHashRef = useRef<string | null>(null);
  const pendingOperationRef = useRef<{ hash: string; operationId: string } | null>(null);
  const suppressNextAutoSyncRef = useRef(false);
  const sbBootstrappedActorRef = useRef<string | null>(null);
  const fbBootstrappedUidRef = useRef<string | null>(null);

  const setSupabaseWorkspaceId = useCallback((raw: string) => {
    const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    setSupabaseWorkspaceIdState(clean);
    if (clean.length >= 3) {
      saveSupabaseWorkspaceId(clean);
    }
  }, []);

  const checkWorkspaceInit = useCallback(
    async (wid?: string) => {
      const target = (wid ?? supabaseWorkspaceId).trim();
      if (!isOnline || target.length < 3) return null;
      const res = await checkSupabaseWorkspaceState(target);
      if (res.ok) {
        setSupabaseWorkspaceInitialized(Boolean(res.initialized));
        return Boolean(res.initialized);
      }
      return null;
    },
    [isOnline, supabaseWorkspaceId]
  );

  const setupIndependentSupabase = useCallback(
    async (workspaceId: string, passcode: string): Promise<boolean> => {
      const wid = workspaceId.trim();
      if (wid.length < 3) {
        showToast('شناسه فضای کاری باید حداقل ۳ کاراکتر انگلیسی یا عدد باشد.');
        return false;
      }
      if (passcode.length < 6) {
        showToast('رمز عبور مستقل Supabase باید حداقل ۶ کاراکتر باشد.');
        return false;
      }
      setIsSupabaseAuthLoading(true);
      setLastSupabaseError(null);
      setLastActivationErrorCode(null);
      try {
        const res = await setupSupabaseWorkspaceAuth(wid, passcode);
        if (!res.ok || !res.token) {
          const err = res.error || 'خطا در فعال‌سازی حساب مستقل Supabase.';
          setLastSupabaseError(err);
          setLastActivationErrorCode(res.code || 'SETUP_FAILED');
          setLastActivationFailedAt(new Date().toISOString());
          setAutoDiagnosticRunCount((c) => c + 1);
          showToast(err);
          // Automatically run live network & API key diagnostics on activation failure
          void runServerTestRef.current(true);
          return false;
        }
        saveSupabaseWorkspaceId(wid);
        setSupabaseWorkspaceIdState(wid);
        setSupabaseSessionToken(res.token);
        setSupabaseCookieAuthenticated(true);
        setSupabaseWorkspaceInitialized(true);
        sbBootstrappedActorRef.current = `sbw_${wid}`;
        logActivity(
          'همگام‌سازی Supabase',
          'فعال‌سازی مستقل Supabase',
          `فضای کاری «${wid}» به صورت مستقل و بدون نیاز به ورود گوگل/فایربیس فعال شد.`
        );
        // Immediately push initial snapshot so server revision increments from #0 to #1 right away
        const synced = await syncSupabaseNowRef.current(false, res.token);
        if (!synced) {
          setLastActivationFailedAt(new Date().toISOString());
          setAutoDiagnosticRunCount((c) => c + 1);
          void runServerTestRef.current(true);
          showToast(`فضای کاری مستقل Supabase («${wid}») ایجاد شد؛ لطفاً گزارش عیب‌یابی خودکار را بررسی کنید.`);
        }
        return true;
      } finally {
        setIsSupabaseAuthLoading(false);
      }
    },
    [logActivity, showToast]
  );

  const loginIndependentSupabase = useCallback(
    async (workspaceId: string, passcode: string): Promise<boolean> => {
      const wid = workspaceId.trim();
      if (wid.length < 3 || passcode.length < 6) {
        showToast('شناسه فضای کاری و رمز عبور حداقل ۶ کاراکتری را وارد کنید.');
        return false;
      }
      setIsSupabaseAuthLoading(true);
      setLastSupabaseError(null);
      setLastActivationErrorCode(null);
      try {
        const res = await loginSupabaseWorkspaceAuth(wid, passcode);
        if (!res.ok || !res.token) {
          const err = res.error || 'ورود به فضای کاری مستقل Supabase ناموفق بود.';
          setLastSupabaseError(err);
          setLastActivationErrorCode(res.code || 'LOGIN_FAILED');
          setLastActivationFailedAt(new Date().toISOString());
          setAutoDiagnosticRunCount((c) => c + 1);
          showToast(err);
          // Automatically run live network & API key diagnostics on login failure
          void runServerTestRef.current(true);
          return false;
        }
        saveSupabaseWorkspaceId(wid);
        setSupabaseWorkspaceIdState(wid);
        setSupabaseSessionToken(res.token);
        setSupabaseCookieAuthenticated(true);
        setSupabaseWorkspaceInitialized(true);
        const serverRev = Number(res.currentRevision) || 0;
        if (serverRev > 0) {
          setLastSupabaseRevision(serverRev);
          saveLastSupabaseRevision(serverRev);
        }
        if (res.currentUpdatedAt) {
          const formatted = formatShamsiFromIso(res.currentUpdatedAt);
          setLastSupabaseSyncAt(formatted);
          saveLastSupabaseSyncAt(formatted);
        }
        sbBootstrappedActorRef.current = `sbw_${wid}`;
        logActivity(
          'همگام‌سازی Supabase',
          'ورود مستقل به Supabase',
          `اتصال مستقیم به فضای کاری «${wid}» بدون وابستگی به Firebase برقرار شد (نسخه سرور #${toPersianDigits(serverRev)}).`
        );
        // If server has no snapshot yet (#0), immediately push #1 so server revision never stays at #0
        if (serverRev === 0) {
          await syncSupabaseNowRef.current(false, res.token);
        } else {
          await refreshSupabaseBackupsRef.current(res.token);
          showToast(`اتصال مستقل به Supabase («${wid}») برقرار شد · نسخه سرور #${toPersianDigits(serverRev)}.`);
        }
        return true;
      } finally {
        setIsSupabaseAuthLoading(false);
      }
    },
    [logActivity, showToast]
  );

  const logoutIndependentSupabase = useCallback(() => {
    void logoutSupabaseWorkspaceAuth();
    setSupabaseSessionToken(null);
    setSupabaseCookieAuthenticated(false);
    setLastSupabaseError(null);
    sbBootstrappedActorRef.current = null;
    setSupabaseBackups([]);
    showToast('اتصال مستقل Supabase قطع شد.');
  }, [showToast]);

  const setConflictDefaultMode = useCallback(
    (mode: SyncConflictDefaultMode, silent = false) => {
      conflictDefaultModeRef.current = mode;
      setConflictDefaultModeState(mode);
      saveSyncConflictDefaultMode(mode);
      const mappedPolicy = syncConflictModeToCloudPolicy(mode);
      setConflictPolicyState(mappedPolicy);
      saveConflictPolicy(mappedPolicy);
      if (!silent) {
        const label = getConflictDefaultModeLabel(mode);
        logActivity(
          'همگام‌سازی ابری',
          'تغییر پیش‌فرض حل تداخلات',
          `پیش‌فرض حل تداخلات همگام‌سازی روی «${label}» ذخیره شد.`
        );
        showToast(`پیش‌فرض حل تداخلات ذخیره شد: ${label}`);
      }
    },
    [logActivity, showToast]
  );

  const setConflictPolicy = useCallback(
    (policy: ConflictResolutionPolicy) => {
      setConflictPolicyState(policy);
      saveConflictPolicy(policy);
      const mappedMode: SyncConflictDefaultMode =
        policy === 'last_write_wins' ? 'keep_local' : 'restore_remote';
      conflictDefaultModeRef.current = mappedMode;
      setConflictDefaultModeState(mappedMode);
      saveSyncConflictDefaultMode(mappedMode);
      logActivity(
        'همگام‌سازی ابری',
        'تغییر سیاست حل تداخل',
        policy === 'last_write_wins'
          ? 'اولویت همگام‌سازی روی «حفظ آخرین تغییر محلی (Last-Write-Wins)» تنظیم شد.'
          : 'اولویت همگام‌سازی روی «بازگردانی نسخه ابری (First-Write-Wins)» تنظیم شد.'
      );
      showToast(
        policy === 'last_write_wins'
          ? 'سیاست حل تداخل: حفظ آخرین تغییر محلی فعال شد.'
          : 'سیاست حل تداخل: بازگردانی نسخه ابری فعال شد.'
      );
    },
    [logActivity, showToast]
  );

  // ---------------- FIREBASE 3-BACKUP ROLLING RETENTION + PUSH / PULL ----------------
  const refreshFirebaseBackups = useCallback(
    async (preferServer = false): Promise<CloudBackupMeta[]> => {
      if (!user) {
        setFirebaseBackups([]);
        return [];
      }
      const res = await listAndPruneFirebaseBackups(user.uid, preferServer);
      setFirebaseBackups(res.backups);
      if (res.backups.length > 0) {
        setLastFirebaseRevision(res.backups[0].revision);
        setLastFirebaseBackupAt(res.backups[0].savedAtShamsi);
        saveLastFirebaseBackupAt(res.backups[0].savedAtShamsi);
      }
      return res.backups;
    },
    [user]
  );

  const pushToFirebaseNow = useCallback(
    async (silent = false): Promise<boolean> => {
      if (fbInFlightRef.current) return false;
      const snapshotJson = exportBackupJson();
      const snapshotHash = fingerprintWorkspacePayload(snapshotJson);

      if (silent && lastFbSyncedHashRef.current === snapshotHash && loadOfflineOutbox().length === 0) {
        return true;
      }

      if (!user) {
        if (!silent) {
          showToast('برای ارسال پشتیبان به Firebase ابتدا با حساب گوگل وارد شوید.');
        }
        return false;
      }

      if (!isOnline) {
        if (!silent) {
          showToast('دستگاه آفلاین است؛ اسناد در حافظه محلی ذخیره شدند و پس از اتصال به Firebase ارسال می‌شوند.');
        }
        return false;
      }

      fbInFlightRef.current = true;
      setIsFirebaseBackingUp(true);
      try {
        const res = await saveAndPruneFirebaseBackup({
          ownerId: user.uid,
          reason: silent ? 'auto_sync' : 'manual_push',
          deviceId,
          deviceLabel,
          companyName: profile.companyName,
          fiscalYear: profile.fiscalYear,
          voucherCount: vouchers.length,
          invoiceCount: invoices.length,
          productCount: products.length,
          snapshotJson,
        });

        if (!res.ok) {
          if (!silent && res.error) showToast(res.error);
          return false;
        }

        lastFbSyncedHashRef.current = snapshotHash;
        setFirebaseBackups(res.backups);
        setLastFirebaseRevision(res.revision);
        setLastFirebaseBackupAt(res.savedAtShamsi);
        saveLastFirebaseBackupAt(res.savedAtShamsi);

        // If Supabase is not configured/authenticated, Firebase sync fulfills the offline queue cleanly
        if (!isSupabaseAuthenticated || !supabaseStatus.configured || !supabaseStatus.tableReady) {
          clearOfflineOutbox();
          setOutbox([]);
          void clearPendingSyncOutboxOperations();
        }

        if (!silent) {
          const pruneNote =
            res.prunedCount > 0
              ? ` · ${toPersianDigits(res.prunedCount)} نسخه قدیمی پاکسازی شد`
              : '';
          logActivity(
            'پشتیبان ابری Firebase',
            'ارسال نسخه پشتیبان',
            `نسخه #${toPersianDigits(res.revision)} در Firebase ذخیره شد (نگهداری ${toPersianDigits(res.backups.length)} از ${toPersianDigits(MAX_CLOUD_BACKUPS)} نسخه${pruneNote}).`
          );
          showToast(
            `ارسال به Firebase انجام شد (نسخه #${toPersianDigits(res.revision)} · نگهداری ${toPersianDigits(MAX_CLOUD_BACKUPS)} نسخه آخر${pruneNote}).`
          );
        }
        return true;
      } finally {
        fbInFlightRef.current = false;
        setIsFirebaseBackingUp(false);
      }
    },
    [
      exportBackupJson,
      user,
      isOnline,
      deviceId,
      deviceLabel,
      profile.companyName,
      profile.fiscalYear,
      vouchers.length,
      invoices.length,
      products.length,
      isSupabaseAuthenticated,
      supabaseStatus.configured,
      supabaseStatus.tableReady,
      logActivity,
      showToast,
    ]
  );

  const pullFromFirebaseNow = useCallback(
    async (backupId?: string): Promise<boolean> => {
      if (fbInFlightRef.current) return false;
      if (!user) {
        showToast('برای دریافت نسخه از Firebase ابتدا با حساب گوگل وارد شوید.');
        return false;
      }
      if (!isOnline) {
        showToast('برای دریافت نسخه از سرور Firebase اتصال اینترنت لازم است.');
        return false;
      }

      fbInFlightRef.current = true;
      setIsFirebaseBackingUp(true);
      try {
        const res = await pullFirebaseBackupSnapshot(user.uid, backupId);
        if (!res.ok) {
          showToast(res.error || 'خطا در دریافت نسخه از Firebase.');
          return false;
        }
        if (!res.found || !res.snapshotJson) {
          showToast('هنوز نسخه پشتیبان ابری روی Firebase ذخیره نشده است. ابتدا یک بار «ارسال به Firebase» را بزنید.');
          return false;
        }

        suppressNextAutoSyncRef.current = true;
        const imported = importBackupJson(res.snapshotJson);
        if (imported) {
          const hash = fingerprintWorkspacePayload(res.snapshotJson);
          lastFbSyncedHashRef.current = hash;
          const rev = res.revision || 1;
          setLastFirebaseRevision(rev);
          if (res.savedAtShamsi) {
            setLastFirebaseBackupAt(res.savedAtShamsi);
            saveLastFirebaseBackupAt(res.savedAtShamsi);
          }
          clearOfflineOutbox();
          setOutbox([]);
          void clearPendingSyncOutboxOperations();
          logActivity(
            'پشتیبان ابری Firebase',
            'دریافت و بازیابی نسخه ابری',
            `نسخه #${toPersianDigits(rev)} از Firebase Firestore دریافت و بازیابی شد.`
          );
          showToast(`نسخه #${toPersianDigits(rev)} از Firebase Firestore دریافت و بازیابی شد.`);
          await refreshFirebaseBackups(false);
        } else {
          suppressNextAutoSyncRef.current = false;
        }
        return imported;
      } finally {
        fbInFlightRef.current = false;
        setIsFirebaseBackingUp(false);
      }
    },
    [user, isOnline, importBackupJson, logActivity, showToast, refreshFirebaseBackups]
  );

  const removeFirebaseBackup = useCallback(
    async (backupId: string) => {
      if (!user) return;
      const res = await deleteFirebaseBackupById(user.uid, backupId);
      if (res.ok) {
        setFirebaseBackups(res.backups);
        showToast('نسخه پشتیبان انتخاب‌شده از Firebase حذف شد.');
      }
    },
    [user, showToast]
  );

  // ---------------- INDEPENDENT SUPABASE AUTO-SYNC + IDEMPOTENT OUTBOX + 3-BACKUP RETENTION ----------------
  const refreshSupabaseBackups = useCallback(
    async (overrideToken?: string | null) => {
      if (!isOnline) return null;
      const effectiveToken = overrideToken ?? supabaseSessionToken;
      if (!effectiveToken && !supabaseCookieAuthenticated) return null;
      try {
        const res = await fetchSupabaseBackups(effectiveToken);
        if (res.ok) {
          setLastSupabaseError(null);
          if (res.backups) setSupabaseBackups(res.backups);
          // CRITICAL FIX: always hydrate live server revision & timestamp from server metadata
          if (typeof res.currentRevision === 'number') {
            setLastSupabaseRevision(res.currentRevision);
            saveLastSupabaseRevision(res.currentRevision);
          }
          if (res.currentUpdatedAt) {
            const stamp = formatShamsiFromIso(res.currentUpdatedAt);
            setLastSupabaseSyncAt(stamp);
            saveLastSupabaseSyncAt(stamp);
          }
          return res;
        }
        if (res.error) {
          setLastSupabaseError(res.error);
        }
      } catch {
        // ignore transient network errors
      }
      return null;
    },
    [isOnline, supabaseSessionToken, supabaseCookieAuthenticated]
  );

  const refreshServerDiagnostics = useCallback(
    async (overrideToken?: string | null) => {
      if (!isOnline) return null;
      const diag = await fetchServerDiagnostics(overrideToken ?? supabaseSessionToken);
      if (diag) {
        setServerDiagnostics(diag);
        setSupabaseStatus({
          configured: diag.supabase.configured,
          connected: diag.supabase.connected,
          tableReady: diag.supabase.tableReady,
          projectRef: diag.supabase.projectRef,
          tableName: diag.supabase.tableName,
          latencyMs: diag.supabase.latencyMs,
          errorCode: diag.supabase.errorCode,
          checkedAt: new Date().toISOString(),
        });
        if (diag.session.authenticated && diag.session.serverRevision > 0) {
          setLastSupabaseRevision(diag.session.serverRevision);
          saveLastSupabaseRevision(diag.session.serverRevision);
          if (diag.session.lastUpdatedAt) {
            const stamp = formatShamsiFromIso(diag.session.lastUpdatedAt);
            setLastSupabaseSyncAt(stamp);
            saveLastSupabaseSyncAt(stamp);
          }
        }
      }
      return diag;
    },
    [isOnline, supabaseSessionToken]
  );

  const runServerTest = useCallback(
    async (silent = false) => {
      setIsTestingServer(true);
      try {
        const result = await runLiveServerAndSupabaseTest(supabaseSessionToken);
        setServerTestResult(result);
        if (result.serverRevision > 0) {
          setLastSupabaseRevision(result.serverRevision);
          saveLastSupabaseRevision(result.serverRevision);
        }
        void refreshServerDiagnostics();
        if (!silent) {
          if (result.ok) {
            showToast(
              `تست زنده سرور و Supabase موفق بود (${toPersianDigits(result.totalLatencyMs)}ms · نسخه سرور #${toPersianDigits(result.serverRevision)}).`
            );
          } else {
            showToast(result.error || 'عیب‌یابی خودکار یک یا چند مشکل اتصال گزارش کرد؛ راهکارها را ببینید.');
          }
        }
        return result;
      } finally {
        setIsTestingServer(false);
      }
    },
    [supabaseSessionToken, refreshServerDiagnostics, showToast]
  );

  useEffect(() => {
    runServerTestRef.current = runServerTest;
  }, [runServerTest]);

  const refreshSupabaseStatus = useCallback(async () => {
    if (!isOnline) {
      setSupabaseStatus((prev) => ({
        ...prev,
        connected: false,
        errorCode: 'OFFLINE',
        checkedAt: new Date().toISOString(),
      }));
      return null;
    }
    const diag = await refreshServerDiagnostics();
    const status: SupabaseStatusInfo = diag
      ? {
          configured: diag.supabase.configured,
          connected: diag.supabase.connected,
          tableReady: diag.supabase.tableReady,
          projectRef: diag.supabase.projectRef,
          tableName: diag.supabase.tableName,
          latencyMs: diag.supabase.latencyMs,
          errorCode: diag.supabase.errorCode,
          checkedAt: new Date().toISOString(),
        }
      : await fetchSupabaseServerStatus();
    setSupabaseStatus(status);
    if (status.configured && status.tableReady) {
      if (isSupabaseAuthenticated) {
        void refreshSupabaseBackups();
      } else {
        void checkWorkspaceInit();
      }
    }
    return status;
  }, [isOnline, isSupabaseAuthenticated, refreshServerDiagnostics, refreshSupabaseBackups, checkWorkspaceInit]);

  // Restore persistent HttpOnly independent Supabase session automatically on mount (zero Firebase needed!)
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (!isOnline || sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    void (async () => {
      const me = await fetchSupabaseSessionMe();
      if (me.authenticated && me.workspaceId) {
        saveSupabaseWorkspaceId(me.workspaceId);
        setSupabaseWorkspaceIdState(me.workspaceId);
        setSupabaseCookieAuthenticated(true);
        setSupabaseWorkspaceInitialized(true);
        if (me.serverRevision > 0) {
          setLastSupabaseRevision(me.serverRevision);
          saveLastSupabaseRevision(me.serverRevision);
        }
        if (me.updatedAt) {
          const stamp = formatShamsiFromIso(me.updatedAt);
          setLastSupabaseSyncAt(stamp);
          saveLastSupabaseSyncAt(stamp);
        }
      }
      await refreshSupabaseStatus();
    })();
  }, [isOnline, refreshSupabaseStatus]);

  const syncSupabaseNow = useCallback(
    async (silent = false, overrideToken?: string | null): Promise<boolean> => {
      if (sbInFlightRef.current) return false;
      const snapshotJson = exportBackupJson();
      const snapshotHash = fingerprintWorkspacePayload(snapshotJson);

      if (
        silent &&
        lastSupabaseRevisionRef.current > 0 &&
        lastSbSyncedHashRef.current === snapshotHash &&
        loadOfflineOutbox().length === 0
      ) {
        return true;
      }

      // Deterministic idempotency key per payload hash so network retries are 100% idempotent
      const operationId =
        pendingOperationRef.current && pendingOperationRef.current.hash === snapshotHash
          ? pendingOperationRef.current.operationId
          : `op_${Date.now().toString(36)}_${snapshotHash.slice(0, 16)}`;
      pendingOperationRef.current = { hash: snapshotHash, operationId };

      if (!isOnline) {
        const updated = enqueueOfflineOutboxItem({
          summary: `تغییر آفلاین (${toPersianDigits(vouchers.length)} سند · ${toPersianDigits(invoices.length)} فاکتور)`,
          voucherCount: vouchers.length,
          invoiceCount: invoices.length,
          productCount: products.length,
        });
        setOutbox(updated);
        void enqueueSyncOutboxOperation({
          operationId,
          target: 'supabase',
          workspaceId: supabaseWorkspaceId || 'default',
          deviceId,
          clientRevision: lastSupabaseRevisionRef.current,
          payloadHash: snapshotHash,
          createdAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        });
        if (!silent) {
          showToast('دستگاه آفلاین است؛ تغییرات با کلید یکتا در صف همگام‌سازی ذخیره شد.');
        }
        return false;
      }

      const effectiveToken = overrideToken ?? supabaseSessionToken;
      if (!effectiveToken && !supabaseCookieAuthenticated) {
        if (!silent) {
          showToast('برای همگام‌سازی Supabase، فضای کاری مستقل Supabase را بدون نیاز به Firebase فعال کنید.');
        }
        return false;
      }

      if (!supabaseStatus.configured || !supabaseStatus.tableReady) {
        const freshStatus = await refreshSupabaseStatus();
        if (!freshStatus?.configured || !freshStatus.tableReady) {
          const msg = freshStatus?.configured
            ? 'جدول Supabase هنوز ایجاد نشده است (فایل supabase/schema.sql را در SQL Editor اجرا کنید).'
            : 'اطلاعات اتصال Supabase (SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY) هنوز در تنظیمات سرور وارد نشده است.';
          setLastSupabaseError(msg);
          if (!silent) showToast(msg);
          return false;
        }
      }

      sbInFlightRef.current = true;
      setIsSupabaseSyncing(true);
      try {
        void enqueueSyncOutboxOperation({
          operationId,
          target: 'supabase',
          workspaceId: supabaseWorkspaceId || 'default',
          deviceId,
          clientRevision: lastSupabaseRevisionRef.current,
          payloadHash: snapshotHash,
          createdAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        });

        const activeDefaultMode = conflictDefaultModeRef.current;
        const effectivePolicy = syncConflictModeToCloudPolicy(activeDefaultMode);

        const res = await pushSnapshotToSupabase({
          idToken: effectiveToken,
          operationId,
          deviceId,
          deviceLabel,
          conflictPolicy: effectivePolicy,
          clientRevision: lastSupabaseRevisionRef.current,
          companyName: profile.companyName,
          fiscalYear: profile.fiscalYear,
          voucherCount: vouchers.length,
          invoiceCount: invoices.length,
          productCount: products.length,
          snapshotJson,
        });

        if (!res.ok || !res.data) {
          const errMsg = res.error || 'خطا در همگام‌سازی با Supabase';
          setLastSupabaseError(errMsg);
          const updated = enqueueOfflineOutboxItem({
            summary: `تلاش ناموفق همگام‌سازی Supabase (${res.code || 'RETRY'})`,
            voucherCount: vouchers.length,
            invoiceCount: invoices.length,
            productCount: products.length,
          });
          setOutbox(updated);
          if (!silent) showToast(errMsg);
          return false;
        }

        setLastSupabaseError(null);

        // Check if server detected a revision conflict and user preference is 'ask'
        if (res.data.status === 'conflict_kept_remote' && res.data.remoteSnapshotJson) {
          const decision = resolveConflictDecision(activeDefaultMode);
          if (!decision.autoResolved) {
            const summary = analyzeAccountingSnapshotConflict(
              snapshotJson,
              res.data.remoteSnapshotJson
            );
            if (summary.hasConflicts) {
              const conflictRecord: PendingSyncConflict = {
                id: `sb_conflict_${Date.now()}`,
                source: 'supabase',
                sourceLabel: 'سرور ابری Supabase PostgreSQL',
                remoteDeviceLabel: res.data.remoteDeviceLabel || 'دستگاه دیگر',
                detectedAt: new Date().toISOString(),
                localRevision: lastSupabaseRevisionRef.current,
                remoteRevision: res.data.serverRevision,
                localSnapshotJson: snapshotJson,
                remoteSnapshotJson: res.data.remoteSnapshotJson,
                summary,
              };
              const note = `تداخل در ${toPersianDigits(summary.totalConflictingDocs)} سند حسابداری با «${conflictRecord.remoteDeviceLabel}» شناسایی شد (در انتظار انتخاب کاربر).`;
              setLastConflictNote(note);
              setPendingConflict(conflictRecord);
              playWarningTone();
              logActivity('همگام‌سازی Supabase', 'شناسایی تداخل اسناد', note);
              showToast(
                'تداخل در اسناد حسابداری شناسایی شد؛ لطفاً انتخاب کنید آخرین تغییر محلی حفظ شود یا نسخه ابری بازگردانی گردد.'
              );
              return false;
            }
          }
        }

        const timeStr = new Date().toLocaleTimeString('fa-IR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const stamp = `${getTodayShamsi()} · ${timeStr}`;

        setLastSupabaseRevision(res.data.serverRevision);
        saveLastSupabaseRevision(res.data.serverRevision);
        setLastSupabaseSyncAt(stamp);
        saveLastSupabaseSyncAt(stamp);
        clearOfflineOutbox();
        setOutbox([]);
        pendingOperationRef.current = null;
        void markSyncOutboxOperationStatus(operationId, 'synced');
        void clearPendingSyncOutboxOperations();

        if (Array.isArray(res.data.retainedBackups)) {
          setSupabaseBackups(normalizeSupabaseBackups(res.data.retainedBackups));
        }

        const prunedCount = Number(res.data.prunedBackupsCount) || 0;
        const pruneNote =
          prunedCount > 0 ? ` · ${toPersianDigits(prunedCount)} نسخه قدیمی پاکسازی شد` : '';

        if (res.data.status === 'idempotent_replay') {
          lastSbSyncedHashRef.current = snapshotHash;
          if (!silent) {
            showToast(
              `این نسخه قبلاً با موفقیت در Supabase ثبت شده بود (نسخه #${toPersianDigits(res.data.serverRevision)} — بدون تکرار).`
            );
          }
        } else if (res.data.status === 'conflict_kept_remote') {
          const note = `تداخل با «${res.data.remoteDeviceLabel || 'دستگاه دیگر'}» به‌صورت خودکار حل شد: طبق پیش‌فرض ذخیره‌شده، نسخه ابری شماره #${toPersianDigits(res.data.serverRevision)} بازگردانی گردید.`;
          setLastConflictNote(note);
          logActivity('همگام‌سازی Supabase', 'حل خودکار تداخل (بازگردانی نسخه ابری)', note);
          if (res.data.remoteSnapshotJson) {
            suppressNextAutoSyncRef.current = true;
            lastSbSyncedHashRef.current = fingerprintWorkspacePayload(res.data.remoteSnapshotJson);
            importBackupJson(res.data.remoteSnapshotJson);
          }
          playSuccessChime();
          showToast(note);
        } else if (res.data.status === 'conflict_overwrote_remote') {
          lastSbSyncedHashRef.current = snapshotHash;
          const note = `تداخل ویرایش به‌صورت خودکار حل شد: طبق پیش‌فرض ذخیره‌شده، آخرین تغییر محلی شما به‌عنوان نسخه #${toPersianDigits(res.data.serverRevision)} ثبت گردید${pruneNote}.`;
          setLastConflictNote(note);
          logActivity('همگام‌سازی Supabase', 'حل خودکار تداخل (حفظ آخرین تغییر محلی)', note);
          playSuccessChime();
          showToast(note);
        } else {
          lastSbSyncedHashRef.current = snapshotHash;
          setLastConflictNote(null);
          if (!silent) {
            showToast(
              `ارسال به Supabase انجام شد (نسخه #${toPersianDigits(res.data.serverRevision)} · نگهداری ${toPersianDigits(MAX_CLOUD_BACKUPS)} نسخه آخر${pruneNote}).`
            );
          }
        }
        return true;
      } finally {
        sbInFlightRef.current = false;
        setIsSupabaseSyncing(false);
      }
    },
    [
      exportBackupJson,
      isOnline,
      vouchers.length,
      invoices.length,
      products.length,
      supabaseWorkspaceId,
      supabaseSessionToken,
      supabaseCookieAuthenticated,
      supabaseStatus.configured,
      supabaseStatus.tableReady,
      refreshSupabaseStatus,
      deviceId,
      deviceLabel,
      conflictPolicy,
      profile.companyName,
      profile.fiscalYear,
      logActivity,
      importBackupJson,
      showToast,
    ]
  );

  const pullFromSupabase = useCallback(
    async (backupId?: string, silent = false): Promise<boolean> => {
      if (sbInFlightRef.current) return false;
      if (!isOnline || (!supabaseSessionToken && !supabaseCookieAuthenticated)) {
        if (!silent) {
          showToast('برای دریافت از Supabase اتصال اینترنت و فعال‌سازی مستقل Supabase لازم است.');
        }
        return false;
      }
      sbInFlightRef.current = true;
      setIsSupabaseSyncing(true);
      try {
        const res = await pullSnapshotFromSupabase(supabaseSessionToken, backupId);
        if (!res.ok) {
          setLastSupabaseError(res.error || 'خطا در دریافت از Supabase');
          if (!silent) showToast(res.error || 'خطا در دریافت از Supabase');
          return false;
        }
        setLastSupabaseError(null);
        if (!res.found || !res.snapshotJson) {
          if (!silent) showToast('هنوز نسخه‌ای روی Supabase برای این فضای کاری ذخیره نشده است.');
          return false;
        }
        suppressNextAutoSyncRef.current = true;
        const imported = importBackupJson(res.snapshotJson);
        if (imported) {
          lastSbSyncedHashRef.current = fingerprintWorkspacePayload(res.snapshotJson);
          const rev = res.revision || 1;
          setLastSupabaseRevision(rev);
          saveLastSupabaseRevision(rev);
          const timeStr = new Date().toLocaleTimeString('fa-IR', {
            hour: '2-digit',
            minute: '2-digit',
          });
          const stamp = `${getTodayShamsi()} · ${timeStr}`;
          setLastSupabaseSyncAt(stamp);
          saveLastSupabaseSyncAt(stamp);
          clearOfflineOutbox();
          setOutbox([]);
          void clearPendingSyncOutboxOperations();
          logActivity(
            'همگام‌سازی Supabase',
            backupId ? 'بازیابی از نسخه پشتیبان' : 'دریافت نسخه ابری',
            `نسخه #${toPersianDigits(rev)} از Supabase PostgreSQL دریافت و بازیابی شد.`
          );
          if (!silent) {
            showToast(`نسخه #${toPersianDigits(rev)} از Supabase PostgreSQL دریافت و بازیابی شد.`);
          }
        } else {
          suppressNextAutoSyncRef.current = false;
        }
        return imported;
      } finally {
        sbInFlightRef.current = false;
        setIsSupabaseSyncing(false);
      }
    },
    [isOnline, supabaseSessionToken, supabaseCookieAuthenticated, importBackupJson, logActivity, showToast]
  );

  const removeSupabaseBackup = useCallback(
    async (backupId: string) => {
      if ((!supabaseSessionToken && !supabaseCookieAuthenticated) || !isOnline) return;
      const res = await deleteSupabaseBackup(supabaseSessionToken, backupId);
      if (res.ok && res.backups) {
        setSupabaseBackups(res.backups);
        showToast('نسخه پشتیبان انتخاب‌شده از Supabase حذف شد.');
      }
    },
    [supabaseSessionToken, supabaseCookieAuthenticated, isOnline, showToast]
  );

  const refreshSupabaseBackupsRef = useRef(refreshSupabaseBackups);
  useEffect(() => {
    refreshSupabaseBackupsRef.current = refreshSupabaseBackups;
  }, [refreshSupabaseBackups]);

  // Refs to prevent revision state updates from re-triggering effects
  const syncSupabaseNowRef = useRef(syncSupabaseNow);
  useEffect(() => {
    syncSupabaseNowRef.current = syncSupabaseNow;
  }, [syncSupabaseNow]);

  const pullFromSupabaseRef = useRef(pullFromSupabase);
  useEffect(() => {
    pullFromSupabaseRef.current = pullFromSupabase;
  }, [pullFromSupabase]);

  const pushToFirebaseNowRef = useRef(pushToFirebaseNow);
  useEffect(() => {
    pushToFirebaseNowRef.current = pushToFirebaseNow;
  }, [pushToFirebaseNow]);

  const lastSupabaseRevisionRef = useRef(lastSupabaseRevision);
  useEffect(() => {
    lastSupabaseRevisionRef.current = lastSupabaseRevision;
  }, [lastSupabaseRevision]);

  // 1. INDEPENDENT AUTO-BOOTSTRAP FOR SUPABASE (works completely without Firebase Google login!)
  useEffect(() => {
    if (!supabaseActorKey || !isOnline || !supabaseStatus.configured || !supabaseStatus.tableReady) {
      if (!supabaseActorKey) {
        sbBootstrappedActorRef.current = null;
        setSupabaseBackups([]);
      }
      return;
    }
    if (sbBootstrappedActorRef.current === supabaseActorKey) return;
    sbBootstrappedActorRef.current = supabaseActorKey;

    let cancelled = false;
    void (async () => {
      const meta = await refreshSupabaseBackups();
      if (cancelled || !meta) return;

      const remoteRev = meta.currentRevision || 0;
      const localRev = lastSupabaseRevisionRef.current;

      if (remoteRev === 0 || loadOfflineOutbox().length > 0) {
        await syncSupabaseNowRef.current(true);
      } else if (
        remoteRev > localRev &&
        meta.currentDeviceId !== deviceId
      ) {
        await pullFromSupabaseRef.current(undefined, true);
      } else {
        setLastSupabaseRevision(Math.max(localRev, remoteRev));
        saveLastSupabaseRevision(Math.max(localRev, remoteRev));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    supabaseActorKey,
    isOnline,
    supabaseStatus.configured,
    supabaseStatus.tableReady,
    deviceId,
    refreshSupabaseBackups,
  ]);

  // 2. INDEPENDENT AUTO-BOOTSTRAP FOR FIREBASE 3-VERSION ROLLING BACKUPS
  useEffect(() => {
    if (!user) {
      fbBootstrappedUidRef.current = null;
      setFirebaseBackups([]);
      return;
    }
    if (!isOnline || fbBootstrappedUidRef.current === user.uid) return;
    fbBootstrappedUidRef.current = user.uid;

    let cancelled = false;
    void (async () => {
      const existing = await refreshFirebaseBackups(false);
      if (cancelled) return;
      if (existing.length === 0) {
        await pushToFirebaseNowRef.current(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, isOnline, refreshFirebaseBackups]);

  // 3. INDEPENDENT BACKGROUND POLL + PERIODIC AUTO-BACKUP + WINDOW FOCUS SYNC FOR SUPABASE (100% Firebase-Free)
  useEffect(() => {
    if (!supabaseActorKey || !isOnline || !supabaseStatus.configured || !supabaseStatus.tableReady) {
      return;
    }

    const checkRemoteSupabase = async () => {
      if (document.visibilityState !== 'visible' || sbInFlightRef.current) return;
      const meta = await refreshSupabaseBackups();
      if (!meta || !meta.ok) return;
      const remoteRev = meta.currentRevision || 0;
      if (remoteRev === 0 && supabaseAutoBackupEnabled) {
        await syncSupabaseNowRef.current(true);
        return;
      }
      if (
        remoteRev > lastSupabaseRevisionRef.current &&
        meta.currentDeviceId &&
        meta.currentDeviceId !== deviceId &&
        loadOfflineOutbox().length === 0
      ) {
        await pullFromSupabaseRef.current(undefined, true);
      }
    };

    const pollInterval = window.setInterval(() => {
      void checkRemoteSupabase();
    }, 45_000);

    // Independent periodic auto-backup heartbeat (every 5 minutes) strictly to Supabase
    const autoBackupInterval = window.setInterval(() => {
      if (!supabaseAutoBackupEnabled || sbInFlightRef.current) return;
      void syncSupabaseNowRef.current(true);
    }, 5 * 60_000);

    const onFocus = () => {
      void checkRemoteSupabase();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(pollInterval);
      window.clearInterval(autoBackupInterval);
      window.removeEventListener('focus', onFocus);
    };
  }, [
    supabaseActorKey,
    isOnline,
    supabaseStatus.configured,
    supabaseStatus.tableReady,
    supabaseAutoBackupEnabled,
    deviceId,
    refreshSupabaseBackups,
  ]);

  // 4. OFFLINE-FIRST MUTATION OBSERVER: syncs Supabase & Firebase INDEPENDENTLY on any change
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    if (suppressNextAutoSyncRef.current) {
      suppressNextAutoSyncRef.current = false;
      return;
    }

    if (!isOnline) {
      // Only enqueue to cloud sync outbox when at least one cloud provider is active;
      // local-only mode persists directly to Operational IndexedDB with zero queue backlog.
      if ((isSupabaseAuthenticated && supabaseAutoBackupEnabled) || user) {
        const updated = enqueueOfflineOutboxItem({
          summary: `تغییر آفلاین (${toPersianDigits(vouchers.length)} سند · ${toPersianDigits(invoices.length)} فاکتور)`,
          voucherCount: vouchers.length,
          invoiceCount: invoices.length,
          productCount: products.length,
        });
        setOutbox(updated);
      }
      return;
    }

    const timers: number[] = [];

    if (
      isSupabaseAuthenticated &&
      supabaseAutoBackupEnabled &&
      supabaseStatus.configured &&
      supabaseStatus.tableReady
    ) {
      timers.push(
        window.setTimeout(() => {
          void syncSupabaseNowRef.current(true);
        }, 2500)
      );
    }

    if (user) {
      timers.push(
        window.setTimeout(() => {
          void pushToFirebaseNowRef.current(true);
        }, 4000)
      );
    }

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [
    isOnline,
    isSupabaseAuthenticated,
    supabaseAutoBackupEnabled,
    user,
    supabaseStatus.configured,
    supabaseStatus.tableReady,
    profile,
    accounts,
    vouchers,
    invoices,
    products,
    parties,
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
  ]);

  // 5. GUARANTEED AUTO-DRAIN WHEN ONLINE + AUTHENTICATED (handles page reloads AND reconnects!)
  const autoDrainAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOnline || outbox.length === 0) {
      if (outbox.length === 0) {
        autoDrainAttemptedRef.current = null;
      }
      return;
    }
    const drainKey = `${outbox.length}_${supabaseActorKey || 'no_sb'}_${user?.uid || 'no_fb'}_${supabaseStatus.tableReady ? '1' : '0'}`;
    if (autoDrainAttemptedRef.current === drainKey) return;

    if (isSupabaseAuthenticated && supabaseStatus.configured && supabaseStatus.tableReady) {
      autoDrainAttemptedRef.current = drainKey;
      const t = window.setTimeout(() => {
        void syncSupabaseNowRef.current(true);
      }, 600);
      return () => window.clearTimeout(t);
    }

    if (user) {
      autoDrainAttemptedRef.current = drainKey;
      const t = window.setTimeout(() => {
        void pushToFirebaseNowRef.current(true);
      }, 800);
      return () => window.clearTimeout(t);
    }
  }, [
    isOnline,
    outbox.length,
    isSupabaseAuthenticated,
    supabaseActorKey,
    supabaseStatus.configured,
    supabaseStatus.tableReady,
    user,
  ]);

  // 6. INDEPENDENT AUTO-FLUSH UPON RECONNECTING
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const justReconnected = !prevOnlineRef.current && isOnline;
    prevOnlineRef.current = isOnline;
    if (justReconnected) {
      autoDrainAttemptedRef.current = null;
      if (isSupabaseAuthenticated) {
        void refreshSupabaseStatus().then((st) => {
          if (st?.configured && st.tableReady && loadOfflineOutbox().length > 0) {
            void syncSupabaseNowRef.current(false);
          }
        });
      }
      if (user) {
        void pushToFirebaseNowRef.current(true);
      }
    }
  }, [isOnline, isSupabaseAuthenticated, user, refreshSupabaseStatus]);

  const flushOutboxNow = useCallback(async (): Promise<boolean> => {
    if (!isOnline) {
      showToast('دستگاه آفلاین است؛ پس از اتصال به اینترنت صف به‌صورت خودکار ارسال می‌شود.');
      return false;
    }
    let drained = false;
    if (isSupabaseAuthenticated && supabaseStatus.configured && supabaseStatus.tableReady) {
      drained = (await syncSupabaseNow(false)) || drained;
    }
    if (user) {
      drained = (await pushToFirebaseNow(false)) || drained;
    }
    if (!isSupabaseAuthenticated && !user) {
      clearOfflineOutbox();
      setOutbox([]);
      void clearPendingSyncOutboxOperations();
      showToast('همه تغییرات روی حافظه محلی IndexedDB ذخیره هستند؛ صف قدیمی پاکسازی شد.');
      return true;
    }
    if (drained) {
      clearOfflineOutbox();
      setOutbox([]);
      void clearPendingSyncOutboxOperations();
    }
    return drained;
  }, [
    isOnline,
    isSupabaseAuthenticated,
    supabaseStatus.configured,
    supabaseStatus.tableReady,
    user,
    syncSupabaseNow,
    pushToFirebaseNow,
    showToast,
  ]);

  const resolvePendingConflict = useCallback(
    async (
      choice: SyncConflictResolutionChoice,
      rememberAsDefault: boolean
    ): Promise<boolean> => {
      if (!pendingConflict) return false;
      setIsResolvingConflict(true);
      try {
        if (rememberAsDefault) {
          setConflictDefaultMode(choice, true);
        }

        const defaultSuffix = rememberAsDefault
          ? ' و به‌عنوان پیش‌فرض حل تداخلات آینده ذخیره شد'
          : '';

        if (choice === 'restore_remote') {
          suppressNextAutoSyncRef.current = true;
          const imported = importBackupJson(pendingConflict.remoteSnapshotJson);
          if (!imported) {
            suppressNextAutoSyncRef.current = false;
            showToast('بازیابی نسخه ابری ناموفق بود؛ لطفاً دوباره تلاش کنید.');
            return false;
          }
          lastSbSyncedHashRef.current = fingerprintWorkspacePayload(
            pendingConflict.remoteSnapshotJson
          );
          setLastSupabaseRevision(pendingConflict.remoteRevision);
          saveLastSupabaseRevision(pendingConflict.remoteRevision);
          const timeStr = new Date().toLocaleTimeString('fa-IR', {
            hour: '2-digit',
            minute: '2-digit',
          });
          const stamp = `${getTodayShamsi()} · ${timeStr}`;
          setLastSupabaseSyncAt(stamp);
          saveLastSupabaseSyncAt(stamp);
          clearOfflineOutbox();
          setOutbox([]);
          pendingOperationRef.current = null;
          void clearPendingSyncOutboxOperations();
          setPendingConflict(null);

          const note = `نسخه ابری شماره #${toPersianDigits(pendingConflict.remoteRevision)} از «${pendingConflict.remoteDeviceLabel}» بازگردانی شد${defaultSuffix}.`;
          setLastConflictNote(note);
          logActivity('همگام‌سازی Supabase', 'حل تداخل توسط کاربر (نسخه ابری)', note);
          playSuccessChime();
          showToast(note);
          return true;
        }

        // choice === 'keep_local': push latest local snapshot onto cloud cleanly
        const localJson = exportBackupJson();
        const localHash = fingerprintWorkspacePayload(localJson);
        const opId = `op_resolve_local_${Date.now().toString(36)}_${localHash.slice(0, 12)}`;
        const pushRes = await pushSnapshotToSupabase({
          idToken: supabaseSessionToken,
          operationId: opId,
          deviceId,
          deviceLabel,
          conflictPolicy: 'last_write_wins',
          clientRevision: pendingConflict.remoteRevision,
          companyName: profile.companyName,
          fiscalYear: profile.fiscalYear,
          voucherCount: vouchers.length,
          invoiceCount: invoices.length,
          productCount: products.length,
          snapshotJson: localJson,
        });

        if (!pushRes.ok || !pushRes.data) {
          const errMsg = pushRes.error || 'خطا در ثبت نسخه محلی روی سرور Supabase';
          setLastSupabaseError(errMsg);
          showToast(errMsg);
          return false;
        }

        lastSbSyncedHashRef.current = localHash;
        setLastSupabaseRevision(pushRes.data.serverRevision);
        saveLastSupabaseRevision(pushRes.data.serverRevision);
        const timeStr = new Date().toLocaleTimeString('fa-IR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const stamp = `${getTodayShamsi()} · ${timeStr}`;
        setLastSupabaseSyncAt(stamp);
        saveLastSupabaseSyncAt(stamp);
        if (Array.isArray(pushRes.data.retainedBackups)) {
          setSupabaseBackups(normalizeSupabaseBackups(pushRes.data.retainedBackups));
        }
        clearOfflineOutbox();
        setOutbox([]);
        pendingOperationRef.current = null;
        void clearPendingSyncOutboxOperations();
        setPendingConflict(null);

        const note = `آخرین تغییر محلی حفظ و به‌عنوان نسخه #${toPersianDigits(pushRes.data.serverRevision)} در ابر ثبت شد${defaultSuffix}.`;
        setLastConflictNote(note);
        logActivity('همگام‌سازی Supabase', 'حل تداخل توسط کاربر (حفظ محلی)', note);
        playSuccessChime();
        showToast(note);
        return true;
      } finally {
        setIsResolvingConflict(false);
      }
    },
    [
      pendingConflict,
      setConflictDefaultMode,
      importBackupJson,
      exportBackupJson,
      supabaseSessionToken,
      deviceId,
      deviceLabel,
      profile.companyName,
      profile.fiscalYear,
      vouchers.length,
      invoices.length,
      products.length,
      logActivity,
      showToast,
    ]
  );

  const dismissPendingConflict = useCallback(() => {
    setPendingConflict(null);
  }, []);

  const clearPendingOutbox = useCallback(() => {
    clearOfflineOutbox();
    setOutbox([]);
    pendingOperationRef.current = null;
    autoDrainAttemptedRef.current = null;
    void clearPendingSyncOutboxOperations();
    showToast('صف انتظار همگام‌سازی پاکسازی شد (اطلاعات شما در پایگاه داده محلی محفوظ است).');
  }, [showToast]);

  const wipeCloudStorage = useCallback(
    async (options: {
      supabase?: boolean;
      firebaseBackups?: boolean;
      firebaseCollections?: boolean;
      disconnectSupabaseSession?: boolean;
    }): Promise<{
      ok: boolean;
      details: string[];
      warnings: string[];
    }> => {
      const details: string[] = [];
      const warnings: string[] = [];

      if (options.supabase) {
        if (!isOnline) {
          warnings.push('دستگاه آفلاین است؛ پاکسازی فضای ابری Supabase انجام نشد.');
        } else if (!isSupabaseAuthenticated) {
          warnings.push('نشست مستقل Supabase فعال نیست؛ برای پاکسازی Supabase ابتدا وارد فضای کاری شوید.');
        } else {
          const sbRes = await resetSupabaseCloudStorage(supabaseSessionToken, {
            clearWorkspace: true,
            clearBackups: true,
            clearAuditLogs: true,
          });
          if (sbRes.ok) {
            suppressNextAutoSyncRef.current = true;
            setSupabaseBackups([]);
            setLastSupabaseRevision(0);
            saveLastSupabaseRevision(0);
            setLastSupabaseSyncAt(null);
            lastSbSyncedHashRef.current = null;
            clearOfflineOutbox();
            setOutbox([]);
            void clearPendingSyncOutboxOperations();
            details.push(
              `فضای ابری Supabase پاکسازی شد (${toPersianDigits(sbRes.deletedBackups || 0)} نسخه پشتیبان و اسنپ‌شات اصلی حذف شد).`
            );
            if (options.disconnectSupabaseSession) {
              void logoutSupabaseWorkspaceAuth();
              setSupabaseSessionToken(null);
              setSupabaseCookieAuthenticated(false);
              sbBootstrappedActorRef.current = null;
            }
          } else {
            warnings.push(sbRes.error || 'پاکسازی فضای ابری Supabase با خطا مواجه شد.');
          }
        }
      }

      if (options.firebaseBackups || options.firebaseCollections) {
        if (!user) {
          warnings.push('حساب گوگل/Firebase متصل نیست؛ پاکسازی Firebase رد شد.');
        } else if (!isOnline) {
          warnings.push('دستگاه آفلاین است؛ پاکسازی Firebase Firestore انجام نشد.');
        } else {
          const fbRes = await wipeAllFirebaseCloudData(user.uid, {
            wipeBackups: Boolean(options.firebaseBackups),
            wipeCollections: Boolean(options.firebaseCollections),
          });
          if (fbRes.ok) {
            setFirebaseBackups([]);
            setLastFirebaseRevision(0);
            setLastFirebaseBackupAt(null);
            lastFbSyncedHashRef.current = null;
            details.push(
              `فضای ابری Firebase پاکسازی شد (${toPersianDigits(fbRes.deletedBackups)} بکاپ و ${toPersianDigits(fbRes.deletedDocs)} سند حذف شد).`
            );
          } else {
            warnings.push(fbRes.error || 'پاکسازی Firebase Firestore با خطا مواجه شد.');
          }
        }
      }

      return {
        ok: warnings.length === 0,
        details,
        warnings,
      };
    },
    [isOnline, isSupabaseAuthenticated, supabaseSessionToken, user]
  );

  return {
    // Independent Supabase Session & Controls (100% Firebase-Free)
    supabaseStatus,
    supabaseBackups,
    supabaseWorkspaceId,
    setSupabaseWorkspaceId,
    supabaseWorkspaceInitialized,
    isSupabaseAuthenticated,
    supabaseAuthMode,
    isSupabaseAuthLoading,
    supabaseAutoBackupEnabled,
    setSupabaseAutoBackupEnabled,
    lastSupabaseError,
    checkWorkspaceInit,
    setupIndependentSupabase,
    loginIndependentSupabase,
    logoutIndependentSupabase,
    conflictPolicy,
    setConflictPolicy,
    conflictDefaultMode,
    setConflictDefaultMode,
    pendingConflict,
    isResolvingConflict,
    resolvePendingConflict,
    dismissPendingConflict,
    pendingQueueCount: outbox.length,
    outboxItems: outbox,
    flushOutboxNow,
    clearPendingOutbox,
    lastSupabaseRevision,
    lastSupabaseSyncAt,
    isSupabaseSyncing,
    lastConflictNote,
    syncSupabaseNow,
    pullFromSupabase,
    refreshSupabaseStatus,
    removeSupabaseBackup,

    // Live Server Display & Interactive Diagnostics/Test
    serverDiagnostics,
    isTestingServer,
    serverTestResult,
    lastActivationErrorCode,
    lastActivationFailedAt,
    autoDiagnosticRunCount,
    refreshServerDiagnostics,
    runServerTest,

    // Optional Firebase Controls (completely decoupled from Supabase)
    firebaseBackups,
    isFirebaseBackingUp,
    lastFirebaseBackupAt,
    lastFirebaseRevision,
    pushToFirebaseNow,
    pullFromFirebaseNow,
    refreshFirebaseBackups,
    removeFirebaseBackup,
    wipeCloudStorage,
    maxCloudBackups: MAX_CLOUD_BACKUPS,
  };
}

export type DualCloudSyncController = ReturnType<typeof useDualCloudSync>;
