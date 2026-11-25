import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Maximize2, ShieldCheck, Sparkles } from 'lucide-react';
import type { ActiveModule, CurrencyUnit, Voucher } from '../../types/accounting';
import { computeCashFlowLiquidityRadar } from '../../lib/smartIntelligence';
import { formatCompactMoney, formatMoney, toPersianDigits } from '../../lib/format';
import { LiveFxTickerCard } from '../LiveFxTickerCard';
import { DashboardWidget } from '../DashboardWidget';
import type { AnalyticsExpandCardId } from './DashboardCardExpandModal';

type CashFlowLiquidityRadar = ReturnType<typeof computeCashFlowLiquidityRadar>;

interface CashFlowDatum {
  month: string;
  ورودی: number;
  خروجی: number;
  مانده: number;
}

interface ExpensePieDatum {
  code: string;
  name: string;
  rawAmount: number;
  value: number;
  pct: number;
  color: string;
}

interface PnlBarDatum {
  month: string;
  درآمد: number;
  هزینه: number;
  سود: number;
}

interface BankBalanceDatum {
  code: string;
  name: string;
  fullTitle: string;
  rawBalance: number;
  مانده: number;
  isBank: boolean;
  color: string;
}

interface AnalyticsSuitePanelProps {
  unit: CurrencyUnit;
  unitLabel: string;
  currencyWord: string;
  liquidityRadar: CashFlowLiquidityRadar;
  cashFlowChartData: CashFlowDatum[];
  expensePieData: ExpensePieDatum[];
  pnlBarData: PnlBarDatum[];
  bankBalancesData: BankBalanceDatum[];
  recentVouchers: Voucher[];
  totalVouchersCount: number;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onOpenCopilot?: () => void;
  onExpandCard?: (cardId: AnalyticsExpandCardId) => void;
}

