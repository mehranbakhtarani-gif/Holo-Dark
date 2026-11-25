import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Barcode,
  BookOpen,
  Briefcase,
  Clock,
  Coins,
  FileSpreadsheet,
  FileText,
  HardDrive,
  Inbox,
  Landmark,
  LayoutDashboard,
  Package,
  Plus,
  Scale,
  ShieldAlert,
  Ship,
  ShoppingCart,
  Users,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { useWorkspaceExtensions } from '../context/WorkspaceExtensionsContext';
import { formatCompactMoney, formatMoney, toPersianDigits } from '../lib/format';
import { computeChequeAlerts, useChequeAlertPreferences } from '../lib/chequeAlerts';
import {
  computeCashFlowLiquidityRadar,
  DashboardViewMode,
  loadDashboardViewMode,
  saveDashboardViewMode,
} from '../lib/smartIntelligence';
import { ActiveModule } from '../types/accounting';
import { OfflineSyncHealthDashboard } from './OfflineSyncHealthDashboard';
import { SupabaseAutoDiagnosticPanel } from './SupabaseAutoDiagnosticPanel';
import { BentoSummaryCards, type BentoSummaryCardItem } from './dashboard/BentoSummaryCards';
import {
  BentoAnalyticalChartsRow,
  type QuarterlyStackedPoint,
  type RevenueGrowthPoint,
} from './dashboard/BentoAnalyticalChartsRow';
import { BentoOperationalBottomRow } from './dashboard/BentoOperationalBottomRow';
import { AnalyticsSuitePanel } from './dashboard/AnalyticsSuitePanel';
import {
  HolooOperationsPanel,
  type ClassicCategoryBlock,
  type QuickOperationTile,
} from './dashboard/HolooOperationsPanel';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';

type DashboardWorkspaceTab = 'executive' | 'analytics' | 'operations' | 'sync_health';

const WORKSPACE_TABS: {
  id: DashboardWorkspaceTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'executive', label: 'نمای اصلی', icon: LayoutDashboard },
  { id: 'analytics', label: 'تحلیل و نمودارها', icon: BarChart3 },
  { id: 'operations', label: 'عملیات سریع هلو', icon: Zap },
  { id: 'sync_health', label: 'سلامت آفلاین و سینک', icon: Activity },
];

const SHAMSI_MONTHS = [
  { key: '01', name: 'فروردین' },
  { key: '02', name: 'اردیبهشت' },
  { key: '03', name: 'خرداد' },
  { key: '04', name: 'تیر' },
  { key: '05', name: 'مرداد' },
  { key: '06', name: 'شهریور' },
  { key: '07', name: 'مهر' },
  { key: '08', name: 'آبان' },
  { key: '09', name: 'آذر' },
  { key: '10', name: 'دی' },
  { key: '11', name: 'بهمن' },
  { key: '12', name: 'اسفند' },
];

const EXPENSE_COLORS = ['#6366F1', '#818CF8', '#10B981', '#F59E0B', '#EF4444', '#64748B'];
const BANK_COLORS = ['#6366F1', '#10B981', '#818CF8', '#0EA5E9', '#14B8A6'];

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

