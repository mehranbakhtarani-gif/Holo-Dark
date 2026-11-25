import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Table2,
  Trash2,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import { clearHolooLocalStorageKeys, wipeAllLocalIndexedDbs } from '../lib/operationalDb';
import { toPersianDigits } from '../lib/format';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

type ResetPresetId = 'blank_tables' | 'local_databases' | 'cloud_storage' | 'full_factory' | 'restore_demo';

interface SystemResetCenterProps {
  dualCloud?: DualCloudSyncController;
  onDownloadBackupBeforeReset?: () => void;
}

export const SystemResetCenter: React.FC<SystemResetCenterProps> = ({
  dualCloud,
  onDownloadBackupBeforeReset,
}) => {
  const {
    user,
    vouchers,
    invoices,
    products,
    parties,
    cheques,
    resetWorkspaceTables,
    showToast,
  } = useAccounting();

  // Granular reset options
  const [wipeTablesBlank, setWipeTablesBlank] = useState(true);
  const [keepChartOfAccounts, setKeepChartOfAccounts] = useState(true);
  const [keepCompanyProfile, setKeepCompanyProfile] = useState(false);
  const [wipeLocalIndexedDb, setWipeLocalIndexedDb] = useState(true);
  const [wipeLocalStorage, setWipeLocalStorage] = useState(true);
  const [wipeSupabaseCloud, setWipeSupabaseCloud] = useState(false);
  const [disconnectSupabaseAfterWipe, setDisconnectSupabaseAfterWipe] = useState(false);
  const [wipeFirebaseBackups, setWipeFirebaseBackups] = useState(false);
  const [wipeFirebaseCollections, setWipeFirebaseCollections] = useState(false);
  const [restoreDemoMode, setRestoreDemoMode] = useState(false);

  // Active UI confirmation state (no window.confirm / window.alert)
  const [selectedPreset, setSelectedPreset] = useState<ResetPresetId | null>(null);
  const [confirmStepOpen, setConfirmStepOpen] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionReport, setExecutionReport] = useState<{
    completedAt: string;
    succeeded: string[];
    warnings: string[];
    shouldReload: boolean;
  } | null>(null);

  const applyPreset = (preset: ResetPresetId) => {
    setSelectedPreset(preset);
    setExecutionReport(null);
    setConfirmPhrase('');
    setConfirmStepOpen(true);

    if (preset === 'blank_tables') {
      setRestoreDemoMode(false);
      setWipeTablesBlank(true);
      setKeepChartOfAccounts(true);
      setKeepCompanyProfile(true);
      setWipeLocalIndexedDb(false);
      setWipeLocalStorage(false);
      setWipeSupabaseCloud(false);
      setDisconnectSupabaseAfterWipe(false);
      setWipeFirebaseBackups(false);
      setWipeFirebaseCollections(false);
    } else if (preset === 'local_databases') {
      setRestoreDemoMode(false);
      setWipeTablesBlank(false);
      setWipeLocalIndexedDb(true);
      setWipeLocalStorage(true);
      setWipeSupabaseCloud(false);
      setDisconnectSupabaseAfterWipe(false);
      setWipeFirebaseBackups(false);
      setWipeFirebaseCollections(false);
    } else if (preset === 'cloud_storage') {
      setRestoreDemoMode(false);
      setWipeTablesBlank(false);
      setWipeLocalIndexedDb(false);
      setWipeLocalStorage(false);
      setWipeSupabaseCloud(Boolean(dualCloud?.isSupabaseAuthenticated));
      setDisconnectSupabaseAfterWipe(false);
      setWipeFirebaseBackups(Boolean(user));
      setWipeFirebaseCollections(Boolean(user));
    } else if (preset === 'full_factory') {
      setRestoreDemoMode(false);
      setWipeTablesBlank(true);
      setKeepChartOfAccounts(true);
      setKeepCompanyProfile(false);
      setWipeLocalIndexedDb(true);
      setWipeLocalStorage(true);
      setWipeSupabaseCloud(Boolean(dualCloud?.isSupabaseAuthenticated));
      setDisconnectSupabaseAfterWipe(true);
      setWipeFirebaseBackups(Boolean(user));
      setWipeFirebaseCollections(Boolean(user));
    } else if (preset === 'restore_demo') {
      setRestoreDemoMode(true);
      setWipeTablesBlank(false);
      setWipeLocalIndexedDb(false);
      setWipeLocalStorage(false);
      setWipeSupabaseCloud(false);
      setDisconnectSupabaseAfterWipe(false);
      setWipeFirebaseBackups(false);
      setWipeFirebaseCollections(false);
    }
  };

  const hasAnyTargetSelected =
    restoreDemoMode ||
    wipeTablesBlank ||
    wipeLocalIndexedDb ||
    wipeLocalStorage ||
    wipeSupabaseCloud ||
    wipeFirebaseBackups ||
    wipeFirebaseCollections;

  const isPhraseValid =
    confirmPhrase.trim() === 'حذف' ||
    confirmPhrase.trim().toUpperCase() === 'RESET' ||
    confirmPhrase.trim() === 'بازنشانی';

  const handleExecuteReset = async () => {
    if (!hasAnyTargetSelected || !isPhraseValid || isExecuting) return;
    setIsExecuting(true);
    setExecutionReport(null);

    const succeeded: string[] = [];
    const warnings: string[] = [];
    let shouldReload = false;

    try {
      // 1. Cloud Storage Wipe (run before clearing local tokens/storage!)
      if (
        dualCloud &&
        (wipeSupabaseCloud || wipeFirebaseBackups || wipeFirebaseCollections)
      ) {
        const cloudRes = await dualCloud.wipeCloudStorage({
          supabase: wipeSupabaseCloud,
          firebaseBackups: wipeFirebaseBackups,
          firebaseCollections: wipeFirebaseCollections,
          disconnectSupabaseSession: disconnectSupabaseAfterWipe,
        });
        succeeded.push(...cloudRes.details);
        warnings.push(...cloudRes.warnings);
      } else if (wipeSupabaseCloud || wipeFirebaseBackups || wipeFirebaseCollections) {
        warnings.push('ماژول همگام‌سازی ابری در این نما متصل نبود.');
      }

      // 2. Application Tables Reset (Blank Clean State or Initial Demo)
      if (restoreDemoMode) {
        const res = await resetWorkspaceTables({
          mode: 'demo',
          keepCompanyProfile: false,
        });
        succeeded.push(res.summary);
      } else if (wipeTablesBlank) {
        const res = await resetWorkspaceTables({
          mode: 'blank',
          keepChartOfAccounts,
          keepCompanyProfile,
        });
        succeeded.push(res.summary);
      }

      // 3. Local IndexedDB Databases Wipe
      if (wipeLocalIndexedDb) {
        const dbRes = await wipeAllLocalIndexedDbs();
        succeeded.push(
          `بانک‌های اطلاعاتی محلی IndexedDB پاکسازی شدند (${toPersianDigits(dbRes.deletedDbs.length)} دیتابیس حذف شد).`
        );
        if (dbRes.blockedDbs.length > 0) {
          warnings.push(
            `${toPersianDigits(dbRes.blockedDbs.length)} دیتابیس محلی توسط تب دیگر باز است؛ برای تکمیل حذف صفحه را تازه‌سازی کنید.`
          );
        }
        shouldReload = true;
      }

      // 4. LocalStorage & Sync Preferences Wipe
      if (wipeLocalStorage) {
        const removedCount = clearHolooLocalStorageKeys({ preserveTheme: true });
        succeeded.push(
          `حافظه محلی مرورگر (LocalStorage، صف آفلاین و کش‌ها) پاکسازی شد (${toPersianDigits(removedCount)} کلید حذف شد).`
        );
        shouldReload = true;
      }

      setExecutionReport({
        completedAt: new Date().toLocaleTimeString('fa-IR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        succeeded,
        warnings,
        shouldReload,
      });
      setConfirmPhrase('');
      setConfirmStepOpen(false);
      showToast(
        warnings.length === 0
          ? 'بازنشانی انتخاب‌شده با موفقیت کامل انجام شد.'
          : 'بازنشانی انجام شد؛ لطفاً جزئیات و هشدارها را بررسی کنید.'
      );
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <section
      aria-label="مرکز بازنشانی و خام‌سازی داده‌ها، بانک‌های اطلاعاتی و ذخایر ابری"
      className="rounded-2xl bg-white dark:bg-slate-900 border border-rose-200/80 dark:border-rose-900/60 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] overflow-hidden"
    >
      {/* Header */}
      <div className="p-5 sm:p-6 border-b border-rose-100 dark:border-rose-950/80 bg-gradient-to-l from-rose-50/70 via-white to-white dark:from-rose-950/30 dark:via-slate-900 dark:to-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-100 dark:bg-rose-950/70 text-rose-700 dark:text-rose-400 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
              مرکز بازنشانی و خام‌سازی کامل (جداول، دیتابیس محلی و فضای ابری)
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 leading-5">
              امکان صفر کردن جداول حسابداری، پاکسازی کامل IndexedDB و حافظه مرورگر، حذف ذخایر ابری Supabase و Firebase یا بازنشانی کارخانه‌ای کل برنامه
            </p>
          </div>
        </div>

        {onDownloadBackupBeforeReset && (
          <button
            type="button"
            onClick={onDownloadBackupBeforeReset}
            className="h-10 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold inline-flex items-center gap-2 shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span>دانلود پشتیبان JSON قبل از ریست</span>
          </button>
        )}
      </div>

      <div className="p-5 sm:p-6 space-y-5">
        {/* Live Current Data Footprint Strip (tabular-nums) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">جداول فعلی برنامه</div>
            <div className="mt-1 font-code tabular-nums text-sm font-bold text-slate-900 dark:text-white">
              {toPersianDigits(vouchers.length)} سند · {toPersianDigits(invoices.length)} فاکتور
            </div>
            <div className="text-[11px] font-code tabular-nums text-slate-500 mt-0.5">
              {toPersianDigits(products.length)} کالا · {toPersianDigits(parties.length)} طرف‌حساب ·{' '}
              {toPersianDigits(cheques.length)} چک
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">دیتابیس‌های محلی دستگاه</div>
            <div className="mt-1 font-code tabular-nums text-sm font-bold text-slate-900 dark:text-white">
              {toPersianDigits(4)} پایگاه IndexedDB
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              عملیاتی + بکاپ محلی + خزانه اسناد + LocalStorage
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">ذخایر ابری Supabase</div>
            <div className="mt-1 font-code tabular-nums text-sm font-bold text-slate-900 dark:text-white">
              {dualCloud?.isSupabaseAuthenticated
                ? `نسخه #${toPersianDigits(dualCloud.lastSupabaseRevision)} · ${toPersianDigits(dualCloud.supabaseBackups.length)} بکاپ`
                : 'متصل نیست'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate" dir="ltr">
              {dualCloud?.supabaseWorkspaceId || '—'}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">ذخایر ابری Firebase</div>
            <div className="mt-1 font-code tabular-nums text-sm font-bold text-slate-900 dark:text-white">
              {user
                ? `${toPersianDigits(dualCloud?.firebaseBackups.length ?? 0)} بکاپ ابری`
                : 'حساب متصل نیست'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
              {user ? user.email || 'متصل به Firestore' : 'فقط حالت محلی فعال است'}
            </div>
          </div>
        </div>

        {/* 5 Quick Preset Action Cards (Bento Grid) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          {[
            {
              id: 'blank_tables' as ResetPresetId,
              title: 'خام‌سازی جداول برنامه',
              desc: 'صفر کردن اسناد، فاکتورها، کالا، چک و طرف‌حساب (آماده شروع شرکت جدید)',
              icon: Table2,
              accent: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50',
              border: 'hover:border-amber-300 dark:hover:border-amber-700',
            },
            {
              id: 'local_databases' as ResetPresetId,
              title: 'پاکسازی دیتابیس محلی',
              desc: 'حذف کامل IndexedDB، خزانه پیوست‌ها، صف آفلاین و کش‌های مرورگر',
              icon: HardDrive,
              accent: 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/50',
              border: 'hover:border-orange-300 dark:hover:border-orange-700',
            },
            {
              id: 'cloud_storage' as ResetPresetId,
              title: 'پاکسازی ذخایر ابری',
              desc: 'حذف اسنپ‌شات‌ها، بکاپ‌های چرخشی و لاگ‌های Supabase و Firebase',
              icon: CloudOff,
              accent: 'text-indigo-700 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50',
              border: 'hover:border-indigo-300 dark:hover:border-indigo-700',
            },
            {
              id: 'full_factory' as ResetPresetId,
              title: 'بازنشانی کامل کارخانه‌ای',
              desc: 'پاکسازی همزمان جداول + دیتابیس محلی + تمام فضاهای ابری (صفر کامل)',
              icon: Trash2,
              accent: 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/60',
              border: 'hover:border-rose-400 dark:hover:border-rose-700',
            },
            {
              id: 'restore_demo' as ResetPresetId,
              title: 'بازگردانی داده‌های نمونه',
              desc: 'بازیابی جداول به داده‌های نمونه آموزشی اولیه نرم‌افزار هلو',
              icon: RotateCcw,
              accent: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50',
              border: 'hover:border-emerald-300 dark:hover:border-emerald-700',
            },
          ].map((item) => {
            const Icon = item.icon;
            const isSelected = selectedPreset === item.id;
            return (
              <motion.button
                key={item.id}
                type="button"
                whileTap={{ scale: 0.97 }}
                transition={snappySpring}
                onClick={() => applyPreset(item.id)}
                className={`p-4 rounded-xl border text-right flex flex-col justify-between gap-2.5 transition-all cursor-pointer ${
                  isSelected
                    ? 'border-rose-500 dark:border-rose-500 ring-2 ring-rose-500/20 bg-rose-50/40 dark:bg-rose-950/20'
                    : `border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/80 ${item.border}`
                }`}
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${item.accent}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-900 dark:text-white">
                    {item.title}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-4">
                    {item.desc}
                  </p>
                </div>
              </motion.button>
            );
          })}
        </div>

        {/* Custom Granular Selector Matrix */}
        <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
              <span>انتخاب دقیق بخش‌های قابل پاکسازی (قابل سفارشی‌سازی)</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedPreset(null);
                setConfirmStepOpen(true);
              }}
              className="text-[11px] font-semibold text-rose-700 dark:text-rose-400 hover:underline cursor-pointer"
            >
              اجرای تنظیمات سفارشی
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            {/* Group A: Tables */}
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 space-y-2">
              <div className="font-bold text-slate-800 dark:text-slate-200">۱. اطلاعات و جداول برنامه</div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeTablesBlank}
                  onChange={(e) => {
                    setWipeTablesBlank(e.target.checked);
                    if (e.target.checked) setRestoreDemoMode(false);
                  }}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  خام‌سازی کامل جداول عملیاتی (اسناد، فاکتورها، کالا، چک، طرف‌حساب، پرسنل و اموال)
                </span>
              </label>
              {wipeTablesBlank && (
                <div className="pr-5 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={keepChartOfAccounts}
                      onChange={(e) => setKeepChartOfAccounts(e.target.checked)}
                      className="rounded accent-indigo-600"
                    />
                    <span>حفظ کدینگ استاندارد حساب‌ها (توصیه‌شده)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={keepCompanyProfile}
                      onChange={(e) => setKeepCompanyProfile(e.target.checked)}
                      className="rounded accent-indigo-600"
                    />
                    <span>حفظ نام شرکت و شناسه اقتصادی فعلی</span>
                  </label>
                </div>
              )}
              <label className="flex items-start gap-2 cursor-pointer pt-1 border-t border-slate-100 dark:border-slate-800">
                <input
                  type="checkbox"
                  checked={restoreDemoMode}
                  onChange={(e) => {
                    setRestoreDemoMode(e.target.checked);
                    if (e.target.checked) setWipeTablesBlank(false);
                  }}
                  className="mt-0.5 rounded accent-emerald-600"
                />
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                  جایگزینی با داده‌های نمونه آموزشی اولیه
                </span>
              </label>
            </div>

            {/* Group B: Local Databases */}
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 space-y-2">
              <div className="font-bold text-slate-800 dark:text-slate-200">۲. بانک‌های اطلاعاتی محلی</div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeLocalIndexedDb}
                  onChange={(e) => setWipeLocalIndexedDb(e.target.checked)}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  حذف کامل دیتابیس‌های IndexedDB (دیتابیس عملیاتی، بکاپ محلی و خزانه پیوست‌ها)
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeLocalStorage}
                  onChange={(e) => setWipeLocalStorage(e.target.checked)}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  پاکسازی LocalStorage، صف آفلاین (Outbox) و کش تنظیمات محلی
                </span>
              </label>
            </div>

            {/* Group C: Cloud Storage */}
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 space-y-2">
              <div className="font-bold text-slate-800 dark:text-slate-200">۳. ذخایر و فضای ابری</div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeSupabaseCloud}
                  onChange={(e) => setWipeSupabaseCloud(e.target.checked)}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  پاکسازی Supabase PostgreSQL (اسنپ‌شات فعلی، ۳ نسخه بکاپ و گزارش ممیزی)
                </span>
              </label>
              {wipeSupabaseCloud && (
                <label className="flex items-center gap-2 pr-5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={disconnectSupabaseAfterWipe}
                    onChange={(e) => setDisconnectSupabaseAfterWipe(e.target.checked)}
                    className="rounded accent-rose-600"
                  />
                  <span>خروج از نشست مستقل Supabase پس از پاکسازی</span>
                </label>
              )}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeFirebaseBackups}
                  onChange={(e) => setWipeFirebaseBackups(e.target.checked)}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  حذف نسخه‌های پشتیبان ابری Firebase Firestore
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeFirebaseCollections}
                  onChange={(e) => setWipeFirebaseCollections(e.target.checked)}
                  className="mt-0.5 rounded accent-rose-600"
                />
                <span className="text-slate-700 dark:text-slate-300">
                  حذف کامل کالکشن‌های حسابداری ذخیره‌شده در Firebase
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Inline Safe Confirmation Drawer */}
        {confirmStepOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={snappySpring}
            className="p-4 sm:p-5 rounded-xl bg-rose-50/85 dark:bg-rose-950/35 border border-rose-300/90 dark:border-rose-800 space-y-3.5"
          >
            <div className="flex items-start gap-2.5 text-rose-900 dark:text-rose-200">
              <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <div className="font-bold text-sm">
                  تایید نهایی عملیات بازنشانی و پاکسازی داده‌ها
                </div>
                <p className="leading-5">
                  این عملیات روی بخش‌های تیک‌خورده قابل بازگشت نیست. برای جلوگیری از حذف تصادفی، لطفاً واژه{' '}
                  <strong className="font-code px-1.5 py-0.5 rounded bg-white/80 dark:bg-slate-900 text-rose-700 dark:text-rose-300">
                    حذف
                  </strong>{' '}
                  یا{' '}
                  <strong className="font-code px-1.5 py-0.5 rounded bg-white/80 dark:bg-slate-900 text-rose-700 dark:text-rose-300">
                    RESET
                  </strong>{' '}
                  را در کادر زیر وارد کنید:
                </p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder="عبارت «حذف» یا «RESET» را تایپ کنید..."
                aria-label="تایید عملیات بازنشانی"
                className="flex-1 h-11 px-3.5 rounded-xl bg-white dark:bg-slate-900 border border-rose-300 dark:border-rose-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/30"
              />
              <button
                type="button"
                disabled={!hasAnyTargetSelected || !isPhraseValid || isExecuting}
                onClick={() => void handleExecuteReset()}
                className="h-11 px-5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-45 shadow-sm cursor-pointer whitespace-nowrap"
              >
                <Trash2 className={`w-4 h-4 ${isExecuting ? 'animate-pulse' : ''}`} />
                <span>{isExecuting ? 'در حال پاکسازی...' : 'اجرای قطعی بازنشانی'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmStepOpen(false);
                  setConfirmPhrase('');
                }}
                className="h-11 px-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                انصراف
              </button>
            </div>
          </motion.div>
        )}

        {/* Execution Result Summary */}
        {executionReport && (
          <div className="p-4 rounded-xl bg-emerald-50/75 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/70 space-y-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold text-emerald-900 dark:text-emerald-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>گزارش اجرای بازنشانی (ساعت {toPersianDigits(executionReport.completedAt)})</span>
              </div>
              {executionReport.shouldReload && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>بارگذاری مجدد صفحه (شروع کاملاً تمیز)</span>
                </button>
              )}
            </div>
            <ul className="space-y-1 text-emerald-800 dark:text-emerald-200 pr-2">
              {executionReport.succeeded.map((line, i) => (
                <li key={i}>• {line}</li>
              ))}
            </ul>
            {executionReport.warnings.length > 0 && (
              <div className="pt-2 border-t border-emerald-200/70 dark:border-emerald-900/60 space-y-1 text-amber-800 dark:text-amber-300">
                {executionReport.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
