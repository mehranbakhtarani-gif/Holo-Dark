import React, { useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { MoreHorizontal } from 'lucide-react';
import type { ActiveModule, AuditActivityLog, CurrencyUnit, Product } from '../../types/accounting';
import type { ChequeAlertItem } from '../../lib/chequeAlerts';
import { formatCompactMoney, toPersianDigits } from '../../lib/format';

interface ActivityRowItem {
  id: string;
  time: string;
  action: string;
  user: string;
  reference: string;
  onClick: () => void;
}

interface BentoOperationalBottomRowProps {
  products: Product[];
  auditLogs: AuditActivityLog[];
  urgentCheques: ChequeAlertItem[];
  fallbackActivityRows: ActivityRowItem[];
  unit: CurrencyUnit;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}

const DONUT_COLORS = ['#10B981', '#F59E0B', '#6366F1', '#EF4444', '#818CF8'];

export const BentoOperationalBottomRow: React.FC<BentoOperationalBottomRowProps> = ({
  products,
  auditLogs,
  urgentCheques,
  fallbackActivityRows,
  unit,
  onNavigate,
}) => {
  const [rightCardTab, setRightCardTab] = useState<'activity' | 'cheques'>('activity');

  const inventoryStats = useMemo(() => {
    const totalStock = Math.round(products.reduce((s, p) => s + Math.max(0, p.stock), 0));
    const outOfStockCount = products.filter((p) => p.stock <= 0).length;
    const lowStockCount = products.filter((p) => p.stock > 0 && p.stock < p.reorderPoint).length;

    const catMap = new Map<string, number>();
    products.forEach((p) => {
      const key = p.category || 'عمومی';
      catMap.set(key, (catMap.get(key) ?? 0) + Math.max(1, p.stock));
    });

    const categories = Array.from(catMap.entries())
      .map(([name, value], idx) => ({
        name,
        value: Math.round(value),
        color: DONUT_COLORS[idx % DONUT_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    // Prioritize showing a realistic mix: out-of-stock / low-stock + top stocked items
    const sortedItems = [...products].sort((a, b) => {
      const aScore = a.stock <= 0 ? 0 : a.stock < a.reorderPoint ? 1 : 2;
      const bScore = b.stock <= 0 ? 0 : b.stock < b.reorderPoint ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return b.stock - a.stock;
    });

    return {
      totalStock,
      lowStockCount,
      outOfStockCount,
      categories,
      previewItems: sortedItems.slice(0, 4),
    };
  }, [products]);

  const activityRows = useMemo<ActivityRowItem[]>(() => {
    if (auditLogs.length > 0) {
      return auditLogs.slice(0, 5).map((log) => ({
        id: log.id,
        time: toPersianDigits(log.timestamp.split(' ').slice(-1)[0] || log.timestamp),
        action: log.action,
        user: log.operatorName,
        reference: log.module || 'حسابداری',
        onClick: () => onNavigate('settings', 'audit-log', 'tool-audit-log'),
      }));
    }
    return fallbackActivityRows.slice(0, 5);
  }, [auditLogs, fallbackActivityRows, onNavigate]);

  return (
    <section
      aria-label="وضعیت انبار و گزارش فعالیت‌های اخیر"
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch"
    >
      {/* Card 1: Inventory Metrics (3 Counters + Donut Ring + Swiss Mini-Table) */}
      <div className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] p-5 flex flex-col justify-between gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm sm:text-[15px] font-bold text-[#0F172A] dark:text-white tracking-tight">
            شاخص‌های انبار و موجودی کالا
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('inventory', undefined, 'inv-products')}
            title="مدیریت کامل انبار و کالا"
            aria-label="مدیریت کامل انبار و کالا"
            className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>

        {/* Top Summary Row: 3 Large Color-Coded Counters + Compact Donut Ring */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
          <div className="sm:col-span-8 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                موجودی کل
              </div>
              <div className="mt-1 text-xl sm:text-2xl font-extrabold text-emerald-600 dark:text-[#10B981] tabular-nums font-code tracking-tight">
                {toPersianDigits(inventoryStats.totalStock.toLocaleString('en-US'))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                کم‌موجود
              </div>
              <div className="mt-1 text-xl sm:text-2xl font-extrabold text-amber-600 dark:text-[#F59E0B] tabular-nums font-code tracking-tight">
                {toPersianDigits(inventoryStats.lowStockCount)}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                ناموجود
              </div>
              <div className="mt-1 text-xl sm:text-2xl font-extrabold text-red-600 dark:text-[#EF4444] tabular-nums font-code tracking-tight">
                {toPersianDigits(inventoryStats.outOfStockCount)}
              </div>
            </div>
          </div>

          <div className="sm:col-span-4 flex flex-col items-center">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              دسته‌بندی‌ها
            </div>
            <div className="w-24 h-24" dir="ltr">
              {inventoryStats.categories.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={inventoryStats.categories}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={26}
                      outerRadius={42}
                      paddingAngle={2}
                      stroke="none"
                    >
                      {inventoryStats.categories.map((cat) => (
                        <Cell key={cat.name} fill={cat.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const item = payload[0];
                        return (
                          <div
                            dir="rtl"
                            className="rounded-lg bg-[#0B0F17]/95 text-white border border-white/15 px-2.5 py-1.5 text-[11px] shadow-lg"
                          >
                            <span className="font-semibold">{String(item.name)}</span>:{' '}
                            <span className="font-code tabular-nums">
                              {toPersianDigits(Number(item.value ?? 0).toLocaleString('en-US'))}
                            </span>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full rounded-full border-4 border-slate-200 dark:border-white/10 flex items-center justify-center text-[10px] text-slate-400">
                  خالی
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Clean Borderless Swiss-Minimalist Inventory Mini-Table */}
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="border-b border-slate-200/80 dark:border-white/[0.06] text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <th className="py-2 font-medium">نام کالا</th>
                <th className="py-2 font-medium">کد SKU</th>
                <th className="py-2 font-medium">موجودی</th>
                <th className="py-2 font-medium text-left">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05] text-xs">
              {inventoryStats.previewItems.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500 dark:text-slate-400">
                    هنوز کالایی در انبار ثبت نشده است.
                  </td>
                </tr>
              ) : (
                inventoryStats.previewItems.map((prod) => {
                  const status =
                    prod.stock <= 0
                      ? {
                          label: 'ناموجود',
                          cls: 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20',
                        }
                      : prod.stock < prod.reorderPoint
                        ? {
                            label: 'کم‌موجود',
                            cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20',
                          }
                        : {
                            label: 'موجود',
                            cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
                          };
                  return (
                    <tr
                      key={prod.id}
                      onClick={() => onNavigate('inventory', undefined, 'inv-products')}
                      className="hover:bg-slate-50/80 dark:hover:bg-white/[0.03] transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 pl-2 font-medium text-[#0F172A] dark:text-slate-100 max-w-[170px] truncate">
                        {prod.name}
                      </td>
                      <td className="py-2.5 pl-2 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {prod.sku}
                      </td>
                      <td className="py-2.5 pl-2 font-code tabular-nums font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                        {toPersianDigits(prod.stock.toLocaleString('en-US'))}
                      </td>
                      <td className="py-2.5 text-left whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-semibold ${status.cls}`}
                        >
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Card 2: Recent Activity Logs & Urgent Cheques (Swiss Minimalist Table) */}
      <div className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] p-5 flex flex-col justify-between gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-[15px] font-bold text-[#0F172A] dark:text-white tracking-tight">
              {rightCardTab === 'activity' ? 'گزارش فعالیت‌های اخیر' : 'چک‌های سررسید امروز و نزدیک'}
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              {rightCardTab === 'activity'
                ? 'ثبت زنده رویدادها و اسناد مالی'
                : 'اولویت وصول و پرداخت خزانه‌داری'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center p-0.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17]/75 border border-slate-200/80 dark:border-white/[0.08]">
              <button
                type="button"
                onClick={() => setRightCardTab('activity')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  rightCardTab === 'activity'
                    ? 'bg-white dark:bg-white/[0.12] text-[#0F172A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                فعالیت‌ها
              </button>
              <button
                type="button"
                onClick={() => setRightCardTab('cheques')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  rightCardTab === 'cheques'
                    ? 'bg-white dark:bg-white/[0.12] text-[#0F172A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <span>چک‌های سررسید</span>
                {urgentCheques.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-md bg-indigo-500/20 text-indigo-600 dark:text-[#818CF8] font-code tabular-nums text-[10px] font-bold">
                    {toPersianDigits(urgentCheques.length)}
                  </span>
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={() =>
                rightCardTab === 'activity'
                  ? onNavigate('settings', 'audit-log', 'tool-audit-log')
                  : onNavigate('treasury', 'cheques', 'tr-cheques')
              }
              title="مشاهده فهرست کامل"
              aria-label="مشاهده فهرست کامل"
              className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Clean Borderless Swiss-Minimalist Table */}
        <div className="flex-1 overflow-x-auto -mx-1 px-1">
          {rightCardTab === 'activity' ? (
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200/80 dark:border-white/[0.06] text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 font-medium">زمان</th>
                  <th className="py-2.5 font-medium">عملیات</th>
                  <th className="py-2.5 font-medium">کاربر</th>
                  <th className="py-2.5 font-medium text-left">پروژه / سند</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05] text-xs">
                {activityRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500 dark:text-slate-400">
                      هنوز رویداد عملیاتی ثبت نشده است.
                    </td>
                  </tr>
                ) : (
                  activityRows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={row.onClick}
                      className="hover:bg-slate-50/80 dark:hover:bg-white/[0.03] transition-colors cursor-pointer"
                    >
                      <td className="py-3 pl-2 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {row.time}
                      </td>
                      <td className="py-3 pl-2 font-medium text-[#0F172A] dark:text-slate-100 max-w-[190px] truncate">
                        {row.action}
                      </td>
                      <td className="py-3 pl-2 text-slate-600 dark:text-slate-300 whitespace-nowrap truncate max-w-[110px]">
                        {row.user}
                      </td>
                      <td className="py-3 text-left text-slate-500 dark:text-slate-400 whitespace-nowrap font-code tabular-nums">
                        {row.reference}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200/80 dark:border-white/[0.06] text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 font-medium">سررسید</th>
                  <th className="py-2.5 font-medium">طرف‌حساب</th>
                  <th className="py-2.5 font-medium">مبلغ</th>
                  <th className="py-2.5 font-medium text-left">وضعیت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05] text-xs">
                {urgentCheques.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500 dark:text-slate-400">
                      چک سررسید نزدیک یا معوقی وجود ندارد.
                    </td>
                  </tr>
                ) : (
                  urgentCheques.slice(0, 5).map((alert) => {
                    const ch = alert.cheque;
                    const isCritical =
                      alert.severity === 'bounced' ||
                      alert.severity === 'overdue' ||
                      alert.severity === 'today';
                    return (
                      <tr
                        key={ch.id}
                        onClick={() => onNavigate('treasury', `cheque:${ch.id}`, 'tr-cheques')}
                        className="hover:bg-slate-50/80 dark:hover:bg-white/[0.03] transition-colors cursor-pointer"
                      >
                        <td className="py-3 pl-2 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {toPersianDigits(ch.dueDate)}
                        </td>
                        <td className="py-3 pl-2 font-medium text-[#0F172A] dark:text-slate-100 max-w-[160px] truncate">
                          {ch.partyName}
                        </td>
                        <td className="py-3 pl-2 font-code tabular-nums font-semibold text-[#0F172A] dark:text-white whitespace-nowrap">
                          {formatCompactMoney(ch.amount, unit)}
                        </td>
                        <td className="py-3 text-left whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-semibold ${
                              isCritical
                                ? 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20'
                                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                            }`}
                          >
                            {alert.urgencyLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
};