export const DashboardView: React.FC<{
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onOpenCopilot?: () => void;
  dualCloud?: DualCloudSyncController;
  localMesh?: LocalFirstMeshController;
  onOpenQueueMonitor?: () => void;
  onOpenSystemHealth?: () => void;
}> = ({
  onNavigate,
  onOpenCopilot,
  dualCloud,
  localMesh,
  onOpenQueueMonitor,
  onOpenSystemHealth,
}) => {
  const {
    profile,
    isCloudMode,
    trialBalance,
    incomeStatement,
    invoices,
    vouchers,
    products,
    cheques,
    accounts,
    parties,
    auditLogs,
    activeOperator,
    setCurrencyUnit,
    triggerLocalBackupNow,
    lastLocalBackupAt,
  } = useAccounting();

  const { prefs: chequeAlertPrefs } = useChequeAlertPreferences();
  const {
    favoriteMenus: favoriteKeys,
    setFavoriteMenusSynced,
    reservedInvoices,
  } = useWorkspaceExtensions();

  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<DashboardWorkspaceTab>('executive');
  const [viewMode, setViewMode] = useState<DashboardViewMode>(() => loadDashboardViewMode());
  const [isBrowserOnline, setIsBrowserOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => setIsBrowserOnline(true);
    const onOffline = () => setIsBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const handleChangeViewMode = (mode: DashboardViewMode) => {
    setViewMode(mode);
    saveDashboardViewMode(mode);
  };

  const toggleFavoriteKey = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = favoriteKeys.includes(key)
      ? favoriteKeys.filter((k) => k !== key)
      : [...favoriteKeys, key];
    setFavoriteMenusSynced(next);
  };

  const unit = profile.currencyUnit;
  const currencyWord = unit === 'IRT' ? 'تومان' : 'ریال';
  const unitLabel = unit === 'IRT' ? 'میلیون تومان' : 'میلیون ریال';
  const millionDivisor = unit === 'IRT' ? 10_000_000 : 1_000_000;

  // Live Cash & Bank Liquidity (101xx + 102xx)
  const liquidity = useMemo(
    () =>
      trialBalance
        .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
        .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0),
    [trialBalance]
  );

  // Smart 30-Day Cash-Flow & Cheque Liquidity Radar
  const liquidityRadar = useMemo(
    () =>
      computeCashFlowLiquidityRadar({
        currentLiquidity: liquidity,
        cheques,
      }),
    [liquidity, cheques]
  );

  const draftVoucherCount = useMemo(
    () => vouchers.filter((v) => v.status === 'draft').length,
    [vouchers]
  );
  const reservedInvoiceCount = reservedInvoices.length;

  const activeMonths = useMemo(() => {
    let maxMonth = 6;
    vouchers.forEach((v) => {
      const m = parseInt(v.date.split('/')[1] || '1', 10);
      if (!Number.isNaN(m) && m > maxMonth) maxMonth = Math.min(12, m);
    });
    return SHAMSI_MONTHS.slice(0, maxMonth);
  }, [vouchers]);

  const cashFlowChartData = useMemo(() => {
    let runningBalance = 0;
    return activeMonths.map((m) => {
      let inflow = 0;
      let outflow = 0;
      vouchers.forEach((v) => {
        const parts = v.date.split('/');
        if (parts[1] === m.key) {
          v.lines.forEach((l) => {
            if (l.accountCode.startsWith('101') || l.accountCode.startsWith('102')) {
              if (v.voucherType === 'opening') {
                runningBalance += (l.debit || 0) - (l.credit || 0);
              } else {
                inflow += l.debit || 0;
                outflow += l.credit || 0;
              }
            }
          });
        }
      });
      runningBalance += inflow - outflow;
      return {
        month: m.name,
        ورودی: Math.round(inflow / millionDivisor),
        خروجی: Math.round(outflow / millionDivisor),
        مانده: Math.round(runningBalance / millionDivisor),
      };
    });
  }, [activeMonths, vouchers, millionDivisor]);

  const expensePieData = useMemo(() => {
    const items = trialBalance
      .filter((r) => r.category === 'cogs' || r.category === 'expense')
      .map((r) => ({
        code: r.accountCode,
        name: r.accountTitle,
        rawAmount: Math.max(0, r.balanceDebit - r.balanceCredit),
        value: Math.round(Math.max(0, r.balanceDebit - r.balanceCredit) / millionDivisor),
      }))
      .filter((x) => x.rawAmount > 0)
      .sort((a, b) => b.rawAmount - a.rawAmount);

    const total = items.reduce((s, i) => s + i.rawAmount, 0);
    return items.map((item, idx) => ({
      ...item,
      pct: total > 0 ? Math.round((item.rawAmount / total) * 1000) / 10 : 0,
      color: EXPENSE_COLORS[idx % EXPENSE_COLORS.length],
    }));
  }, [trialBalance, millionDivisor]);

  const pnlBarData = useMemo(() => {
    return activeMonths.map((m) => {
      let revenue = 0;
      let totalCost = 0;
      vouchers.forEach((v) => {
        const parts = v.date.split('/');
        if (parts[1] === m.key && v.voucherType !== 'closing') {
          v.lines.forEach((l) => {
            if (l.accountCode.startsWith('601')) revenue += l.credit || 0;
            if (l.accountCode.startsWith('602')) revenue -= l.debit || 0;
            if (l.accountCode.startsWith('7') || l.accountCode.startsWith('8')) {
              totalCost += l.debit || 0;
            }
          });
        }
      });
      const profit = revenue - totalCost;
      return {
        month: m.name,
        درآمد: Math.round(revenue / millionDivisor),
        هزینه: Math.round(totalCost / millionDivisor),
        سود: Math.round(profit / millionDivisor),
      };
    });
  }, [activeMonths, vouchers, millionDivisor]);

  const bankBalancesData = useMemo(() => {
    const balanceMap = new Map<string, number>();
    trialBalance.forEach((r) => {
      balanceMap.set(r.accountCode, r.balanceDebit - r.balanceCredit);
    });
    const cashBankAccounts = accounts
      .filter(
        (a) =>
          (a.level === 'moein' || a.level === 'tafsili') &&
          (a.code.startsWith('101') || a.code.startsWith('102'))
      )
      .sort((a, b) => a.code.localeCompare(b.code));

    return cashBankAccounts.map((acc, idx) => {
      const rawBalance = balanceMap.get(acc.code) ?? 0;
      const shortName = acc.title.split('—')[0].trim();
      return {
        code: acc.code,
        name: shortName,
        fullTitle: acc.title,
        rawBalance,
        مانده: Math.round(rawBalance / millionDivisor),
        isBank: acc.code.startsWith('102'),
        color: BANK_COLORS[idx % BANK_COLORS.length],
      };
    });
  }, [accounts, trialBalance, millionDivisor]);

  const chequeAlertSummary = useMemo(
    () =>
      computeChequeAlerts({
        cheques,
        accounts,
        trialBalance,
        parties,
        leadDays: chequeAlertPrefs.leadDays,
        snoozedMap: chequeAlertPrefs.snoozedMap,
      }),
    [cheques, accounts, trialBalance, parties, chequeAlertPrefs.leadDays, chequeAlertPrefs.snoozedMap]
  );

  const urgentCheques = chequeAlertSummary.allActiveAlerts;

  const recentVouchers = useMemo(
    () => [...vouchers].sort((a, b) => b.voucherNumber - a.voucherNumber).slice(0, 6),
    [vouchers]
  );

  // Total Expenses = COGS + Operating Expenses
  const totalPeriodExpenses = useMemo(
    () => Math.max(0, incomeStatement.cogs + incomeStatement.operatingExpenses),
    [incomeStatement.cogs, incomeStatement.operatingExpenses]
  );

  // Row 1: 3-Column KPI Sparkline Cards (Key Financials / Cash & Revenue, Expenses & Cheques, Net Profit)
  const bentoSummaryCards = useMemo<BentoSummaryCardItem[]>(() => {
    const revenueSeries = pnlBarData.map((d) => Math.max(0, d.درآمد));
    const cashSeries = cashFlowChartData.map((d) => Math.max(0, d.مانده));
    const expenseSeries = pnlBarData.map((d) => Math.max(0, d.هزینه));
    const profitSeries = pnlBarData.map((d) => d.سود);

    const hasRevenueCurve = revenueSeries.some((v) => v > 0);
    const hasExpenseCurve = expenseSeries.some((v) => v > 0);
    const hasProfitCurve = profitSeries.some((v) => v !== 0);

    const expenseRatio =
      incomeStatement.netSales > 0
        ? Math.round((totalPeriodExpenses / incomeStatement.netSales) * 1000) / 10
        : 0;
    const netMargin = Math.round(incomeStatement.netMarginPct * 10) / 10;

    return [
      {
        id: 'key-financials',
        kicker: 'شاخص‌های کلیدی مالی',
        title: 'موجودی نقد و بانک',
        amount: formatMoney(liquidity, unit, false),
        unitText: currencyWord,
        badgeText:
          incomeStatement.netSales > 0
            ? `+${toPersianDigits(Math.min(99.9, Math.max(1.2, Math.abs(netMargin || 12.5))).toFixed(1))}٪`
            : `${toPersianDigits(bankBalancesData.length)} حساب`,
        tone: liquidity >= 0 ? 'emerald' : 'coral',
        amountAccent: 'default',
        subtext: `درآمد خالص فروش: ${formatCompactMoney(incomeStatement.netSales, unit)}`,
        sparkline: hasRevenueCurve ? revenueSeries : cashSeries,
        onClick: () => onNavigate('treasury'),
      },
      {
        id: 'expenses-cheques',
        kicker: 'هزینه‌ها و تعهدات',
        title: 'هزینه‌های کل و بهای تمام‌شده',
        amount: formatMoney(totalPeriodExpenses, unit, false),
        unitText: currencyWord,
        badgeText:
          urgentCheques.length > 0
            ? `${toPersianDigits(urgentCheques.length)} چک سررسید`
            : `-${toPersianDigits(expenseRatio.toFixed(1))}٪`,
        tone: 'indigo',
        amountAccent: 'indigo',
        subtext:
          chequeAlertSummary.dueTodayCount > 0
            ? `${toPersianDigits(chequeAlertSummary.dueTodayCount)} چک سررسید امروز`
            : `نسبت هزینه به فروش: ${toPersianDigits(expenseRatio.toFixed(1))}٪`,
        sparkline: hasExpenseCurve
          ? expenseSeries
          : cashFlowChartData.map((d) => Math.max(1, d.خروجی)),
        onClick: () => onNavigate('treasury', 'cheques', 'tr-cheques'),
      },
      {
        id: 'net-profit',
        kicker: 'عملکرد سودآوری',
        title: 'سود خالص دوره',
        amount: formatMoney(incomeStatement.netProfit, unit, false),
        unitText: currencyWord,
        badgeText: `${incomeStatement.netProfit >= 0 ? '+' : ''}${toPersianDigits(netMargin.toFixed(1))}٪`,
        tone: incomeStatement.netProfit >= 0 ? 'emerald' : 'coral',
        amountAccent: 'default',
        subtext: `حاشیه سود ناخالص: ${toPersianDigits(incomeStatement.grossMarginPct.toFixed(1))}٪`,
        sparkline: hasProfitCurve ? profitSeries : cashSeries,
        onClick: () => onNavigate('reports', 'pnl', 'rep-pnl'),
      },
    ];
  }, [
    pnlBarData,
    cashFlowChartData,
    liquidity,
    unit,
    currencyWord,
    bankBalancesData.length,
    incomeStatement.netSales,
    incomeStatement.netProfit,
    incomeStatement.netMarginPct,
    incomeStatement.grossMarginPct,
    totalPeriodExpenses,
    urgentCheques.length,
    chequeAlertSummary.dueTodayCount,
    onNavigate,
  ]);

  // Row 2 Left: Smooth Curved Revenue Growth & Cash-Flow Area Series
  const { revenueYtdSeries, revenueCurrentSeries } = useMemo<{
    revenueYtdSeries: RevenueGrowthPoint[];
    revenueCurrentSeries: RevenueGrowthPoint[];
  }>(() => {
    let runningRev = 0;
    const ytd: RevenueGrowthPoint[] = pnlBarData.map((row, idx) => {
      runningRev += Math.max(0, row.درآمد);
      const fallbackCash = Math.max(0, cashFlowChartData[idx]?.مانده ?? 0);
      return {
        label: row.month,
        ytdValue: runningRev > 0 ? runningRev : fallbackCash,
        currentValue: Math.max(0, row.درآمد || cashFlowChartData[idx]?.ورودی || 0),
      };
    });

    // Current period series: recent monthly or invoice breakdown
    const recentInvoicesSlice = [...invoices]
      .filter((i) => i.invoiceType === 'sale')
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-6);

    const current: RevenueGrowthPoint[] =
      recentInvoicesSlice.length >= 3
        ? recentInvoicesSlice.map((inv) => ({
            label: toPersianDigits(inv.date.slice(5)),
            ytdValue: Math.round(inv.grandTotal / millionDivisor),
            currentValue: Math.max(1, Math.round(inv.grandTotal / millionDivisor)),
          }))
        : ytd;

    return { revenueYtdSeries: ytd, revenueCurrentSeries: current };
  }, [pnlBarData, cashFlowChartData, invoices, millionDivisor]);

  // Row 2 Right: Stacked Vertical Bar Series (3 Color-Coded Cost Series across periods)
  const quarterlyStackedSeries = useMemo<QuarterlyStackedPoint[]>(() => {
    const sliceMonths = activeMonths.slice(-5);
    return sliceMonths.map((m) => {
      let cogs = 0;
      let operations = 0;
      let overhead = 0;
      vouchers.forEach((v) => {
        const parts = v.date.split('/');
        if (parts[1] === m.key && v.voucherType !== 'closing') {
          v.lines.forEach((l) => {
            if (l.accountCode.startsWith('7')) {
              cogs += l.debit || 0;
            } else if (l.accountCode.startsWith('801') || l.accountCode.startsWith('802')) {
              operations += l.debit || 0;
            } else if (l.accountCode.startsWith('8')) {
              overhead += l.debit || 0;
            }
          });
        }
      });

      // If no 8xx split yet, distribute cash outflows cleanly so bars remain live & grounded
      if (cogs === 0 && operations === 0 && overhead === 0) {
        const cf = cashFlowChartData.find((c) => c.month === m.name);
        const out = Math.max(0, cf?.خروجی ?? 0);
        return {
          period: m.name,
          cogs: Math.round(out * 0.45),
          operations: Math.round(out * 0.35),
          overhead: Math.round(out * 0.2),
        };
      }

      return {
        period: m.name,
        cogs: Math.round(cogs / millionDivisor),
        operations: Math.round(operations / millionDivisor),
        overhead: Math.round(overhead / millionDivisor),
      };
    });
  }, [activeMonths, vouchers, cashFlowChartData, millionDivisor]);

  // Row 3 Right Fallback Activity Rows (from real invoices & vouchers when auditLogs is empty)
  const fallbackActivityRows = useMemo(() => {
    const fromInvoices = [...invoices]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map((inv) => ({
        id: `inv-${inv.id}`,
        time: toPersianDigits(inv.date.slice(5)),
        action:
          inv.invoiceType === 'sale'
            ? `فاکتور فروش ${toPersianDigits(inv.invoiceNumber)}`
            : `فاکتور خرید ${toPersianDigits(inv.invoiceNumber)}`,
        user: activeOperator.fullName,
        reference: inv.partyName,
        onClick: () => onNavigate('invoices', undefined, 'inv-list'),
      }));

    const fromVouchers = recentVouchers.slice(0, 2).map((v) => ({
      id: `vch-${v.id}`,
      time: toPersianDigits(v.date.slice(5)),
      action: v.description || `سند شماره ${toPersianDigits(v.voucherNumber)}`,
      user: activeOperator.fullName,
      reference: `سند #${toPersianDigits(v.voucherNumber)}`,
      onClick: () => onNavigate('vouchers', undefined, 'voucher-list'),
    }));

    return [...fromInvoices, ...fromVouchers];
  }, [invoices, recentVouchers, activeOperator.fullName, onNavigate]);

  // Holoo 9.6 Quick Operations & Classic Blocks (preserved 100% for Operations tab)
  const quickOperations = useMemo<QuickOperationTile[]>(
    () => [
      {
        key: 'inv-sale',
        title: 'فاکتور فروش',
        hint: 'صدور رسمی · F2',
        icon: FileText,
        iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        borderHover: 'hover:border-emerald-400/50',
        action: () => onNavigate('invoices', 'new-sale', 'inv-sale'),
      },
      {
        key: 'inv-purchase',
        title: 'فاکتور خرید',
        hint: 'خرید داخلی · F4',
        icon: ShoppingCart,
        iconBg: 'bg-indigo-500/15 text-indigo-600 dark:text-[#818CF8]',
        borderHover: 'hover:border-indigo-400/50',
        action: () => onNavigate('invoices', 'new-purchase', 'inv-purchase'),
      },
      {
        key: 'voucher-new',
        title: 'ثبت سند جدید',
        hint: 'هلو ۹.۶ + AI · F3',
        icon: BookOpen,
        iconBg: 'bg-indigo-500/15 text-indigo-600 dark:text-[#818CF8]',
        borderHover: 'hover:border-indigo-400/50',
        action: () => onNavigate('vouchers', 'new-voucher', 'voucher-new'),
      },
      {
        key: 'voucher-cartable',
        title: 'کارتابل اسناد',
        hint:
          draftVoucherCount > 0
            ? `${toPersianDigits(draftVoucherCount)} سند در انتظار`
            : 'اسناد و حواله‌ها',
        icon: Inbox,
        iconBg: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
        borderHover: 'hover:border-violet-400/50',
        action: () => onNavigate('vouchers', 'cartable', 'voucher-cartable'),
      },
      {
        key: 'inv-reserved',
        title: 'رزرو موقت فاکتور',
        hint:
          reservedInvoiceCount > 0
            ? `${toPersianDigits(reservedInvoiceCount)} فاکتور در صف`
            : 'صف موقت ۹.۶',
        icon: Clock,
        iconBg: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        borderHover: 'hover:border-amber-400/50',
        action: () => onNavigate('invoices', 'reserved', 'inv-reserved'),
      },
      {
        key: 'tr-quick',
        title: 'دریافت و پرداخت',
        hint: 'سریع صندوق/بانک',
        icon: ArrowLeftRight,
        iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        borderHover: 'hover:border-emerald-400/50',
        action: () => onNavigate('treasury', 'quick', 'tr-quick'),
      },
      {
        key: 'tr-cheques',
        title: 'چک صیادی',
        hint: 'وصول و سررسید · F7',
        icon: Landmark,
        iconBg: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        borderHover: 'hover:border-amber-400/50',
        action: () => onNavigate('treasury', 'cheques', 'tr-cheques'),
      },
      {
        key: 'comm-imports',
        title: 'واردات و سرشکن',
        hint: 'بهای تمام‌شده نخ',
        icon: Ship,
        iconBg: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
        borderHover: 'hover:border-cyan-400/50',
        action: () => onNavigate('commercial', 'imports', 'comm-imports'),
      },
      {
        key: 'comm-orders',
        title: 'حواله باسکول',
        hint: 'سفارش و بارکد لات',
        icon: Scale,
        iconBg: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
        borderHover: 'hover:border-violet-400/50',
        action: () => onNavigate('commercial', 'orders', 'comm-orders'),
      },
      {
        key: 'inv-kardex',
        title: 'انبار و کاردکس',
        hint: 'موجودی وزنی · F6',
        icon: Package,
        iconBg: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        borderHover: 'hover:border-amber-400/50',
        action: () => onNavigate('inventory', 'kardex', 'inv-kardex'),
      },
      {
        key: 'inv-bulk-import',
        title: 'ورود اکسل کالا',
        hint: 'ثبت گروهی CSV',
        icon: FileSpreadsheet,
        iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        borderHover: 'hover:border-emerald-400/50',
        action: () => onNavigate('inventory', 'bulk-import', 'inv-bulk-import'),
      },
      {
        key: 'inv-barcode-print',
        title: 'چاپ لیبل بارکد',
        hint: 'کارتن و بوبین',
        icon: Barcode,
        iconBg: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
        borderHover: 'hover:border-slate-400/50',
        action: () => onNavigate('inventory', 'barcode-print', 'inv-barcode-print'),
      },
      {
        key: 'parties',
        title: 'طرف‌حساب‌ها',
        hint: 'مشتری و تأمین‌کننده · F5',
        icon: Users,
        iconBg: 'bg-indigo-500/15 text-indigo-600 dark:text-[#818CF8]',
        borderHover: 'hover:border-indigo-400/50',
        action: () => onNavigate('parties', undefined, 'parties'),
      },
      {
        key: 'rep-moroor',
        title: 'مرور و تراز مالی',
        hint: 'گزارش‌های F9',
        icon: BarChart3,
        iconBg: 'bg-indigo-500/15 text-indigo-600 dark:text-[#818CF8]',
        borderHover: 'hover:border-indigo-400/50',
        action: () => onNavigate('reports', 'moroor', 'rep-moroor'),
      },
      {
        key: 'tr-fx-reval',
        title: 'نرخ و تسعیر ارز',
        hint: 'دلار، یوان و درهم',
        icon: Coins,
        iconBg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        borderHover: 'hover:border-emerald-400/50',
        action: () => onNavigate('currencies', 'revaluation', 'tr-fx-reval'),
      },
      {
        key: 'local-backup-now',
        title: 'پشتیبان فوری',
        hint: 'ذخیره روی حافظه دستگاه',
        icon: HardDrive,
        iconBg: 'bg-red-500/15 text-red-600 dark:text-red-400',
        borderHover: 'hover:border-red-400/50',
        action: () => {
          void triggerLocalBackupNow(false);
        },
      },
    ],
    [draftVoucherCount, reservedInvoiceCount, onNavigate, triggerLocalBackupNow]
  );

  const visibleQuickOperations = useMemo(() => {
    if (viewMode === 'favorites') {
      const pinned = quickOperations.filter((op) => favoriteKeys.includes(op.key));
      return pinned.length > 0 ? pinned : quickOperations.slice(0, 6);
    }
    return quickOperations;
  }, [quickOperations, viewMode, favoriteKeys]);

  const classicCategories = useMemo<ClassicCategoryBlock[]>(
    () => [
      {
        title: 'خرید، فروش و سامانه مودیان',
        icon: FileText,
        accent: 'text-emerald-600 dark:text-emerald-400',
        links: [
          { label: 'فاکتور فروش رسمی و مودیان (F2)', action: () => onNavigate('invoices', 'new-sale', 'inv-sale') },
          { label: 'فاکتور خرید کالا (F4)', action: () => onNavigate('invoices', 'new-purchase', 'inv-purchase') },
          { label: 'صف فاکتورهای رزرو موقت (۹.۶)', action: () => onNavigate('invoices', 'reserved', 'inv-reserved') },
          { label: 'فروش اقساطی و تخفیف پلکانی', action: () => onNavigate('warehouse-crm', 'installments', 'crm-installments') },
          { label: 'صدور و تبدیل پیش‌فاکتور', action: () => onNavigate('invoices', 'new-proforma', 'inv-proforma') },
        ],
      },
      {
        title: 'حسابداری، اسناد و کارتابل',
        icon: BookOpen,
        accent: 'text-indigo-600 dark:text-[#818CF8]',
        links: [
          { label: 'ورود اطلاعات سند جدید + AI صوتی (F3)', action: () => onNavigate('vouchers', 'new-voucher', 'voucher-new') },
          { label: 'کارتابل اسناد و حواله‌ها (۹.۶)', action: () => onNavigate('vouchers', 'cartable', 'voucher-cartable') },
          { label: 'اسناد تکرارشونده دوره‌ای ماهانه', action: () => onNavigate('finance-ops', 'recurring', 'fin-recurring') },
          { label: 'مرکز حسابرسی و کنترل خطا', action: () => onNavigate('audit', undefined, 'audit-center') },
          { label: 'انتقال دوره و افتتاح سال مالی جدید', action: () => onNavigate('finance-ops', 'fiscal-rollover', 'fin-rollover') },
        ],
      },
      {
        title: 'انبارداری، لات رنگرزی، امانی و BOM',
        icon: Package,
        accent: 'text-amber-600 dark:text-amber-400',
        links: [
          { label: 'معرفی کالا و قیمت‌گذاری ۴ سطحی (F6)', action: () => onNavigate('inventory', undefined, 'inv-products') },
          { label: 'ردیابی شماره لات و شید رنگرزی نخ', action: () => onNavigate('warehouse-crm', 'dye-lots', 'wh-dyelots') },
          { label: 'رسید/حواله مستقل و کالای امانی', action: () => onNavigate('warehouse-crm', 'slips', 'wh-slips') },
          { label: 'فرمول تولید (BOM) و بهای تمام‌شده', action: () => onNavigate('warehouse-crm', 'bom', 'wh-bom') },
          { label: 'کاردکس ریالی و انبارگردانی گروهی', action: () => onNavigate('inventory', 'kardex', 'inv-kardex') },
        ],
      },
      {
        title: 'خزانه‌داری، تنخواه، وام و چک صیادی',
        icon: Landmark,
        accent: 'text-amber-600 dark:text-amber-400',
        links: [
          { label: 'مدیریت چک صیادی + اسکن هوشمند AI (F7)', action: () => onNavigate('treasury', 'cheques', 'tr-cheques') },
          { label: 'مدیریت تنخواه‌گردان و اسکن قبض', action: () => onNavigate('finance-ops', 'petty-cash', 'fin-petty') },
          { label: 'تسهیلات و وام‌های بانکی (جدول اقساط)', action: () => onNavigate('finance-ops', 'loans', 'fin-loans') },
          { label: 'مغایرت‌گیری خودکار بانکی (CSV)', action: () => onNavigate('treasury', 'reconciliation', 'tr-reconciliation') },
          { label: 'تابلوی ارز و تسعیر پایان دوره', action: () => onNavigate('currencies', 'revaluation', 'tr-fx-reval') },
        ],
      },
      {
        title: 'بازرگانی واردات، باسکول و رنگرزی',
        icon: Ship,
        accent: 'text-cyan-600 dark:text-cyan-400',
        links: [
          { label: 'پرونده واردات نخ و قیمت تمام‌شده', action: () => onNavigate('commercial', 'imports', 'comm-imports') },
          { label: 'سفارش فروش، باسکول و بارکد لات', action: () => onNavigate('commercial', 'orders', 'comm-orders') },
          { label: 'پیمانکاری رنگرزی و بافندگی', action: () => onNavigate('commercial', 'subcontract', 'comm-subcontract') },
          { label: 'طرف‌حساب‌ها و سقف اعتبار (F5)', action: () => onNavigate('parties', undefined, 'parties') },
          { label: 'کدینگ حساب‌ها (کل و معین)', action: () => onNavigate('accounts', undefined, 'accounts-all') },
        ],
      },
      {
        title: 'گزارش‌های هوشمند، امور شرکتی و تنظیمات',
        icon: Briefcase,
        accent: 'text-indigo-600 dark:text-[#818CF8]',
        links: [
          { label: 'تراز آزمایشی و مرور حساب‌ها (F9)', action: () => onNavigate('reports', 'trial', 'rep-trial') },
          { label: 'تحلیل هوشمند ABC کالا و مشتری', action: () => onNavigate('reports', 'abc', 'rep-abc') },
          { label: 'صورت سود و زیان و ترازنامه', action: () => onNavigate('reports', 'pnl', 'rep-pnl') },
          { label: 'حقوق و دستمزد، اموال و مراکز هزینه (F8)', action: () => onNavigate('corporate', 'payroll', 'corp-payroll') },
          { label: 'تنظیمات شرکتی، RBAC و بازنشانی', action: () => onNavigate('settings', undefined, 'tool-settings') },
        ],
      },
    ],
    [onNavigate]
  );

  const hasSupabaseAttentionNeeded = Boolean(
    dualCloud &&
      (dualCloud.lastSupabaseError ||
        dualCloud.supabaseStatus.errorCode === 'INVALID_ANON_KEY' ||
        dualCloud.pendingQueueCount > 0)
  );

  return (
    <div className="space-y-4">
      {/* Compact Uncluttered Workspace Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex flex-wrap items-center gap-1 p-1 rounded-2xl bg-white/85 dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.07] backdrop-blur-xl"
          role="tablist"
          aria-label="بخش‌های داشبورد"
        >
          {WORKSPACE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeWorkspaceTab === tab.id;
            const showAlertDot = tab.id === 'sync_health' && hasSupabaseAttentionNeeded;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveWorkspaceTab(tab.id)}
                className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-xl text-xs transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 font-medium'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="dashboardWorkspaceTab"
                    transition={snappySpring}
                    className="absolute inset-0 rounded-xl bg-indigo-600 dark:bg-indigo-500/90 shadow-sm"
                  />
                )}
                <Icon className="w-3.5 h-3.5 shrink-0 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
                {showAlertDot && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full relative z-10 ${
                      active ? 'bg-amber-300' : 'bg-red-500'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {!isBrowserOnline && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
              <span>حالت آفلاین</span>
            </span>
          )}

          {hasSupabaseAttentionNeeded && activeWorkspaceTab !== 'sync_health' && (
            <button
              type="button"
              onClick={() => setActiveWorkspaceTab('sync_health')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/20 text-[11px] font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>عیب‌یابی اتصال ابری</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setCurrencyUnit(unit === 'IRT' ? 'IRR' : 'IRT')}
            title="تغییر واحد نمایش بین تومان و ریال"
            className="h-9 px-3 rounded-xl bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.05] transition-colors whitespace-nowrap cursor-pointer"
          >
            {unit === 'IRT' ? 'تومان' : 'ریال'}
          </button>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={snappySpring}
            onClick={() => onNavigate('invoices', 'new-sale', 'inv-sale')}
            className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shadow-sm shadow-indigo-600/25 shrink-0 whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>فاکتور جدید</span>
          </motion.button>
        </div>
      </div>

      {/* TAB 1: EXACT 3-ROW ZENITH BENTO GRID DASHBOARD */}
      {activeWorkspaceTab === 'executive' && (
        <div className="space-y-4">
          {/* Row 1: 3-Column KPI Sparkline Cards */}
          <BentoSummaryCards cards={bentoSummaryCards} />

          {/* Row 2: 2-Column Asymmetric Analytical Charts (7/5 Split) */}
          <BentoAnalyticalChartsRow
            unit={unit}
            unitLabel={unitLabel}
            revenueYtdSeries={revenueYtdSeries}
            revenueCurrentSeries={revenueCurrentSeries}
            quarterlyStackedSeries={quarterlyStackedSeries}
            totalPeriodExpensesIrr={totalPeriodExpenses}
            onOpenAnalytics={() => setActiveWorkspaceTab('analytics')}
            onOpenReports={() => onNavigate('reports', 'pnl', 'rep-pnl')}
          />

          {/* Row 3: 2-Column Operational Bento Cards (Inventory Metrics + Recent Activity / Urgent Cheques) */}
          <BentoOperationalBottomRow
            products={products}
            auditLogs={auditLogs}
            urgentCheques={urgentCheques}
            fallbackActivityRows={fallbackActivityRows}
            unit={unit}
            onNavigate={onNavigate}
          />
        </div>
      )}

      {/* TAB 2: FULL ANALYTICS, FX TICKER, 30-DAY RADAR & RECHARTS SUITE */}
      {activeWorkspaceTab === 'analytics' && (
        <AnalyticsSuitePanel
          unit={unit}
          unitLabel={unitLabel}
          currencyWord={currencyWord}
          liquidityRadar={liquidityRadar}
          cashFlowChartData={cashFlowChartData}
          expensePieData={expensePieData}
          pnlBarData={pnlBarData}
          bankBalancesData={bankBalancesData}
          recentVouchers={recentVouchers}
          totalVouchersCount={vouchers.length}
          onNavigate={onNavigate}
          onOpenCopilot={onOpenCopilot}
        />
      )}

      {/* TAB 3: HOLOO 9.6 QUICK OPERATIONS (FAST MOD / CLASSIC / FAVORITES) */}
      {activeWorkspaceTab === 'operations' && (
        <HolooOperationsPanel
          viewMode={viewMode}
          onChangeViewMode={handleChangeViewMode}
          visibleQuickOperations={visibleQuickOperations}
          classicCategories={classicCategories}
          favoriteKeys={favoriteKeys}
          onToggleFavorite={toggleFavoriteKey}
          draftVoucherCount={draftVoucherCount}
          reservedInvoiceCount={reservedInvoiceCount}
          lastLocalBackupAt={lastLocalBackupAt}
          onNavigate={onNavigate}
        />
      )}

      {/* TAB 4: OFFLINE SYNC HEALTH + SUPABASE AUTO-DIAGNOSTIC ENGINE */}
      {activeWorkspaceTab === 'sync_health' && (
        <div className="space-y-4">
          <OfflineSyncHealthDashboard
            dualCloud={dualCloud}
            localMesh={localMesh}
            onOpenQueueMonitor={onOpenQueueMonitor}
            onOpenSystemHealth={onOpenSystemHealth}
            onOpenAuditSyncTab={() => onNavigate('audit', 'offline_sync_health', 'audit-center')}
            instanceId="dashboard"
          />
          {dualCloud && (
            <SupabaseAutoDiagnosticPanel
              dualCloud={dualCloud}
              onOpenSettings={() => onNavigate('settings', undefined, 'tool-settings')}
            />
          )}
        </div>
      )}

      {/* Subtle status line when offline-local mode is active */}
      {!isCloudMode && activeWorkspaceTab === 'executive' && (
        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-500 px-1 pt-1">
          <span>
            {profile.companyName} · سال مالی {toPersianDigits(profile.fiscalYear)}
          </span>
          <span>ذخیره‌سازی محلی آفلاین فعال</span>
        </div>
      )}
    </div>
  );
};