export const AnalyticsSuitePanel: React.FC<AnalyticsSuitePanelProps> = ({
  unit,
  unitLabel,
  currencyWord,
  liquidityRadar,
  cashFlowChartData,
  expensePieData,
  pnlBarData,
  bankBalancesData,
  recentVouchers,
  totalVouchersCount,
  onNavigate,
  onOpenCopilot,
  onExpandCard,
}) => {
  const renderExpandButton = (cardId: AnalyticsExpandCardId, title: string) =>
    onExpandCard ? (
      <button
        type="button"
        onClick={() => onExpandCard(cardId)}
        title={`نمایش «${title}» در ابعاد کامل`}
        aria-label={`نمایش در ابعاد کامل ${title}`}
        className="h-8 w-8 rounded-lg border border-transparent text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700 inline-flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
      >
        <Maximize2 className="w-3.5 h-3.5 shrink-0" />
      </button>
    ) : null;
  const tooltipStyle = {
    borderRadius: '10px',
    border: '1px solid #cbd5e1',
    backgroundColor: '#ffffff',
    color: '#0f172a',
    fontSize: '12px',
    direction: 'rtl' as const,
    textAlign: 'right' as const,
  };

  return (
    <div className="space-y-6">
      {/* Live Free-Market FX Ticker Card */}
      <LiveFxTickerCard onNavigate={onNavigate} />

      {/* Smart 30-Day Cash-Flow & Cheque Liquidity Radar */}
      <section
        aria-label="رادار هوشمند نقدینگی ۳۰ روزه"
        className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-5 space-y-4 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)]"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                liquidityRadar.riskLevel === 'critical'
                  ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                  : liquidityRadar.riskLevel === 'watch'
                    ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                    : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
              }`}
            >
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  رادار هوشمند نقدینگی و پیش‌بینی ۳۰ روزه چک‌ها
                </h2>
                <span
                  className={`text-[11px] font-semibold ${
                    liquidityRadar.riskLevel === 'critical'
                      ? 'text-rose-700 dark:text-rose-400'
                      : liquidityRadar.riskLevel === 'watch'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  ·{' '}
                  {liquidityRadar.riskLevel === 'critical'
                    ? 'هشدار کسری یا چک برگشتی'
                    : liquidityRadar.riskLevel === 'watch'
                      ? 'نیاز به مدیریت نقدینگی'
                      : 'نقدینگی ایمن در ۳۰ روز آینده'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                شبیه‌سازی آنی مانده نقد و بانک پس از وصول{' '}
                {toPersianDigits(liquidityRadar.upcomingReceivableCount)} چک دریافتی و پاس‌شدن{' '}
                {toPersianDigits(liquidityRadar.upcomingPayableCount)} چک پرداختی
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {renderExpandButton('analytics:radar', 'رادار هوشمند نقدینگی ۳۰ روزه')}
            <button
              type="button"
              onClick={() => onNavigate('treasury', 'cheques', 'tr-cheques')}
              className="h-9 px-3 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
            >
              بررسی چک‌ها
            </button>
            {onOpenCopilot && (
              <button
                type="button"
                onClick={onOpenCopilot}
                className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>تحلیل هوشمند AI</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {liquidityRadar.horizons.map((h) => (
            <div
              key={h.horizonDays}
              className={`rounded-xl border p-4 ${
                h.hasDeficit
                  ? 'border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/25'
                  : 'border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40'
              }`}
            >
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{h.label}</span>
                <span className="font-code text-[11px]">
                  {h.hasDeficit ? 'کسری نقدینگی' : 'مانده پیش‌بینی'}
                </span>
              </div>
              <div
                className={`text-lg font-bold font-code tabular-nums mt-1.5 ${
                  h.hasDeficit
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-slate-900 dark:text-white'
                }`}
              >
                {formatCompactMoney(h.projectedBalance, unit)}
              </div>
              <div className="mt-2.5 pt-2 border-t border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-[11px] font-code tabular-nums">
                <span className="text-emerald-700 dark:text-emerald-400">
                  + دریافتی: {formatCompactMoney(h.receivableInflow, unit)}
                </span>
                <span className="text-rose-700 dark:text-rose-400">
                  − پرداختی: {formatCompactMoney(h.payableOutflow, unit)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {(liquidityRadar.earliestDeficitDate || liquidityRadar.bouncedChequesTotal > 0) && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-800 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span className="tabular-nums">
                {liquidityRadar.earliestDeficitDate
                  ? `نخستین نقطه کسری نقدینگی در تاریخ ${toPersianDigits(liquidityRadar.earliestDeficitDate)} به مبلغ ${formatCompactMoney(liquidityRadar.earliestDeficitAmount, unit)} پیش‌بینی می‌شود.`
                  : `مبلغ ${formatCompactMoney(liquidityRadar.bouncedChequesTotal, unit)} چک برگشتی حل‌نشده در سیستم ثبت شده است.`}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('treasury', 'cheques', 'tr-cheques')}
              className="font-semibold underline whitespace-nowrap cursor-pointer"
            >
              مدیریت و جابه‌جایی سررسید
            </button>
          </div>
        )}
      </section>

      {/* Daily Revenue & Recent Expenses Trend Widget */}
      <DashboardWidget onNavigate={onNavigate} />

      {/* 4 Recharts Financial Widgets Grid (2x2 Bento) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Widget 1: Monthly Cash Flow */}
        <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                جریان نقدینگی ماهانه (ورودی، خروجی و مانده نقد)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                بر حسب {unitLabel} — محاسبه‌شده از گردش صندوق و بانک‌ها
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('treasury')}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                جزئیات خزانه
              </button>
              {renderExpandButton('analytics:cashflow', 'جریان نقدینگی ماهانه')}
            </div>
          </div>
          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cashFlowChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown, name: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                <Line
                  type="monotone"
                  dataKey="مانده"
                  name="مانده تجمعی نقد"
                  stroke="#4f46e5"
                  strokeWidth={2.5}
                  dot={{ r: 3.5, fill: '#4f46e5' }}
                  activeDot={{ r: 5 }}
                />
                <Line
                  type="monotone"
                  dataKey="ورودی"
                  name="ورودی نقدی"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#10b981' }}
                />
                <Line
                  type="monotone"
                  dataKey="خروجی"
                  name="خروجی نقدی"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={{ r: 3, fill: '#f43f5e' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Widget 2: Expense Composition */}
        <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                ترکیب هزینه‌ها و بهای تمام‌شده
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                سهم هر سرفصل هزینه‌ای از کل هزینه‌های ثبت‌شده دوره
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                تراز آزمایشی
              </button>
              {renderExpandButton('analytics:expenses', 'ترکیب هزینه‌ها و بهای تمام‌شده')}
            </div>
          </div>

          {expensePieData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs text-slate-500">
              هنوز سرفصل هزینه‌ای در اسناد دوره ثبت نشده است.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
              <div className="sm:col-span-6 h-60 w-full" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={expensePieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={86}
                      paddingAngle={2}
                    >
                      {expensePieData.map((entry) => (
                        <Cell key={entry.code} fill={entry.color} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: unknown, name: unknown) => [
                        `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                        String(name),
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="sm:col-span-6 divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {expensePieData.map((item) => (
                  <div key={item.code} className="py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: item.color }}
                        aria-hidden="true"
                      />
                      <span className="text-slate-700 dark:text-slate-300 truncate" title={item.name}>
                        {item.name}
                      </span>
                    </div>
                    <div className="text-left shrink-0 font-code tabular-nums">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {toPersianDigits(item.pct)}٪
                      </span>
                      <div className="text-[11px] text-slate-500">
                        {formatCompactMoney(item.rawAmount, unit)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Widget 3: Profit & Loss */}
        <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                نمودار سود و زیان ماهانه
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                مقایسه درآمد فروش، کل بهای تمام‌شده/هزینه‌ها و سود خالص ({unitLabel})
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                صورت سود و زیان
              </button>
              {renderExpandButton('analytics:pnl', 'نمودار سود و زیان ماهانه')}
            </div>
          </div>
          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pnlBarData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown, name: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                <Bar dataKey="درآمد" name="درآمد فروش" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                <Bar dataKey="هزینه" name="بهای تمام‌شده و هزینه" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="سود" name="سود (زیان) خالص" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Widget 4: Bank & Cash Accounts Balances */}
        <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                مانده حساب‌های بانکی و صندوق‌ها
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                مانده لحظه‌ای حساب‌های کدینگ ۱۰۱ و ۱۰۲ بر حسب {unitLabel}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                دفتر بانک‌ها
              </button>
              {renderExpandButton('analytics:banks', 'مانده حساب‌های بانکی و صندوق‌ها')}
            </div>
          </div>

          <div className="h-44 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bankBalancesData}
                layout="vertical"
                margin={{ top: 4, right: 20, left: 10, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={108}
                  tick={{ fontSize: 11, fill: '#475569' }}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    'مانده حساب',
                  ]}
                />
                <Bar dataKey="مانده" radius={[0, 4, 4, 0]} barSize={20}>
                  {bankBalancesData.map((entry) => (
                    <Cell key={entry.code} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {bankBalancesData.map((b) => (
              <div key={b.code} className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-slate-600 dark:text-slate-400 truncate" title={b.fullTitle}>
                  <span className="font-code text-[11px] text-slate-400 ml-1 tabular-nums">{b.code}</span>
                  {b.name}
                </span>
                <span className="font-code tabular-nums font-semibold text-slate-900 dark:text-white shrink-0">
                  {formatCompactMoney(b.rawBalance, unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Vouchers Bento Table + Mobile Cards */}
      <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/80 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            آخرین اسناد حسابداری ثبت‌شده
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('vouchers')}
              className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap cursor-pointer tabular-nums"
            >
              دفتر روزنامه ({toPersianDigits(totalVouchersCount)} سند)
            </button>
            {renderExpandButton('analytics:vouchers', 'آخرین اسناد حسابداری ثبت‌شده')}
          </div>
        </div>

        {recentVouchers.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            هنوز سند حسابداری در این دوره ثبت نشده است.
          </div>
        ) : (
          <>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="border-b border-slate-200/80 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/50">
                    <th className="py-3 px-4 font-medium whitespace-nowrap">شماره سند</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">تاریخ</th>
                    <th className="py-3 px-4 font-medium">شرح سند</th>
                    <th className="py-3 px-4 font-medium text-left whitespace-nowrap">جمع بدهکار/بستانکار</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">وضعیت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {recentVouchers.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => onNavigate('vouchers')}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-code tabular-nums font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        #{toPersianDigits(v.voucherNumber)}
                      </td>
                      <td className="py-3 px-4 font-code tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {toPersianDigits(v.date)}
                      </td>
                      <td className="py-3 px-4 text-slate-800 dark:text-slate-200 max-w-xs truncate">
                        {v.description}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {formatMoney(v.totalDebit, unit, false)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`font-medium ${
                            v.status === 'permanent'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {v.status === 'permanent' ? 'دائم و قطعی' : 'موقت'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="sm:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {recentVouchers.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onNavigate('vouchers')}
                  className="w-full p-4 text-right space-y-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-code tabular-nums font-semibold text-slate-900 dark:text-white">
                      سند #{toPersianDigits(v.voucherNumber)} · {toPersianDigits(v.date)}
                    </span>
                    <span
                      className={`font-semibold ${
                        v.status === 'permanent'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {v.status === 'permanent' ? 'دائم' : 'موقت'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 truncate">
                    {v.description}
                  </div>
                  <div className="text-xs font-code tabular-nums font-bold text-slate-900 dark:text-white">
                    {formatMoney(v.totalDebit, unit, false)}{' '}
                    <span className="font-sans font-normal text-slate-500">{currencyWord}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
