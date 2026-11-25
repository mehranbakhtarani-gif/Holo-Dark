import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  FileWarning,
  Laptop,
  Network,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  PendingSyncConflict,
  SyncConflictResolutionChoice,
} from '../lib/syncConflictResolver';
import { toPersianDigits } from '../lib/format';

interface SyncConflictResolutionModalProps {
  conflict: PendingSyncConflict | null;
  isResolving?: boolean;
  onResolve: (
    choice: SyncConflictResolutionChoice,
    rememberAsDefault: boolean
  ) => Promise<boolean> | void;
  onDismiss: () => void;
}

export const SyncConflictResolutionModal: React.FC<SyncConflictResolutionModalProps> = ({
  conflict,
  isResolving = false,
  onResolve,
  onDismiss,
}) => {
  const [rememberAsDefault, setRememberAsDefault] = useState(true);
  const [submittingChoice, setSubmittingChoice] = useState<SyncConflictResolutionChoice | null>(
    null
  );

  useEffect(() => {
    if (conflict) {
      setRememberAsDefault(true);
      setSubmittingChoice(null);
    }
  }, [conflict?.id]);

  if (!conflict) return null;

  const { summary } = conflict;
  const isP2P = conflict.source === 'p2p_mesh';
  const remoteTitle = isP2P ? 'نسخه دستگاه همتا (P2P)' : 'نسخه ابری (سرور)';
  const restoreLabel = isP2P ? 'بازگردانی نسخه همتا / ابری' : 'بازگردانی نسخه ابری';

  const handleChoose = async (choice: SyncConflictResolutionChoice) => {
    if (isResolving || submittingChoice) return;
    setSubmittingChoice(choice);
    try {
      await onResolve(choice, rememberAsDefault);
    } finally {
      setSubmittingChoice(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-conflict-modal-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-amber-300/80 dark:border-amber-700/60 shadow-2xl overflow-hidden text-right">
        {/* Header */}
        <div className="px-5 py-4 bg-amber-50/90 dark:bg-amber-950/40 border-b border-amber-200/80 dark:border-amber-800/60 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </span>
            <div>
              <h2
                id="sync-conflict-modal-title"
                className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white"
              >
                تداخل در همگام‌سازی اسناد حسابداری شناسایی شد
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-5">
                اسناد این دستگاه با{' '}
                <span className="font-bold text-slate-900 dark:text-white">
                  {conflict.sourceLabel}
                </span>{' '}
                ({conflict.remoteDeviceLabel}) همزمان تغییر کرده‌اند. لطفاً مشخص کنید کدام نسخه ملاک
                قرار گیرد:
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            disabled={isResolving || Boolean(submittingChoice)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-amber-100/70 dark:hover:bg-white/10 disabled:opacity-50"
            aria-label="بستن پنجره تداخل"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Side-by-Side Comparison Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Local Version Card */}
            <div className="p-3.5 rounded-xl bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200/80 dark:border-teal-800/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-bold text-teal-900 dark:text-teal-200">
                  <Laptop className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                  <span>آخرین تغییر محلی (این دستگاه)</span>
                </span>
                {conflict.localRevision > 0 && (
                  <span className="font-code text-[11px] font-semibold text-teal-700 dark:text-teal-300">
                    نسخه #{toPersianDigits(conflict.localRevision)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-slate-700 dark:text-slate-300">
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-teal-100 dark:border-teal-900/60">
                  اسناد: <strong className="font-code">{toPersianDigits(summary.localCounts.vouchers)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-teal-100 dark:border-teal-900/60">
                  فاکتورها: <strong className="font-code">{toPersianDigits(summary.localCounts.invoices)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-teal-100 dark:border-teal-900/60">
                  کالاها: <strong className="font-code">{toPersianDigits(summary.localCounts.products)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-teal-100 dark:border-teal-900/60">
                  چک و اشخاص:{' '}
                  <strong className="font-code">
                    {toPersianDigits(summary.localCounts.cheques + summary.localCounts.parties)}
                  </strong>
                </div>
              </div>
            </div>

            {/* Cloud / Remote Version Card */}
            <div className="p-3.5 rounded-xl bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200/80 dark:border-sky-800/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-bold text-sky-900 dark:text-sky-200">
                  {isP2P ? (
                    <Network className="w-4 h-4 text-sky-700 dark:text-sky-400" />
                  ) : (
                    <Cloud className="w-4 h-4 text-sky-700 dark:text-sky-400" />
                  )}
                  <span>{remoteTitle}</span>
                </span>
                {conflict.remoteRevision > 0 && (
                  <span className="font-code text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                    نسخه #{toPersianDigits(conflict.remoteRevision)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-slate-700 dark:text-slate-300">
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900/60">
                  اسناد: <strong className="font-code">{toPersianDigits(summary.remoteCounts.vouchers)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900/60">
                  فاکتورها: <strong className="font-code">{toPersianDigits(summary.remoteCounts.invoices)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900/60">
                  کالاها: <strong className="font-code">{toPersianDigits(summary.remoteCounts.products)}</strong>
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900/60">
                  چک و اشخاص:{' '}
                  <strong className="font-code">
                    {toPersianDigits(summary.remoteCounts.cheques + summary.remoteCounts.parties)}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          {/* Conflicting Documents Breakdown */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                <FileWarning className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>
                  جزئیات اسناد دارای اختلاف ({toPersianDigits(summary.totalConflictingDocs)} مورد)
                </span>
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-code">
                ویرایش همزمان: {toPersianDigits(summary.modifiedCount)} · فقط محلی:{' '}
                {toPersianDigits(summary.localOnlyCount)} · فقط ابری:{' '}
                {toPersianDigits(summary.remoteOnlyCount)}
              </span>
            </div>

            {summary.previews.length === 0 ? (
              <div className="p-3.5 text-[11px] text-slate-600 dark:text-slate-400 leading-5">
                اختلاف در نسخه متادیتا یا تنظیمات فضای کاری شناسایی شده است. انتخاب شما مشخص می‌کند
                کدام نسخه به‌عنوان وضعیت نهایی ثبت شود.
              </div>
            ) : (
              <div className="divide-y divide-slate-200/70 dark:divide-slate-800 max-h-48 overflow-y-auto">
                {summary.previews.map((doc) => (
                  <div
                    key={`${doc.collection}_${doc.id}`}
                    className="px-3.5 py-2.5 space-y-1 bg-white/70 dark:bg-slate-900/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-slate-800 dark:text-slate-100 truncate">
                        {doc.title}
                      </span>
                      <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 shrink-0">
                        {doc.collectionLabel}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                      <div className="text-teal-800 dark:text-teal-300">
                        <span className="font-semibold">محلی: </span>
                        {doc.localSummary}
                      </div>
                      <div className="text-sky-800 dark:text-sky-300">
                        <span className="font-semibold">ابری/همتا: </span>
                        {doc.remoteSummary}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Save as Future Default Checkbox */}
          <label className="flex items-start gap-2.5 p-3.5 rounded-xl bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rememberAsDefault}
              onChange={(e) => setRememberAsDefault(e.target.checked)}
              disabled={isResolving || Boolean(submittingChoice)}
              className="mt-0.5 w-4 h-4 rounded accent-teal-700 cursor-pointer"
            />
            <div className="space-y-0.5">
              <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>این انتخاب را به‌عنوان پیش‌فرض حل خودکار تداخلات آینده ذخیره کن</span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-5">
                با فعال بودن این گزینه، تداخل‌های بعدی بدون مزاحمت و به‌صورت خودکار طبق انتخاب فعلی
                شما حل و در تاریخچه ممیزی ثبت می‌شوند (هر زمان از بخش تنظیمات قابل تغییر است).
              </p>
            </div>
          </label>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-4 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          <button
            type="button"
            onClick={onDismiss}
            disabled={isResolving || Boolean(submittingChoice)}
            className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            تصمیم‌گیری بعدی
          </button>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <button
              type="button"
              onClick={() => void handleChoose('restore_remote')}
              disabled={isResolving || Boolean(submittingChoice)}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-sky-700 hover:bg-sky-800 text-white text-xs font-bold shadow-sm disabled:opacity-50 transition-colors"
            >
              {submittingChoice === 'restore_remote' ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowDownToLine className="w-4 h-4" />
              )}
              <span>{restoreLabel}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleChoose('keep_local')}
              disabled={isResolving || Boolean(submittingChoice)}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold shadow-sm disabled:opacity-50 transition-colors"
            >
              {submittingChoice === 'keep_local' ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUpFromLine className="w-4 h-4" />
              )}
              <span>حفظ آخرین تغییر محلی</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
