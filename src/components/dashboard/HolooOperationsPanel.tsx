import React from 'react';
import { motion } from 'framer-motion';
import { FolderKanban, LayoutGrid, Star, Zap } from 'lucide-react';
import type { ActiveModule } from '../../types/accounting';
import type { DashboardViewMode } from '../../lib/smartIntelligence';
import { toPersianDigits } from '../../lib/format';
import { DashboardActionSearch } from '../DashboardActionSearch';
import { DashboardChequeAlerts } from '../DashboardChequeAlerts';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

const VIEW_MODE_TABS: {
  id: DashboardViewMode;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'integrated', label: 'نمای ادغامی', sublabel: 'جامع مدیریتی', icon: LayoutGrid },
  { id: 'fast', label: 'فست‌مد (Fast Mod)', sublabel: 'ثبت سریع روزانه', icon: Zap },
  { id: 'classic', label: 'نمای کلاسیک ۹.۶', sublabel: 'ماژول‌های دسته‌بندی‌شده', icon: FolderKanban },
  { id: 'favorites', label: 'پرکاربردها', sublabel: 'منوی شخصی‌سازی‌شده', icon: Star },
];

export interface QuickOperationTile {
  key: string;
  title: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  borderHover: string;
  action: () => void;
}

export interface ClassicCategoryBlock {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  links: { label: string; action: () => void }[];
}

interface HolooOperationsPanelProps {
  viewMode: DashboardViewMode;
  onChangeViewMode: (mode: DashboardViewMode) => void;
  visibleQuickOperations: QuickOperationTile[];
  classicCategories: ClassicCategoryBlock[];
  favoriteKeys: string[];
  onToggleFavorite: (key: string, e: React.MouseEvent) => void;
  draftVoucherCount: number;
  reservedInvoiceCount: number;
  lastLocalBackupAt: string | null;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}

export const HolooOperationsPanel: React.FC<HolooOperationsPanelProps> = ({
  viewMode,
  onChangeViewMode,
  visibleQuickOperations,
  classicCategories,
  favoriteKeys,
  onToggleFavorite,
  draftVoucherCount,
  reservedInvoiceCount,
  lastLocalBackupAt,
  onNavigate,
}) => {
  return (
    <div className="space-y-5">
      {/* Sub-mode Switcher (Integrated / Fast Mod / Classic 9.6 / Favorites) */}
      <div className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-2 flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex flex-wrap items-center gap-1"
          role="tablist"
          aria-label="نماهای عملیاتی هلو اپکس ۹.۶"
        >
          {VIEW_MODE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = viewMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChangeViewMode(tab.id)}
                className={`relative inline-flex items-center gap-2 px-3.5 min-h-[42px] sm:min-h-[38px] rounded-xl text-xs transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="holooOpsSubTab"
                    transition={snappySpring}
                    className="absolute inset-0 bg-indigo-600 rounded-xl shadow-sm"
                  />
                )}
                <Icon className="w-3.5 h-3.5 shrink-0 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
                <span
                  className={`hidden md:inline text-[10.5px] relative z-10 ${
                    active ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  · {tab.sublabel}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 px-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="hidden sm:inline">
            کارتابل موقت:{' '}
            <strong className="font-code tabular-nums text-slate-900 dark:text-white">
              {toPersianDigits(draftVoucherCount)}
            </strong>
          </span>
          <span className="hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="hidden sm:inline">
            فاکتور رزرو:{' '}
            <strong className="font-code tabular-nums text-slate-900 dark:text-white">
              {toPersianDigits(reservedInvoiceCount)}
            </strong>
          </span>
          {lastLocalBackupAt && (
            <>
              <span className="hidden md:inline" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                onClick={() => onNavigate('settings', 'local-backup', 'tool-local-backup')}
                className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors font-code tabular-nums cursor-pointer"
              >
                پشتیبان داخلی: {toPersianDigits(lastLocalBackupAt)}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Inline Fuzzy Action Launcher */}
      <DashboardActionSearch onNavigate={onNavigate} />

      {/* Classic 6-Category Directory or Quick Operations Tiles */}
      {viewMode === 'classic' ? (
        <section
          aria-label="ماژول‌های کلاسیک هلو اپکس ۹.۶"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
        >
          {classicCategories.map((cat) => {
            const Icon = cat.icon;
            return (
              <div
                key={cat.title}
                className="bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] rounded-2xl p-4 space-y-3"
              >
                <div className="flex items-center gap-2 pb-2.5 border-b border-slate-100 dark:border-slate-800">
                  <Icon className={`w-4 h-4 shrink-0 ${cat.accent}`} />
                  <h2 className="text-xs font-bold text-slate-900 dark:text-white">{cat.title}</h2>
                </div>
                <div className="space-y-1">
                  {cat.links.map((lk) => (
                    <button
                      key={lk.label}
                      type="button"
                      onClick={lk.action}
                      className="w-full text-right px-2.5 py-2 rounded-xl text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/70 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <span className="truncate">{lk.label}</span>
                      <span className="text-slate-400 text-[10px]">←</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <section aria-label="دسترسی سریع عملیات روزانه" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                {viewMode === 'favorites'
                  ? `عملیات پرکاربرد شخصی‌سازی‌شده (${toPersianDigits(visibleQuickOperations.length)} مورد)`
                  : viewMode === 'fast'
                    ? 'میز کار سریع روزانه (Fast Mod ۹.۶)'
                    : 'دسترسی سریع عملیات روزانه هلو اپکس ۹.۶'}
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                با کلیک روی آیکون ستاره کنار هر کارت، آن عملیات را به تب «پرکاربردها» پین یا حذف کنید.
              </p>
            </div>
            {viewMode === 'favorites' && (
              <button
                type="button"
                onClick={() => onChangeViewMode('integrated')}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                مشاهده همه عملیات برای پین کردن
              </button>
            )}
          </div>
          <div
            className={`grid gap-3 ${
              viewMode === 'fast'
                ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-4'
                : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-4'
            }`}
          >
            {visibleQuickOperations.map((item) => {
              const Icon = item.icon;
              const isPinned = favoriteKeys.includes(item.key);
              return (
                <div
                  key={item.key}
                  onClick={item.action}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      item.action();
                    }
                  }}
                  className={`group relative flex items-center gap-3 ${
                    viewMode === 'fast' ? 'p-4' : 'p-3.5'
                  } rounded-2xl bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] ${item.borderHover} hover:shadow-sm transition-all text-right cursor-pointer`}
                >
                  <div
                    className={`${
                      viewMode === 'fast' ? 'w-10 h-10' : 'w-9 h-9'
                    } rounded-xl flex items-center justify-center shrink-0 ${item.iconBg}`}
                  >
                    <Icon className={viewMode === 'fast' ? 'w-5 h-5' : 'w-4 h-4'} />
                  </div>
                  <div className="min-w-0 flex-1 pl-4">
                    <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                      {item.title}
                    </div>
                    <div className="text-[10.5px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {item.hint}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => onToggleFavorite(item.key, e)}
                    title={isPinned ? 'حذف از پرکاربردها' : 'پین به پرکاربردها'}
                    aria-label={isPinned ? 'حذف از پرکاربردها' : 'پین به پرکاربردها'}
                    className={`absolute top-2.5 left-2.5 p-1 rounded-md transition-opacity cursor-pointer ${
                      isPinned
                        ? 'text-amber-500 opacity-100'
                        : 'text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 hover:text-amber-500'
                    }`}
                  >
                    <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-amber-400' : ''}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Smart Urgent Cheque Alerts */}
      <DashboardChequeAlerts onNavigate={onNavigate} />
    </div>
  );
};
