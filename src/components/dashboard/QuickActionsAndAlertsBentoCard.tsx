import React from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  Landmark,
  Package,
} from 'lucide-react';
import type { ActiveModule, Product } from '../../types/accounting';
import { toPersianDigits } from '../../lib/format';

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

interface QuickActionsAndAlertsBentoCardProps {
  lowStockProducts: Product[];
  totalProductsCount: number;
  urgentChequesCount: number;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  dragControls?: React.ReactNode;
}

export const QuickActionsAndAlertsBentoCard: React.FC<QuickActionsAndAlertsBentoCardProps> = ({
  lowStockProducts,
  totalProductsCount,
  urgentChequesCount,
  onNavigate,
  dragControls,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...snappySpring, delay: 0.12 }}
      className="h-full bg-white dark:bg-slate-900/95 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 flex flex-col justify-between gap-4"
    >
      <div>
        <div className="flex items-start gap-2 mb-4">
          {dragControls}
          <div className="min-w-0">
            <h2 className="font-bold text-base text-slate-900 dark:text-white leading-snug">
              دسترسی سریع
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              عملیات پرتکرار خزانه، انبار و تراز مالی
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {[
            {
              title: 'دریافت / پرداخت',
              sub: 'صندوق و بانک',
              icon: ArrowLeftRight,
              onClick: () => onNavigate('treasury', 'quick', 'tr-quick'),
            },
            {
              title: 'کاردکس کالا',
              sub: 'ورود و خروج انبار',
              icon: Package,
              onClick: () => onNavigate('inventory', 'kardex', 'inv-kardex'),
            },
            {
              title: 'چک‌های صیادی',
              sub:
                urgentChequesCount > 0
                  ? `${toPersianDigits(urgentChequesCount)} چک فعال`
                  : 'وصول و سررسید',
              icon: Landmark,
              onClick: () => onNavigate('treasury', 'cheques', 'tr-cheques'),
            },
            {
              title: 'تراز آزمایشی',
              sub: 'مرور حساب‌ها',
              icon: BarChart3,
              onClick: () => onNavigate('reports', 'trial', 'rep-trial'),
            },
          ].map((action) => {
            const Icon = action.icon;
            return (
              <motion.button
                key={action.title}
                type="button"
                whileTap={{ scale: 0.97 }}
                transition={snappySpring}
                onClick={action.onClick}
                className="p-3.5 min-h-[78px] rounded-xl bg-slate-50/90 dark:bg-slate-950/60 hover:bg-indigo-50/70 dark:hover:bg-indigo-950/40 border border-slate-200/70 dark:border-slate-800/80 hover:border-indigo-300 dark:hover:border-indigo-700 text-right transition-colors cursor-pointer flex flex-col justify-between"
              >
                <Icon className="w-4 h-4 text-indigo-600 dark:text-indigo-400 mb-2 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-snug">
                    {action.title}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate tabular-nums">
                    {action.sub}
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Live Inventory Reorder Point Alert */}
      {lowStockProducts.length > 0 ? (
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="w-full text-right p-4 rounded-xl bg-rose-50/75 dark:bg-rose-950/30 border border-rose-200/80 dark:border-rose-900/80 hover:bg-rose-50 dark:hover:bg-rose-950/45 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2 text-rose-800 dark:text-rose-300 text-xs font-bold mb-1.5">
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>هشدار نقطه سفارش انبار</span>
            </span>
            <span className="font-code tabular-nums">
              {toPersianDigits(lowStockProducts.length)} کالا
            </span>
          </div>
          <p className="text-xs text-rose-700/90 dark:text-rose-200/90 leading-relaxed">
            موجودی {toPersianDigits(lowStockProducts.length)} قلم کالا از حداقل تعریف‌شده کمتر
            است:{' '}
            <span className="font-semibold">
              {lowStockProducts
                .slice(0, 2)
                .map((p) => p.name)
                .join('، ')}
              {lowStockProducts.length > 2
                ? ` و ${toPersianDigits(lowStockProducts.length - 2)} مورد دیگر`
                : ''}
            </span>
          </p>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="w-full text-right p-4 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-200/80 dark:border-emerald-900/70 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 text-xs font-bold mb-1">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>وضعیت موجودی انبار مطلوب است</span>
          </div>
          <p className="text-xs text-emerald-700/90 dark:text-emerald-200/80 leading-relaxed tabular-nums">
            موجودی تمامی {toPersianDigits(totalProductsCount)} کالای تعریف‌شده بالاتر از حداقل
            نقطه سفارش است.
          </p>
        </button>
      )}
    </motion.div>
  );
};
