import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Database,
  KeyRound,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import type { SupabaseRemediationItem } from '../lib/dualCloudSync';
import { toPersianDigits } from '../lib/format';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

interface BrowserProbeResult {
  checkedAt: string;
  navigatorOnline: boolean;
  expressReachable: boolean;
  expressLatencyMs: number | null;
  httpStatus: number | null;
}

interface SupabaseAutoDiagnosticPanelProps {
  dualCloud: DualCloudSyncController;
  compact?: boolean;
  onOpenSettings?: () => void;
}

function getKeyRoleLabel(role?: string | null): {
  label: string;
  tone: 'ok' | 'danger' | 'warn';
} {
  switch (role) {
    case 'sb_secret':
      return { label: 'کلید مخفی Secret (مجاز سرور)', tone: 'ok' };
    case 'service_role_jwt':
      return { label: 'کلید Service Role JWT (مجاز سرور)', tone: 'ok' };
    case 'sb_publishable':
      return { label: 'کلید عمومی Publishable (مسدود در RLS)', tone: 'danger' };
    case 'anon_jwt':
      return { label: 'کلید عمومی Anon JWT (مسدود در RLS)', tone: 'danger' };
    case 'missing':
      return { label: 'تنظیم نشده (خالی)', tone: 'danger' };
    default:
      return { label: role ? `کلید ${role}` : 'در حال بررسی...', tone: 'warn' };
  }
}

