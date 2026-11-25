import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, ChevronLeft, Clock, FileText, Plus } from 'lucide-react';
import type { ActiveModule, CurrencyUnit, Invoice } from '../../types/accounting';
import { formatMoney, toPersianDigits } from '../../lib/format';
import { HighlightedText } from '../FuzzyTableSearch';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

interface RecentInvoicesBentoCardProps {
  invoices: Invoice[];
  totalInvoicesCount: number;
  quickSearch: string;
  onClearSearch: () => void;
  unit: CurrencyUnit;
  currencyWord: string;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  dragControls?: React.ReactNode;
}

export const RecentInvoicesBentoCard: React.FC<RecentInvoicesBentoCardProps> = ({
  invoices,
  totalInvoicesCount,
  quickSearch,
  onClearSearch,
  unit,
  currencyWord,
  onNavigate,
  dragControls,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...snappySpring, delay: 0.08 }}
      className="h-full bg-white dark:bg-slate-900/95 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] overflow-hidden flex flex-col"
    >
      <div className="p-5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          {dragControls}
          <div className="min-w-0">
            <h2 className="font-bold text-base text-slate-900 dark:text-white truncate">
              آخرین اسناد و فاکتورها
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
              {quickSearch.trim()
                ? `${toPersianDigits(invoices.length)} نتیجه مطابق با «${quickSearch.trim()}»`
                : `نمایش ${toPersianDigits(invoices.length)} فاکتور اخیر از مجموع ${toPersianDigits(totalInvoicesCount)} فاکتور ثبت‌شده`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('invoices')}
          className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 inline-flex items-center gap-1 whitespace-nowrap shrink-0 min-h-[36px] px-2 cursor-pointer"
        >
          <span>مشاهده همه</span>
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {invoices.length === 0 ? (
        <div className="p-8 text-center flex-1 flex flex-col items-center justify-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center">
            <FileText className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {quickSearch.trim() ? 'فاکتوری مطابق با جستجو یافت نشد' : 'هنوز فاکتوری ثبت نشده است'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {quickSearch.trim()
                ? 'عبارت جستجو را تغییر دهید یا پاک کنید تا لیست کامل فاکتورها نمایش داده شود.'
                : 'اولین فاکتور فروش یا پیش‌فاکتور را صادر کنید تا در این بخش نمایش داده شود.'}
            </p>
          </div>
          {quickSearch.trim() ? (
            <button
              type="button"
              onClick={onClearSearch}
              className="h-10 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            >
              پاک کردن جستجو
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('invoices', 'new-sale', 'inv-sale')}
              className="h-10 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>صدور اولین فاکتور</span>
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Desktop Swiss Minimalist Table */}
          <div className="hidden sm:block overflow-x-auto flex-1">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-slate-50/70 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400 text-xs border-b border-slate-100 dark:border-slate-800/80">
                  <th className="py-3.5 px-5 font-medium whitespace-nowrap">شماره فاکتور</th>
                  <th className="py-3.5 px-5 font-medium">طرف حساب</th>
                  <th className="py-3.5 px-5 font-medium whitespace-nowrap">تاریخ</th>
                  <th className="py-3.5 px-5 font-medium whitespace-nowrap">مبلغ ({currencyWord})</th>
                  <th className="py-3.5 px-5 font-medium whitespace-nowrap">وضعیت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-sm">
                {invoices.map((inv) => {
                  const isProforma = inv.invoiceType === 'proforma';
                  const isOfficialTax =
                    inv.invoiceType === 'sale' || inv.invoiceType === 'sale_return';
                  const isSettled = inv.status === 'settled';
                  const isCancelled = inv.status === 'cancelled';
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => onNavigate('invoices')}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                    >
                      <td className="py-3.5 px-5 font-code font-semibold text-slate-700 dark:text-slate-200 tabular-nums whitespace-nowrap">
                        <div>
                          <HighlightedText text={toPersianDigits(inv.invoiceNumber)} query={quickSearch} />
                        </div>
                        <div
                          className={`text-[11px] font-sans font-medium mt-0.5 ${
                            isProforma
                              ? 'text-amber-700 dark:text-amber-400'
                              : isOfficialTax
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {isProforma
                            ? 'پیش‌فاکتور'
                            : inv.invoiceType === 'purchase'
                              ? 'فاکتور خرید'
                              : inv.invoiceType === 'sale_return'
                                ? 'برگشت از فروش'
                                : inv.invoiceType === 'purchase_return'
                                  ? 'برگشت از خرید'
                                  : 'رسمی / مودیان'}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 font-medium text-slate-900 dark:text-slate-100 max-w-[220px] truncate">
                        <HighlightedText text={inv.partyName} query={quickSearch} />
                      </td>
                      <td className="py-3.5 px-5 text-slate-500 dark:text-slate-400 text-xs font-code tabular-nums whitespace-nowrap">
                        <HighlightedText text={toPersianDigits(inv.date)} query={quickSearch} />
                      </td>
                      <td className="py-3.5 px-5 font-bold font-code text-slate-900 dark:text-white tabular-nums whitespace-nowrap">
                        {formatMoney(inv.grandTotal, unit, false)}
                      </td>
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                            isSettled
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : isCancelled
                                ? 'text-rose-700 dark:text-rose-400'
                                : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {isSettled ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          ) : isCancelled ? (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <Clock className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>
                            {isSettled
                              ? 'تسویه‌شده'
                              : isCancelled
                                ? 'ابطال‌شده'
                                : isProforma
                                  ? 'در انتظار تبدیل'
                                  : 'در انتظار وصول'}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Structured Cards */}
          <div className="sm:hidden divide-y divide-slate-100 dark:divide-slate-800/80">
            {invoices.map((inv) => {
              const isProforma = inv.invoiceType === 'proforma';
              const isSettled = inv.status === 'settled';
              const isCancelled = inv.status === 'cancelled';
              return (
                <button
                  key={inv.id}
                  type="button"
                  onClick={() => onNavigate('invoices')}
                  className="w-full p-4 text-right space-y-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                        <HighlightedText text={inv.partyName} query={quickSearch} />
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 font-code tabular-nums">
                        <span>
                          <HighlightedText text={toPersianDigits(inv.invoiceNumber)} query={quickSearch} />
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          <HighlightedText text={toPersianDigits(inv.date)} query={quickSearch} />
                        </span>
                      </div>
                    </div>
                    <span
                      className={`text-xs font-semibold shrink-0 ${
                        isSettled
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : isCancelled
                            ? 'text-rose-700 dark:text-rose-400'
                            : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {isSettled ? 'تسویه‌شده' : isCancelled ? 'ابطال‌شده' : 'در انتظار'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span
                      className={`text-xs font-medium ${
                        isProforma
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {isProforma ? 'پیش‌فاکتور' : 'فاکتور رسمی / مودیان'}
                    </span>
                    <span className="font-bold font-code text-sm text-slate-900 dark:text-white tabular-nums">
                      {formatMoney(inv.grandTotal, unit, false)}{' '}
                      <span className="text-[11px] font-sans font-normal text-slate-500">
                        {currencyWord}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </motion.div>
  );
};
