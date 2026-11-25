import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { MoreHorizontal } from 'lucide-react';
import { formatCompactMoney, toPersianDigits } from '../../lib/format';
import type { CurrencyUnit } from '../../types/accounting';

export interface RevenueGrowthPoint {
  label: string;
  ytdValue: number;
  currentValue: number;
}

export interface QuarterlyStackedPoint {
  period: string;
  cogs: number;
  operations: number;
  overhead: number;
}

interface BentoAnalyticalChartsRowProps {
  unit: CurrencyUnit;
  unitLabel: string;
  revenueYtdSeries: RevenueGrowthPoint[];
  revenueCurrentSeries: RevenueGrowthPoint[];
  quarterlyStackedSeries: QuarterlyStackedPoint[];
  totalPeriodExpensesIrr: number;
  onOpenAnalytics: () => void;
  onOpenReports: () => void;
}

export const BentoAnalyticalChartsRow: React.FC<BentoAnalyticalChartsRowProps> = ({
  unit,
  unitLabel,
  revenueYtdSeries,
  revenueCurrentSeries,
  quarterlyStackedSeries,
  totalPeriodExpensesIrr,
  onOpenAnalytics,
  onOpenReports,
}) => {
  const [timeframe, setTimeframe] = useState<'ytd' | 'current'>('ytd');

  const activeAreaData = useMemo(
    () => (timeframe === 'ytd' ? revenueYtdSeries : revenueCurrentSeries),
    [timeframe, revenueYtdSeries, revenueCurrentSeries]
  );

  const areaKey = timeframe === 'ytd' ? 'ytdValue' : 'currentValue';

  return (
    <section
      aria-label="نمودارهای تحلیلی روند درآمد و هزینه‌های فصلی"
      className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch"
    >
      {/* Primary Card (7 cols): Smooth Curved Area Chart with Timeframe Toggle */}
      <div className="lg:col-span-7 bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] p-5 flex flex-col justify-between">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm sm:text-[15px] font-bold text-[#0F172A] dark:text-white tracking-tight">
              روند رشد درآمد و نقدینگی
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
              بر حسب {unitLabel}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Segmented Timeframe Pills (سالانه / ماه جاری) */}
            <div
              className="inline-flex items-center p-0.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17]/75 border border-slate-200/80 dark:border-white/[0.08]"
              role="group"
              aria-label="بازه زمانی نمودار"
            >
              <button
                type="button"
                onClick={() => setTimeframe('ytd')}
                className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  timeframe === 'ytd'
                    ? 'bg-white dark:bg-white/[0.12] text-[#0F172A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                سالانه
              </button>
              <button
                type="button"
                onClick={() => setTimeframe('current')}
                className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  timeframe === 'current'
                    ? 'bg-white dark:bg-white/[0.12] text-[#0F172A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                ماه جاری
              </button>
            </div>

            <button
              type="button"
              onClick={onOpenAnalytics}
              title="مشاهده تحلیل‌های تکمیلی"
              aria-label="مشاهده تحلیل‌های تکمیلی"
              className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="h-56 w-full" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={activeAreaData} margin={{ top: 10, right: 12, left: -12, bottom: 2 }}>
              <defs>
                <linearGradient id="zenithRevenueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366F1" stopOpacity={0.42} />
                  <stop offset="65%" stopColor="#6366F1" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#6366F1" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(148, 163, 184, 0.14)"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: '#94A3B8' }}
                dy={6}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: '#94A3B8' }}
                tickFormatter={(val: number) => toPersianDigits(val)}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(129, 140, 248, 0.35)', strokeWidth: 1, strokeDasharray: '4 4' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const val = Number(payload[0].value ?? 0);
                  return (
                    <div
                      dir="rtl"
                      className="rounded-xl bg-[#0B0F17]/95 text-white border border-white/15 px-3 py-2 shadow-xl backdrop-blur-md text-right"
                    >
                      <div className="text-[10.5px] text-slate-400 mb-0.5">
                        {timeframe === 'ytd' ? 'عملکرد سالانه' : 'دوره جاری'} · {label}
                      </div>
                      <div className="text-sm font-bold tabular-nums font-code text-white">
                        {toPersianDigits(val.toLocaleString('en-US'))}{' '}
                        <span className="text-[10.5px] font-normal text-indigo-300">{unitLabel}</span>
                      </div>
                    </div>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey={areaKey}
                stroke="#818CF8"
                strokeWidth={2.5}
                fill="url(#zenithRevenueFill)"
                activeDot={{
                  r: 5,
                  fill: '#818CF8',
                  stroke: '#FFFFFF',
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Clean Bottom Legend */}
        <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-white/[0.05] flex items-center justify-center gap-5 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded-full bg-[#818CF8]" />
            <span>سالانه (تجمعی)</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded-full bg-slate-400 dark:bg-slate-600" />
            <span>ماه جاری (جریان خالص)</span>
          </span>
        </div>
      </div>

      {/* Secondary Card (5 cols): Stacked Vertical Bar Chart Comparing 3 Series */}
      <div className="lg:col-span-5 bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.65)] p-5 flex flex-col justify-between">
        <div>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-[15px] font-bold text-[#0F172A] dark:text-white tracking-tight">
                هزینه‌ها و بهای تمام‌شده دوره‌ای
              </h2>
              <div className="mt-1.5 text-2xl sm:text-[26px] font-extrabold text-[#0F172A] dark:text-white tabular-nums font-code tracking-tight">
                {formatCompactMoney(totalPeriodExpensesIrr, unit)}
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenReports}
              title="گزارش صورت سود و زیان"
              aria-label="گزارش صورت سود و زیان"
              className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="h-48 w-full mt-3" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={quarterlyStackedSeries}
              margin={{ top: 8, right: 6, left: -16, bottom: 2 }}
              barSize={26}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(148, 163, 184, 0.14)"
                vertical={false}
              />
              <XAxis
                dataKey="period"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: '#94A3B8' }}
                dy={5}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: '#94A3B8' }}
                tickFormatter={(val: number) => toPersianDigits(val)}
              />
              <Tooltip
                cursor={{ fill: 'rgba(99, 102, 241, 0.08)' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div
                      dir="rtl"
                      className="rounded-xl bg-[#0B0F17]/95 text-white border border-white/15 px-3 py-2 shadow-xl backdrop-blur-md text-right space-y-1 text-[11px]"
                    >
                      <div className="font-bold text-slate-200 border-b border-white/10 pb-1">
                        {label}
                      </div>
                      {payload.map((entry) => (
                        <div key={String(entry.dataKey)} className="flex items-center justify-between gap-4">
                          <span className="inline-flex items-center gap-1.5 text-slate-300">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: entry.color }}
                            />
                            <span>{entry.name}</span>
                          </span>
                          <span className="font-code tabular-nums font-bold text-white">
                            {toPersianDigits(Number(entry.value ?? 0).toLocaleString('en-US'))}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="cogs" name="بهای تمام‌شده" stackId="a" fill="#10B981" radius={[0, 0, 4, 4]} />
              <Bar dataKey="operations" name="عملیاتی و حقوق" stackId="a" fill="#6366F1" />
              <Bar dataKey="overhead" name="اداری و خزانه" stackId="a" fill="#818CF8" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bottom Legend Dots (Emerald, Indigo, Violet) */}
        <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-white/[0.05] flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-[#10B981]" />
            <span>بهای تمام‌شده</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-[#6366F1]" />
            <span>عملیاتی</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-[#818CF8]" />
            <span>اداری و فروش</span>
          </span>
        </div>
      </div>
    </section>
  );
};