export const SupabaseAutoDiagnosticPanel: React.FC<SupabaseAutoDiagnosticPanelProps> = ({
  dualCloud,
  compact = false,
  onOpenSettings,
}) => {
  const [browserProbe, setBrowserProbe] = useState<BrowserProbeResult | null>(null);
  const [isProbingBrowser, setIsProbingBrowser] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const autoTriggeredRef = useRef(false);

  const runBrowserAndServerDiagnostics = useCallback(
    async (silent = false) => {
      setIsProbingBrowser(true);
      const navOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let expressReachable = false;
      let expressLatencyMs: number | null = null;
      let httpStatus: number | null = null;

      try {
        const resp = await fetch('/api/health', {
          method: 'GET',
          cache: 'no-store',
        });
        httpStatus = resp.status;
        expressReachable = resp.ok;
        expressLatencyMs = Math.max(
          1,
          Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
        );
      } catch {
        expressReachable = false;
        expressLatencyMs = null;
      } finally {
        setBrowserProbe({
          checkedAt: new Date().toISOString(),
          navigatorOnline: navOnline,
          expressReachable,
          expressLatencyMs,
          httpStatus,
        });
        setIsProbingBrowser(false);
      }

      await dualCloud.runServerTest(silent);
    },
    [dualCloud]
  );

  // Auto-run diagnostic tool immediately whenever an error state exists or activation failed
  const hasKnownError = Boolean(
    dualCloud.lastSupabaseError ||
      dualCloud.lastActivationErrorCode ||
      (dualCloud.supabaseStatus.errorCode && dualCloud.supabaseStatus.errorCode !== 'OK')
  );

  useEffect(() => {
    if (hasKnownError && !dualCloud.serverTestResult && !dualCloud.isTestingServer && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true;
      void runBrowserAndServerDiagnostics(true);
    }
  }, [hasKnownError, dualCloud.serverTestResult, dualCloud.isTestingServer, runBrowserAndServerDiagnostics]);

  // Also refresh browser probe whenever a new activation failure happens
  useEffect(() => {
    if (dualCloud.autoDiagnosticRunCount > 0) {
      void (async () => {
        const navOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
        const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
        try {
          const resp = await fetch('/api/health', { method: 'GET', cache: 'no-store' });
          setBrowserProbe({
            checkedAt: new Date().toISOString(),
            navigatorOnline: navOnline,
            expressReachable: resp.ok,
            expressLatencyMs: Math.max(
              1,
              Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
            ),
            httpStatus: resp.status,
          });
        } catch {
          setBrowserProbe({
            checkedAt: new Date().toISOString(),
            navigatorOnline: navOnline,
            expressReachable: false,
            expressLatencyMs: null,
            httpStatus: null,
          });
        }
      })();
    }
  }, [dualCloud.autoDiagnosticRunCount]);

  const testResult = dualCloud.serverTestResult;
  const effectiveKeyRole =
    testResult?.keyRole ??
    dualCloud.supabaseStatus.keyRole ??
    (dualCloud.supabaseStatus.errorCode === 'INVALID_ANON_KEY' ? 'sb_publishable' : null);

  const keyRoleMeta = getKeyRoleLabel(effectiveKeyRole);

  // Combine client-side network findings with server-side structured remediations
  const combinedRemediations = useMemo<SupabaseRemediationItem[]>(() => {
    const list: SupabaseRemediationItem[] = [];

    if (browserProbe && !browserProbe.navigatorOnline) {
      list.push({
        id: 'client_offline',
        severity: 'critical',
        title: 'مرورگر در حالت آفلاین (بدون اینترنت) قرار دارد',
        summary: 'برای فعال‌سازی یا همگام‌سازی اولیه با Supabase اتصال اینترنت لازم است.',
        steps: [
          'اتصال Wi-Fi یا اینترنت دستگاه خود را برقرار کنید.',
          'اطلاعات شما تا زمان اتصال مجدد با امنیت کامل در IndexedDB محلی نگهداری می‌شود.',
        ],
      });
    } else if (browserProbe && !browserProbe.expressReachable) {
      list.push({
        id: 'express_backend_down',
        severity: 'critical',
        title: 'ارتباط با سرور میانی برنامه (Express API) برقرار نشد',
        summary: 'درخواست /api/health با خطای شبکه یا قطع سرویس مواجه شد.',
        steps: [
          'صفحه را یک‌بار تازه‌سازی کنید تا اتصال به سرور روی پورت ۳۰۰۰ مجدداً برقرار شود.',
          'اگر از VPN یا پروکسی محدودکننده روی دامنه محلی استفاده می‌کنید، آن را موقتاً بررسی کنید.',
        ],
      });
    }

    if (testResult?.remediations && testResult.remediations.length > 0) {
      for (const rem of testResult.remediations) {
        if (!list.some((x) => x.id === rem.id)) {
          list.push(rem);
        }
      }
    } else if (dualCloud.supabaseStatus.errorCode === 'INVALID_ANON_KEY') {
      list.push({
        id: 'fallback_invalid_key',
        severity: 'critical',
        title: 'کلید تنظیم‌شده از نوع عمومی (Publishable/Anon) است',
        summary: 'کلید عمومی به دلیل فعال بودن RLS نمی‌تواند فضای کاری مستقل بسازد یا داده ذخیره کند.',
        envKeyHint: 'SUPABASE_SERVICE_ROLE_KEY',
        steps: [
          'در پنل Supabase به مسیر Project Settings → API Keys بروید.',
          'کلید مخفی Secret key (با پیشوند sb_secret_...) یا service_role را کپی کنید.',
          'مقدار متغیر SUPABASE_SERVICE_ROLE_KEY را در تنظیمات Secrets برنامه جایگزین کنید و دوباره تست بزنید.',
        ],
      });
    }

    return list;
  }, [browserProbe, testResult?.remediations, dualCloud.supabaseStatus.errorCode]);

  const isRunning = isProbingBrowser || dualCloud.isTestingServer;
  const overallHealthy =
    Boolean(testResult?.ok) &&
    (browserProbe ? browserProbe.navigatorOnline && browserProbe.expressReachable : true) &&
    combinedRemediations.every((r) => r.severity === 'info');

  const handleCopySafeSummary = async () => {
    const safeReport = {
      generatedAt: new Date().toISOString(),
      browserOnline: browserProbe?.navigatorOnline ?? (typeof navigator !== 'undefined' ? navigator.onLine : true),
      expressReachable: browserProbe?.expressReachable ?? null,
      expressLatencyMs: browserProbe?.expressLatencyMs ?? null,
      projectRef: testResult?.projectRef ?? dualCloud.supabaseStatus.projectRef ?? null,
      keyRole: effectiveKeyRole ?? 'unknown',
      networkReachable: testResult?.networkReachable ?? dualCloud.supabaseStatus.connected,
      rlsWriteReady: testResult?.rlsWriteReady ?? false,
      errorCode: dualCloud.lastActivationErrorCode ?? dualCloud.supabaseStatus.errorCode ?? null,
      checks: (testResult?.checks ?? []).map((c) => ({
        id: c.id,
        ok: c.ok,
        latencyMs: c.latencyMs,
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeReport, null, 2));
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2200);
    } catch {
      // ignore clipboard errors in restricted frames
    }
  };

  return (
    <section
      aria-label="ابزار تشخیصی خودکار اتصال و کلیدهای Supabase"
      className="rounded-2xl bg-white dark:bg-slate-900/95 border border-slate-200/80 dark:border-slate-800/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] overflow-hidden"
    >
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              overallHealthy
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400'
                : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400'
            }`}
          >
            {overallHealthy ? (
              <ShieldCheck className="w-5 h-5" />
            ) : (
              <ShieldAlert className="w-5 h-5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                ابزار عیب‌یابی خودکار اتصال و کلیدهای Supabase
              </h3>
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${
                  overallHealthy
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300'
                    : isRunning
                      ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300'
                      : 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
                }`}
              >
                {isRunning
                  ? 'در حال اسکن خودکار...'
                  : overallHealthy
                    ? 'اتصال و کلیدها سالم'
                    : `${toPersianDigits(combinedRemediations.filter((r) => r.severity !== 'info').length || 1)} مشکل شناسایی شد`}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-5">
              بررسی خودکار وضعیت اینترنت، دسترسی سرور Express، نقش کلید API در RLS، پایداری شبکه Supabase و سلامت جداول PostgreSQL
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={snappySpring}
            onClick={() => void runBrowserAndServerDiagnostics(false)}
            disabled={isRunning}
            className="h-10 sm:h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm disabled:opacity-60 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'در حال بررسی...' : 'اجرای عیب‌یابی خودکار'}</span>
          </motion.button>

          <button
            type="button"
            onClick={() => void handleCopySafeSummary()}
            className="h-10 sm:h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            {copiedReport ? (
              <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copiedReport ? 'کپی شد' : 'کپی گزارش امن'}</span>
          </button>

          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="h-10 sm:h-9 px-3 rounded-xl border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/40 cursor-pointer"
            >
              تنظیمات اتصال
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 sm:p-5 space-y-4">
        {/* 4-Card Bento Telemetry Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {/* 1. Browser & Express Network */}
          <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800/80">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>شبکه و سرور میانی</span>
              {browserProbe?.navigatorOnline === false ? (
                <WifiOff className="w-3.5 h-3.5 text-rose-500" />
              ) : (
                <Wifi className="w-3.5 h-3.5 text-emerald-500" />
              )}
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span
                className={`text-xs font-bold ${
                  browserProbe?.expressReachable === false || browserProbe?.navigatorOnline === false
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {browserProbe?.navigatorOnline === false
                  ? 'آفلاین'
                  : browserProbe?.expressReachable === false
                    ? 'سرور در دسترس نیست'
                    : 'متصل و پاسخگو'}
              </span>
              <span className="font-code text-[11px] tabular-nums text-slate-500">
                {browserProbe?.expressLatencyMs != null
                  ? `${toPersianDigits(browserProbe.expressLatencyMs)}ms`
                  : '—'}
              </span>
            </div>
          </div>

          {/* 2. API Key Privilege / Role */}
          <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800/80">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>سطح دسترسی کلید API</span>
              <KeyRound
                className={`w-3.5 h-3.5 ${
                  keyRoleMeta.tone === 'ok'
                    ? 'text-emerald-500'
                    : keyRoleMeta.tone === 'danger'
                      ? 'text-rose-500'
                      : 'text-amber-500'
                }`}
              />
            </div>
            <div className="mt-1.5">
              <span
                className={`text-xs font-bold block truncate ${
                  keyRoleMeta.tone === 'ok'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : keyRoleMeta.tone === 'danger'
                      ? 'text-rose-700 dark:text-rose-400'
                      : 'text-amber-700 dark:text-amber-400'
                }`}
                title={keyRoleMeta.label}
              >
                {keyRoleMeta.label}
              </span>
            </div>
          </div>

          {/* 3. Supabase PostgREST Reachability */}
          <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800/80">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>دسترسی Supabase HTTPS</span>
              <Server className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span
                className={`text-xs font-bold ${
                  testResult?.networkReachable || dualCloud.supabaseStatus.connected
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-700 dark:text-rose-400'
                }`}
              >
                {testResult?.networkReachable || dualCloud.supabaseStatus.connected
                  ? 'قابل دسترس'
                  : 'قطع یا تایم‌اوت'}
              </span>
              <span className="font-code text-[11px] tabular-nums text-slate-500">
                {testResult?.totalLatencyMs
                  ? `${toPersianDigits(testResult.totalLatencyMs)}ms`
                  : dualCloud.supabaseStatus.latencyMs != null
                    ? `${toPersianDigits(dualCloud.supabaseStatus.latencyMs)}ms`
                    : '—'}
              </span>
            </div>
          </div>

          {/* 4. RLS & Schema Write Readiness */}
          <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800/80">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>جداول SQL و مجوز نوشتن RLS</span>
              <Database className="w-3.5 h-3.5 text-teal-500" />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span
                className={`text-xs font-bold ${
                  testResult?.rlsWriteReady
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {testResult?.rlsWriteReady ? 'آماده خواندن و نوشتن' : 'نیاز به رفع خطا'}
              </span>
              <span className="font-code text-[11px] tabular-nums text-slate-500" dir="ltr">
                {testResult?.projectRef || dualCloud.supabaseStatus.projectRef || '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Last Activation Failure Callout */}
        {dualCloud.lastSupabaseError && (
          <div className="p-3.5 rounded-xl bg-rose-50/85 dark:bg-rose-950/35 border border-rose-200/90 dark:border-rose-900/70 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
            <div className="space-y-1 min-w-0">
              <div className="font-bold flex flex-wrap items-center gap-2">
                <span>آخرین خطای ثبت‌شده هنگام فعال‌سازی یا همگام‌سازی:</span>
                {dualCloud.lastActivationErrorCode && (
                  <span className="font-code text-[10.5px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/60">
                    {dualCloud.lastActivationErrorCode}
                  </span>
                )}
              </div>
              <p className="leading-5">{dualCloud.lastSupabaseError}</p>
            </div>
          </div>
        )}

        {/* Practical Actionable Remediation Cards */}
        {combinedRemediations.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
              <Wrench className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>راهکارهای عملی پیشنهادی برای رفع خطای اتصال</span>
            </div>
            <div className="space-y-2.5">
              {combinedRemediations.map((rem) => {
                const isCritical = rem.severity === 'critical';
                const isInfo = rem.severity === 'info';
                return (
                  <div
                    key={rem.id}
                    className={`p-4 rounded-xl border space-y-2.5 ${
                      isCritical
                        ? 'bg-rose-50/60 dark:bg-rose-950/25 border-rose-200/90 dark:border-rose-900/70'
                        : isInfo
                          ? 'bg-indigo-50/60 dark:bg-indigo-950/25 border-indigo-200/80 dark:border-indigo-900/70'
                          : 'bg-amber-50/60 dark:bg-amber-950/25 border-amber-200/90 dark:border-amber-900/70'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {isCritical ? (
                          <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                        ) : isInfo ? (
                          <CheckCircle2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                          {rem.title}
                        </h4>
                      </div>
                      {rem.envKeyHint && (
                        <span
                          dir="ltr"
                          className="font-code text-[10.5px] px-2 py-0.5 rounded-md bg-white/80 dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                        >
                          {rem.envKeyHint}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-5">
                      {rem.summary}
                    </p>
                    <ol className="space-y-1.5 pr-1">
                      {rem.steps.map((step, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 leading-5"
                        >
                          <span className="w-5 h-5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-center font-code tabular-nums text-[11px] font-bold text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
                            {toPersianDigits(idx + 1)}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Detailed Live Server Checks List */}
        {!compact && testResult && testResult.checks.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-indigo-500" />
                <span>جزئیات گام‌به‌گام تست زنده سرور</span>
              </span>
              <span className="font-code tabular-nums text-[11px] text-slate-500">
                زمان کل: {toPersianDigits(testResult.totalLatencyMs)}ms
              </span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80 rounded-xl border border-slate-200/70 dark:border-slate-800 overflow-hidden bg-slate-50/40 dark:bg-slate-950/40">
              {testResult.checks.map((chk) => (
                <div
                  key={chk.id}
                  className="p-3 flex items-start justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    {chk.ok ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {chk.title}
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-5 mt-0.5">
                        {chk.detail}
                      </div>
                    </div>
                  </div>
                  <span className="font-code tabular-nums text-[11px] text-slate-500 shrink-0">
                    {toPersianDigits(chk.latencyMs)}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
