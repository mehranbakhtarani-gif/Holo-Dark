import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  DropAnimation,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Barcode,
  BookOpen,
  Briefcase,
  Check,
  ChevronLeft,
  Clock,
  Coins,
  Eye,
  FileSpreadsheet,
  FileText,
  GripVertical,
  HardDrive,
  Inbox,
  Landmark,
  LayoutDashboard,
  Mic,
  Package,
  Plus,
  RotateCcw,
  Scale,
  Search,
  ShieldAlert,
  Ship,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Users,
  WifiOff,
  X,
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
import { RecentInvoicesBentoCard } from './dashboard/RecentInvoicesBentoCard';
import { QuickActionsAndAlertsBentoCard } from './dashboard/QuickActionsAndAlertsBentoCard';
import { SortableDashboardCard } from './dashboard/SortableDashboardCard';
import { FinancialVoiceSearchPanel } from './dashboard/FinancialVoiceSearchPanel';
import {
  DashboardCardExpandModal,
  type DashboardExpandableCardId,
} from './dashboard/DashboardCardExpandModal';
import { AnalyticsSuitePanel } from './dashboard/AnalyticsSuitePanel';
import {
  HolooOperationsPanel,
  type ClassicCategoryBlock,
  type QuickOperationTile,
} from './dashboard/HolooOperationsPanel';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import { fuzzyFilterAndRank, normalizeFuzzyText } from '../lib/fuzzySearch';
import type { FinancialVoiceSearchDataset } from '../lib/financialVoiceSearch';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import {
  DASHBOARD_WIDGET_META,
  type DashboardKpiCardId,
  type DashboardLayoutConfig,
  type DashboardWidgetCardId,
  isDefaultDashboardLayout,
  loadDashboardLayout,
  reorderIds,
  resetDashboardLayoutStorage,
  saveDashboardLayout,
  toggleDashboardWidgetVisibility,
} from '../lib/dashboardLayout';

const INVOICE_TYPE_SEARCH_LABELS: Record<string, string> = {
  sale: 'فاکتور فروش رسمی مودیان',
  purchase: 'فاکتور خرید واردات',
  proforma: 'پیش‌فاکتور پیشفاکتور استعلام قیمت',
  sale_return: 'برگشت از فروش مرجوعی',
  purchase_return: 'برگشت از خرید مرجوعی',
  waste: 'ضایعات کسری انبار',
};

type DashboardWorkspaceTab = 'executive' | 'analytics' | 'operations' | 'sync_health';

const WORKSPACE_TABS: {
  id: DashboardWorkspaceTab;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'executive', label: 'نمای اجرایی', sublabel: 'اولویت‌های امروز', icon: LayoutDashboard },
  { id: 'analytics', label: 'تحلیل و نمودارها', sublabel: 'نقدینگی و سود و زیان', icon: BarChart3 },
  { id: 'operations', label: 'عملیات سریع هلو', sublabel: 'فست‌مد و کلاسیک ۹.۶', icon: Zap },
  { id: 'sync_health', label: 'سلامت آفلاین و سینک', sublabel: 'IndexedDB و Supabase', icon: Activity },
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

const EXPENSE_COLORS = ['#4f46e5', '#0284c7', '#10b981', '#d97706', '#f43f5e', '#64748b'];
const BANK_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#6366f1', '#14b8a6'];

const snappySpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

const widgetDropAnimation: DropAnimation = {
  duration: 180,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.35',
      },
    },
  }),
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
    balanceSheet,
    invoices,
    vouchers,
    products,
    cheques,
    accounts,
    parties,
    partyBalances,
    triggerLocalBackupNow,
    lastLocalBackupAt,
    showToast,
  } = useAccounting();

  const { prefs: chequeAlertPrefs } = useChequeAlertPreferences();
  const {
    favoriteMenus: favoriteKeys,
    setFavoriteMenusSynced,
    reservedInvoices,
  } = useWorkspaceExtensions();

  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<DashboardWorkspaceTab>('executive');
  const [viewMode, setViewMode] = useState<DashboardViewMode>(() => loadDashboardViewMode());
  const [quickSearch, setQuickSearch] = useState('');
  const debouncedQuickSearch = useDebouncedValue(quickSearch, 90);
  const [isBrowserOnline, setIsBrowserOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // Persistent Drag-and-Drop Dashboard Layout State
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutConfig>(() =>
    loadDashboardLayout()
  );
  const [isCustomizingLayout, setIsCustomizingLayout] = useState(false);
  const [activeDragWidgetId, setActiveDragWidgetId] = useState<DashboardWidgetCardId | null>(null);

  // Financial Voice Search Modal State
  const [voiceSearchOpen, setVoiceSearchOpen] = useState(false);
  const [voiceAutoStart, setVoiceAutoStart] = useState(false);
  const [voiceQuery, setVoiceQuery] = useState('');

  // Full-Size / Fullscreen Expanded Card Modal State
  const [expandedCardId, setExpandedCardId] = useState<DashboardExpandableCardId | null>(null);

  const handleOpenVoiceSearch = useCallback(
    (autoStart: boolean) => {
      setVoiceQuery(quickSearch);
      setVoiceAutoStart(autoStart);
      setVoiceSearchOpen(true);
    },
    [quickSearch]
  );

  const widgetSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const updateDashboardLayout = useCallback(
    (updater: (prev: DashboardLayoutConfig) => DashboardLayoutConfig) => {
      setDashboardLayout((prev) => {
        const next = updater(prev);
        saveDashboardLayout(next);
        return next;
      });
    },
    []
  );

  const handleReorderKpiCards = useCallback(
    (activeId: DashboardKpiCardId, overId: DashboardKpiCardId) => {
      updateDashboardLayout((prev) => ({
        ...prev,
        kpiOrder: reorderIds(prev.kpiOrder, activeId, overId),
      }));
    },
    [updateDashboardLayout]
  );

  const handleWidgetDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragWidgetId(event.active.id as DashboardWidgetCardId);
  }, []);

  const handleWidgetDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragWidgetId(null);
      if (!over || active.id === over.id) return;
      updateDashboardLayout((prev) => ({
        ...prev,
        widgetOrder: reorderIds(
          prev.widgetOrder,
          active.id as DashboardWidgetCardId,
          over.id as DashboardWidgetCardId
        ),
      }));
    },
    [updateDashboardLayout]
  );

  const handleToggleWidgetVisibility = useCallback(
    (widgetId: DashboardWidgetCardId) => {
      updateDashboardLayout((prev) => toggleDashboardWidgetVisibility(prev, widgetId));
    },
    [updateDashboardLayout]
  );

  const handleResetDashboardLayout = useCallback(() => {
    const reset = resetDashboardLayoutStorage();
    setDashboardLayout(reset);
    showToast('چیدمان کارت‌های داشبورد به حالت پیش‌فرض بازنشانی شد.');
  }, [showToast]);

  const layoutIsDefault = useMemo(
    () => isDefaultDashboardLayout(dashboardLayout),
    [dashboardLayout]
  );

  const visibleWidgetIds = useMemo(
    () =>
      dashboardLayout.widgetOrder.filter((id) => !dashboardLayout.hiddenWidgets.includes(id)),
    [dashboardLayout]
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

  const voiceDataset = useMemo<FinancialVoiceSearchDataset>(
    () => ({
      invoices,
      cheques,
      parties,
      products,
      accounts,
      vouchers,
      trialBalance,
      partyBalances,
      unit,
    }),
    [invoices, cheques, parties, products, accounts, vouchers, trialBalance, partyBalances, unit]
  );

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

  // Receivables + Pending Receivable Cheques (103xx + 104xx)
  const totalReceivables = useMemo(
    () =>
      trialBalance
        .filter((r) => r.accountCode.startsWith('103') || r.accountCode.startsWith('104'))
        .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0),
    [trialBalance]
  );

  // Live Inventory Valuation
  const totalInventoryValue = useMemo(() => {
    const ledgerInventory = trialBalance
      .filter((r) => r.accountCode.startsWith('105'))
      .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0);
    if (ledgerInventory > 0) return ledgerInventory;
    return products.reduce(
      (sum, p) => sum + (p.inventoryValueIrr ?? Math.round(p.stock * p.buyPrice)),
      0
    );
  }, [trialBalance, products]);

  const activeProductsCount = useMemo(
    () => products.filter((p) => p.stock > 0).length,
    [products]
  );

  const activeMonths = useMemo(() => {
    let maxMonth = 8;
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

  const lowStockProducts = useMemo(
    () => products.filter((p) => p.stock < p.reorderPoint),
    [products]
  );

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

  const pendingCheques = chequeAlertSummary.allActiveAlerts;
  const upcomingReceivableChequesCount = useMemo(
    () => pendingCheques.filter((a) => a.cheque.direction === 'receivable').length,
    [pendingCheques]
  );

  const recentVouchers = useMemo(
    () => [...vouchers].sort((a, b) => b.voucherNumber - a.voucherNumber).slice(0, 6),
    [vouchers]
  );

  const filteredRecentInvoices = useMemo(() => {
    const sorted = [...invoices].sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      return b.invoiceNumber.localeCompare(a.invoiceNumber);
    });
    if (!normalizeFuzzyText(debouncedQuickSearch)) return sorted.slice(0, 6);
    const ranked = fuzzyFilterAndRank(sorted, debouncedQuickSearch, (inv) => [
      { text: inv.invoiceNumber, weight: 1.45 },
      { text: inv.partyName, weight: 1.3 },
      { text: inv.date, weight: 1.05 },
      { text: inv.taxSerial, weight: 1.1 },
      { text: INVOICE_TYPE_SEARCH_LABELS[inv.invoiceType] || inv.invoiceType, weight: 1.0 },
      { text: String(inv.grandTotal), weight: 0.85 },
      {
        text: inv.items.map((it) => `${it.sku} ${it.productName} ${it.lotNumber || ''}`).join(' '),
        weight: 1.0,
      },
    ]);
    return ranked.slice(0, 8).map((r) => r.item);
  }, [invoices, debouncedQuickSearch]);

  const bentoSummaryCards = useMemo<BentoSummaryCardItem[]>(() => {
    const liquiditySeries = cashFlowChartData.map((d) => d.مانده);
    const revenueSeries = pnlBarData.map((d) => d.درآمد);
    const inventorySeries = products
      .slice(0, 8)
      .map((p) => Math.max(1, Math.round((p.inventoryValueIrr ?? p.stock * p.buyPrice) / millionDivisor)));

    const cardsById: Record<DashboardKpiCardId, BentoSummaryCardItem> = {
      balance: {
        id: 'balance',
        kicker: 'نقدینگی در دسترس',
        title: 'موجودی نقد و بانک',
        amount: formatMoney(liquidity, unit, false),
        unitText: currencyWord,
        badgeText: `${toPersianDigits(bankBalancesData.length)} حساب فعال`,
        tone: liquidity >= 0 ? 'indigo' : 'coral',
        amountAccent: liquidity >= 0 ? 'indigo' : 'coral',
        subtext: `فروش خالص دوره: ${formatCompactMoney(incomeStatement.netSales, unit)}`,
        sparkline: liquiditySeries.length >= 2 ? liquiditySeries : [18, 22, 20, 29, 27, 35],
        onClick: () => onNavigate('treasury'),
      },
      receivables: {
        id: 'receivables',
        kicker: 'اسناد و مطالبات مشتریان',
        title: 'مطالبات و اسناد دریافتنی',
        amount: formatMoney(totalReceivables, unit, false),
        unitText: currencyWord,
        badgeText:
          upcomingReceivableChequesCount > 0
            ? `${toPersianDigits(upcomingReceivableChequesCount)} چک سررسید نزدیک`
            : 'بدون چک معوق',
        tone: 'emerald',
        amountAccent: 'emerald',
        subtext: `سود خالص دوره: ${formatCompactMoney(incomeStatement.netProfit, unit)} (${toPersianDigits(incomeStatement.netMarginPct.toFixed(1))}٪)`,
        sparkline: revenueSeries.length >= 2 ? revenueSeries : [14, 19, 17, 25, 28, 32],
        onClick: () => onNavigate('treasury', 'cheques', 'tr-cheques'),
      },
      inventory: {
        id: 'inventory',
        kicker: 'موجودی انبارها',
        title: 'ارزش ریالی موجودی انبار',
        amount: formatMoney(totalInventoryValue, unit, false),
        unitText: currencyWord,
        badgeText:
          lowStockProducts.length > 0
            ? `${toPersianDigits(lowStockProducts.length)} کالا زیر حد نصاب`
            : 'موجودی نرمال',
        tone: lowStockProducts.length > 0 ? 'coral' : 'emerald',
        amountAccent: lowStockProducts.length > 0 ? 'coral' : 'default',
        subtext: `${toPersianDigits(activeProductsCount)} ردیف کالای فعال از ${toPersianDigits(products.length)} کالا`,
        sparkline: inventorySeries.length >= 2 ? inventorySeries : [24, 21, 26, 23, 29, 27],
        onClick: () => onNavigate('inventory'),
      },
    };

    return dashboardLayout.kpiOrder.map((id) => cardsById[id]);
  }, [
    cashFlowChartData,
    pnlBarData,
    products,
    millionDivisor,
    liquidity,
    unit,
    currencyWord,
    bankBalancesData.length,
    incomeStatement.netSales,
    incomeStatement.netProfit,
    incomeStatement.netMarginPct,
    totalReceivables,
    upcomingReceivableChequesCount,
    totalInventoryValue,
    lowStockProducts.length,
    activeProductsCount,
    dashboardLayout.kpiOrder,
    onNavigate,
  ]);

  const quickOperations = useMemo<QuickOperationTile[]>(
    () => [
      {
        key: 'inv-sale',
        title: 'فاکتور فروش',
        hint: 'صدور رسمی · F2',
        icon: FileText,
        iconBg: 'bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300',
        borderHover: 'hover:border-teal-300 dark:hover:border-teal-700',
        action: () => onNavigate('invoices', 'new-sale', 'inv-sale'),
      },
      {
        key: 'inv-purchase',
        title: 'فاکتور خرید',
        hint: 'خرید داخلی · F4',
        icon: ShoppingCart,
        iconBg: 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300',
        borderHover: 'hover:border-sky-300 dark:hover:border-sky-700',
        action: () => onNavigate('invoices', 'new-purchase', 'inv-purchase'),
      },
      {
        key: 'voucher-new',
        title: 'ثبت سند جدید',
        hint: 'هلو ۹.۶ + AI · F3',
        icon: BookOpen,
        iconBg: 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300',
        borderHover: 'hover:border-indigo-300 dark:hover:border-indigo-700',
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
        iconBg: 'bg-violet-50 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300',
        borderHover: 'hover:border-violet-300 dark:hover:border-violet-700',
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
        iconBg: 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300',
        borderHover: 'hover:border-amber-300 dark:hover:border-amber-700',
        action: () => onNavigate('invoices', 'reserved', 'inv-reserved'),
      },
      {
        key: 'tr-quick',
        title: 'دریافت و پرداخت',
        hint: 'سریع صندوق/بانک',
        icon: ArrowLeftRight,
        iconBg: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300',
        borderHover: 'hover:border-emerald-300 dark:hover:border-emerald-700',
        action: () => onNavigate('treasury', 'quick', 'tr-quick'),
      },
      {
        key: 'tr-cheques',
        title: 'چک صیادی',
        hint: 'وصول و سررسید · F7',
        icon: Landmark,
        iconBg: 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300',
        borderHover: 'hover:border-amber-300 dark:hover:border-amber-700',
        action: () => onNavigate('treasury', 'cheques', 'tr-cheques'),
      },
      {
        key: 'comm-imports',
        title: 'واردات و سرشکن',
        hint: 'بهای تمام‌شده نخ',
        icon: Ship,
        iconBg: 'bg-cyan-50 dark:bg-cyan-950/60 text-cyan-700 dark:text-cyan-300',
        borderHover: 'hover:border-cyan-300 dark:hover:border-cyan-700',
        action: () => onNavigate('commercial', 'imports', 'comm-imports'),
      },
      {
        key: 'comm-orders',
        title: 'حواله باسکول',
        hint: 'سفارش و بارکد لات',
        icon: Scale,
        iconBg: 'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300',
        borderHover: 'hover:border-purple-300 dark:hover:border-purple-700',
        action: () => onNavigate('commercial', 'orders', 'comm-orders'),
      },
      {
        key: 'inv-kardex',
        title: 'انبار و کاردکس',
        hint: 'موجودی وزنی · F6',
        icon: Package,
        iconBg: 'bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300',
        borderHover: 'hover:border-orange-300 dark:hover:border-orange-700',
        action: () => onNavigate('inventory', 'kardex', 'inv-kardex'),
      },
      {
        key: 'inv-bulk-import',
        title: 'ورود اکسل کالا',
        hint: 'ثبت گروهی CSV',
        icon: FileSpreadsheet,
        iconBg: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300',
        borderHover: 'hover:border-emerald-300 dark:hover:border-emerald-700',
        action: () => onNavigate('inventory', 'bulk-import', 'inv-bulk-import'),
      },
      {
        key: 'inv-barcode-print',
        title: 'چاپ لیبل بارکد',
        hint: 'کارتن و بوبین',
        icon: Barcode,
        iconBg: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200',
        borderHover: 'hover:border-slate-400 dark:hover:border-slate-600',
        action: () => onNavigate('inventory', 'barcode-print', 'inv-barcode-print'),
      },
      {
        key: 'parties',
        title: 'طرف‌حساب‌ها',
        hint: 'مشتری و تأمین‌کننده · F5',
        icon: Users,
        iconBg: 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300',
        borderHover: 'hover:border-blue-300 dark:hover:border-blue-700',
        action: () => onNavigate('parties', undefined, 'parties'),
      },
      {
        key: 'rep-moroor',
        title: 'مرور و تراز مالی',
        hint: 'گزارش‌های F9',
        icon: BarChart3,
        iconBg: 'bg-fuchsia-50 dark:bg-fuchsia-950/60 text-fuchsia-700 dark:text-fuchsia-300',
        borderHover: 'hover:border-fuchsia-300 dark:hover:border-fuchsia-700',
        action: () => onNavigate('reports', 'moroor', 'rep-moroor'),
      },
      {
        key: 'tr-fx-reval',
        title: 'نرخ و تسعیر ارز',
        hint: 'دلار، یوان و درهم',
        icon: Coins,
        iconBg: 'bg-lime-50 dark:bg-lime-950/60 text-lime-700 dark:text-lime-300',
        borderHover: 'hover:border-lime-300 dark:hover:border-lime-700',
        action: () => onNavigate('currencies', 'revaluation', 'tr-fx-reval'),
      },
      {
        key: 'local-backup-now',
        title: 'پشتیبان فوری',
        hint: 'ذخیره روی حافظه دستگاه',
        icon: HardDrive,
        iconBg: 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300',
        borderHover: 'hover:border-rose-300 dark:hover:border-rose-700',
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
        accent: 'text-teal-700 dark:text-teal-400',
        links: [
          { label: 'فاکتور فروش رسمی و مودیان (F2)', action: () => onNavigate('invoices', 'new-sale', 'inv-sale') },
          { label: 'فاکتور خرید کالا (F4)', action: () => onNavigate('invoices', 'new-purchase', 'inv-purchase') },
          { label: 'صف فاکتورهای رزرو موقت (۹.۶)', action: () => onNavigate('invoices', 'reserved', 'inv-reserved') },
          { label: 'فروش اقساطی (دفترچه قسط) و تخفیف پلکانی', action: () => onNavigate('warehouse-crm', 'installments', 'crm-installments') },
          { label: 'صدور و تبدیل پیش‌فاکتور', action: () => onNavigate('invoices', 'new-proforma', 'inv-proforma') },
        ],
      },
      {
        title: 'حسابداری، اسناد و کارتابل',
        icon: BookOpen,
        accent: 'text-indigo-700 dark:text-indigo-400',
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
        accent: 'text-orange-700 dark:text-orange-400',
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
        accent: 'text-amber-700 dark:text-amber-400',
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
        accent: 'text-cyan-700 dark:text-cyan-400',
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
        accent: 'text-fuchsia-700 dark:text-fuchsia-400',
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

  const showOfflineIndicator = !isBrowserOnline || !isCloudMode;
  const hasSupabaseAttentionNeeded = Boolean(
    dualCloud &&
      (dualCloud.lastSupabaseError ||
        dualCloud.supabaseStatus.errorCode === 'INVALID_ANON_KEY' ||
        dualCloud.pendingQueueCount > 0)
  );

  return (
    <div className="space-y-6">
      {/* Clean Executive Header Row */}
      <header className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
              داشبورد مدیریت مالی هلو (Billion)
            </h1>
            {showOfflineIndicator && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-950/50 px-2.5 py-1 rounded-lg">
                <WifiOff className="w-3.5 h-3.5 shrink-0" />
                <span>{!isBrowserOnline ? 'آفلاین (ذخیره محلی)' : 'حالت محلی'}</span>
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            <span>{profile.companyName}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">سال مالی {toPersianDigits(profile.fiscalYear)}</span>
            <span aria-hidden="true">·</span>
            <span className={balanceSheet.isBalanced ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-medium'}>
              ترازنامه: {balanceSheet.isBalanced ? 'متوازن' : 'نیاز به بررسی'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 min-w-0">
          <div className="relative flex-1 min-w-0 w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={quickSearch}
              onChange={(e) => {
                setQuickSearch(e.target.value);
                if (activeWorkspaceTab !== 'executive') setActiveWorkspaceTab('executive');
              }}
              placeholder="جستجوی فازی فاکتور، طرف‌حساب، کالا..."
              aria-label="جستجوی سریع فاکتور یا کالا"
              className={`w-full h-11 pr-10 ${
                quickSearch ? 'pl-28' : 'pl-20'
              } rounded-xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors`}
            />
            <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {quickSearch && (
                <button
                  type="button"
                  onClick={() => setQuickSearch('')}
                  aria-label="پاک کردن جستجو"
                  className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                transition={snappySpring}
                onClick={() => handleOpenVoiceSearch(true)}
                aria-label="جستجوی صوتی مالی"
                title="جستجوی صوتی مالی (فارسی)"
                className="h-8 px-2.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/70 inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                <Mic className="w-3.5 h-3.5 shrink-0" />
                <span>صوتی</span>
              </motion.button>
            </div>
          </div>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={snappySpring}
            onClick={() => onNavigate('invoices', 'new-sale', 'inv-sale')}
            className="h-11 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-sm shrink-0 whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>فاکتور جدید</span>
          </motion.button>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={snappySpring}
            onClick={() => onNavigate('vouchers', 'new-voucher', 'voucher-new')}
            className="h-11 px-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs sm:text-sm font-medium inline-flex items-center justify-center gap-2 shrink-0 whitespace-nowrap cursor-pointer"
          >
            <BookOpen className="w-4 h-4 shrink-0" />
            <span>ثبت سند</span>
          </motion.button>

          {onOpenCopilot && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={snappySpring}
              onClick={onOpenCopilot}
              className="hidden sm:inline-flex h-11 px-3.5 rounded-xl text-xs sm:text-sm font-semibold text-indigo-700 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 items-center justify-center gap-2 shrink-0 whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>دستیار هوشمند</span>
            </motion.button>
          )}
        </div>
      </header>

      {/* Priority Workspace Tab Switcher (Declutters Dashboard into 4 Calm Focused Zones) */}
      <nav
        aria-label="بخش‌های اولویت‌بندی‌شده داشبورد"
        className="bg-white/85 dark:bg-slate-900/80 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-2 flex flex-wrap items-center justify-between gap-2"
      >
        <div className="flex flex-wrap items-center gap-1" role="tablist">
          {WORKSPACE_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeWorkspaceTab === tab.id;
            const showDot = tab.id === 'sync_health' && hasSupabaseAttentionNeeded;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveWorkspaceTab(tab.id)}
                className={`relative inline-flex items-center gap-2 px-3.5 min-h-[44px] sm:min-h-[40px] rounded-xl text-xs transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="dashboardWorkspaceTab"
                    transition={snappySpring}
                    className="absolute inset-0 bg-indigo-600 rounded-xl shadow-sm"
                  />
                )}
                <Icon className="w-4 h-4 shrink-0 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
                <span
                  className={`hidden xl:inline text-[10.5px] relative z-10 ${
                    active ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  · {tab.sublabel}
                </span>
                {showDot && (
                  <span
                    className={`w-2 h-2 rounded-full relative z-10 ${
                      active ? 'bg-amber-300' : 'bg-rose-500'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Compact Status Jump Indicator */}
          {hasSupabaseAttentionNeeded && activeWorkspaceTab !== 'sync_health' && (
            <button
              type="button"
              onClick={() => setActiveWorkspaceTab('sync_health')}
              className="inline-flex items-center gap-1.5 px-3 min-h-[38px] rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/70 text-[11px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/60 transition-colors whitespace-nowrap cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>هشدار اتصال Supabase</span>
            </button>
          )}

          {/* Dashboard Drag-and-Drop Personalization Toggle (Executive Tab) */}
          {activeWorkspaceTab === 'executive' && (
            <button
              type="button"
              onClick={() => setIsCustomizingLayout((prev) => !prev)}
              aria-pressed={isCustomizingLayout}
              className={`inline-flex items-center gap-1.5 px-3.5 min-h-[38px] rounded-xl border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isCustomizingLayout
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm hover:bg-indigo-700'
                  : 'bg-slate-50 dark:bg-slate-950/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-700 dark:hover:text-indigo-300'
              }`}
            >
              {isCustomizingLayout ? (
                <>
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span>ذخیره و پایان چیدمان</span>
                </>
              ) : (
                <>
                  <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                  <span>شخصی‌سازی چیدمان</span>
                </>
              )}
            </button>
          )}
        </div>
      </nav>

      {/* TAB 1: EXECUTIVE FOCUS VIEW (Customizable Drag-and-Drop Bento Grid powered by dnd-kit) */}
      {activeWorkspaceTab === 'executive' && (
        <div className="space-y-6">
          {/* Calm Personalization Toolbar when Customizing Mode is Active */}
          <AnimatePresence initial={false}>
            {isCustomizingLayout && (
              <motion.div
                key="dashboard-customize-toolbar"
                initial={{ opacity: 0, y: -8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.99 }}
                transition={snappySpring}
                className="rounded-2xl bg-indigo-50/80 dark:bg-indigo-950/35 border border-indigo-200/80 dark:border-indigo-800/70 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 text-xs text-indigo-950 dark:text-indigo-100 min-w-0">
                  <GripVertical className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="font-medium leading-relaxed">
                    کارت‌های KPI و بخش‌های داشبورد را با دستگیره بکشید و در موقعیت دلخواه رها کنید؛ تغییرات به‌صورت خودکار ذخیره می‌شوند.
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {dashboardLayout.hiddenWidgets.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {dashboardLayout.hiddenWidgets.map((hiddenId) => (
                        <motion.button
                          key={hiddenId}
                          type="button"
                          layout
                          whileTap={{ scale: 0.96 }}
                          transition={snappySpring}
                          onClick={() => handleToggleWidgetVisibility(hiddenId)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100/70 dark:hover:bg-indigo-900/50 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 shrink-0" />
                          <span>نمایش {DASHBOARD_WIDGET_META[hiddenId].title}</span>
                        </motion.button>
                      ))}
                    </div>
                  )}

                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    transition={snappySpring}
                    disabled={layoutIsDefault}
                    onClick={handleResetDashboardLayout}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-600 disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                    <span>بازنشانی پیش‌فرض</span>
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Zone 1: Drag-and-Drop Reorderable Top 3 Executive KPI Cards */}
          <BentoSummaryCards
            cards={bentoSummaryCards}
            isCustomizing={isCustomizingLayout}
            onReorder={handleReorderKpiCards}
            onExpand={(kpiId) => setExpandedCardId(`kpi:${kpiId}`)}
          />

          {/* Zone 2: Drag-and-Drop Reorderable 12-Column Bento Widgets Grid with Framer Motion Layout Transitions */}
          <DndContext
            sensors={widgetSensors}
            collisionDetection={closestCenter}
            onDragStart={handleWidgetDragStart}
            onDragEnd={handleWidgetDragEnd}
            onDragCancel={() => setActiveDragWidgetId(null)}
          >
            <SortableContext items={visibleWidgetIds} strategy={rectSortingStrategy}>
              <LayoutGroup id="dashboard-bento-widgets">
                <section
                  aria-label="کارت‌های قابل جابه‌جایی داشبورد"
                  className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch"
                >
                  <AnimatePresence mode="popLayout">
                    {visibleWidgetIds.map((widgetId) => {
                      const meta = DASHBOARD_WIDGET_META[widgetId];
                      const canHide = visibleWidgetIds.length > 1;

                      return (
                        <SortableDashboardCard
                          key={widgetId}
                          id={widgetId}
                          title={meta.title}
                          colSpanClass={meta.colSpanClass}
                          isCustomizing={isCustomizingLayout}
                          isAnyDragging={activeDragWidgetId !== null}
                          canHide={canHide}
                          onHide={handleToggleWidgetVisibility}
                          onExpand={(id) => setExpandedCardId(`widget:${id}`)}
                        >
                      {(dragControls) => {
                        if (widgetId === 'recent_invoices') {
                          return (
                            <RecentInvoicesBentoCard
                              invoices={filteredRecentInvoices}
                              totalInvoicesCount={invoices.length}
                              quickSearch={quickSearch}
                              onClearSearch={() => setQuickSearch('')}
                              unit={unit}
                              currencyWord={currencyWord}
                              onNavigate={onNavigate}
                              dragControls={dragControls}
                            />
                          );
                        }

                        if (widgetId === 'quick_actions') {
                          return (
                            <QuickActionsAndAlertsBentoCard
                              lowStockProducts={lowStockProducts}
                              totalProductsCount={products.length}
                              urgentChequesCount={pendingCheques.length}
                              onNavigate={onNavigate}
                              dragControls={dragControls}
                            />
                          );
                        }

                        if (widgetId === 'liquidity_pulse') {
                          return (
                            <div className="h-full bg-white dark:bg-slate-900/95 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 flex flex-col justify-between">
                              <div className="flex items-start justify-between gap-2 mb-4">
                                <div className="flex items-start gap-2 min-w-0">
                                  {dragControls}
                                  <div className="min-w-0">
                                    <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                                      نبض نقدینگی ماهانه
                                    </h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                      روند مانده تجمعی نقد و بانک ({unitLabel})
                                    </p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setActiveWorkspaceTab('analytics')}
                                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <span>همه نمودارها و رادار ۳۰ روزه</span>
                                  <ChevronLeft className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="h-56 w-full" dir="ltr">
                                <ResponsiveContainer width="100%" height="100%">
                                  <AreaChart
                                    data={cashFlowChartData}
                                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                                  >
                                    <defs>
                                      <linearGradient
                                        id="execLiquidityGrad"
                                        x1="0"
                                        y1="0"
                                        x2="0"
                                        y2="1"
                                      >
                                        <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.28} />
                                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.02} />
                                      </linearGradient>
                                    </defs>
                                    <CartesianGrid
                                      strokeDasharray="3 3"
                                      stroke="#e2e8f0"
                                      vertical={false}
                                    />
                                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                                    <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                                    <Tooltip
                                      contentStyle={{
                                        borderRadius: '10px',
                                        border: '1px solid #cbd5e1',
                                        backgroundColor: '#ffffff',
                                        color: '#0f172a',
                                        fontSize: '12px',
                                        direction: 'rtl',
                                        textAlign: 'right',
                                      }}
                                      formatter={(value: unknown) => [
                                        `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                                        'مانده تجمعی نقد',
                                      ]}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="مانده"
                                      stroke="#4f46e5"
                                      strokeWidth={2.5}
                                      fill="url(#execLiquidityGrad)"
                                    />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          );
                        }

                        // urgent_cheques
                        return (
                          <div className="h-full bg-white dark:bg-slate-900/95 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 flex flex-col justify-between gap-4">
                            <div>
                              <div className="flex items-start justify-between gap-2 mb-3">
                                <div className="flex items-start gap-2 min-w-0">
                                  {dragControls}
                                  <div className="min-w-0">
                                    <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                                      سررسید چک‌های اولویت‌دار
                                    </h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                                      وضعیت نقدینگی ۳۰ روزه:{' '}
                                      <span
                                        className={`font-semibold ${
                                          liquidityRadar.riskLevel === 'critical'
                                            ? 'text-rose-600 dark:text-rose-400'
                                            : liquidityRadar.riskLevel === 'watch'
                                              ? 'text-amber-600 dark:text-amber-400'
                                              : 'text-emerald-600 dark:text-emerald-400'
                                        }`}
                                      >
                                        {liquidityRadar.riskLevel === 'critical'
                                          ? 'هشدار کسری'
                                          : liquidityRadar.riskLevel === 'watch'
                                            ? 'نیاز به پایش'
                                            : 'ایمن'}
                                      </span>
                                    </p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => onNavigate('treasury', 'cheques', 'tr-cheques')}
                                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  مدیریت چک‌ها
                                </button>
                              </div>

                              {pendingCheques.length === 0 ? (
                                <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400 rounded-xl bg-slate-50/80 dark:bg-slate-950/40 border border-slate-100 dark:border-slate-800/80">
                                  چک در جریان وصول یا سررسید نزدیک ثبت نشده است.
                                </div>
                              ) : (
                                <div className="divide-y divide-slate-100 dark:divide-slate-800/80 border-t border-b border-slate-100 dark:border-slate-800/80">
                                  {pendingCheques.slice(0, 4).map((alert) => {
                                    const ch = alert.cheque;
                                    const isCritical =
                                      alert.severity === 'bounced' ||
                                      alert.severity === 'overdue' ||
                                      alert.severity === 'today';
                                    return (
                                      <button
                                        key={ch.id}
                                        type="button"
                                        onClick={() =>
                                          onNavigate('treasury', `cheque:${ch.id}`, 'tr-cheques')
                                        }
                                        className="w-full py-2.5 flex items-center justify-between gap-2 text-xs text-right hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                                      >
                                        <div className="min-w-0">
                                          <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                                            {ch.partyName}
                                          </div>
                                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 tabular-nums">
                                            <span className="font-code">
                                              {toPersianDigits(ch.dueDate)}
                                            </span>
                                            <span aria-hidden="true">·</span>
                                            <span
                                              className={
                                                ch.direction === 'receivable'
                                                  ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                                  : 'text-rose-600 dark:text-rose-400 font-medium'
                                              }
                                            >
                                              {ch.direction === 'receivable'
                                                ? 'دریافتی'
                                                : 'پرداختی'}
                                            </span>
                                            <span aria-hidden="true">·</span>
                                            <span
                                              className={
                                                isCritical
                                                  ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                                  : 'text-amber-600 dark:text-amber-400 font-medium'
                                              }
                                            >
                                              {alert.urgencyLabel}
                                            </span>
                                          </div>
                                        </div>
                                        <div className="font-code tabular-nums font-bold text-slate-900 dark:text-white shrink-0">
                                          {formatCompactMoney(ch.amount, unit)}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center justify-between gap-2 pt-1 text-xs">
                              <button
                                type="button"
                                onClick={() => setActiveWorkspaceTab('operations')}
                                className="text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Zap className="w-3.5 h-3.5" />
                                <span>میز کار سریع هلو ۹.۶</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setActiveWorkspaceTab('sync_health')}
                                className="text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Activity className="w-3.5 h-3.5" />
                                <span>سلامت آفلاین و سینک</span>
                              </button>
                            </div>
                          </div>
                        );
                      }}
                        </SortableDashboardCard>
                      );
                    })}
                  </AnimatePresence>
                </section>
              </LayoutGroup>
            </SortableContext>

            <DragOverlay dropAnimation={widgetDropAnimation}>
              {activeDragWidgetId ? (
                <motion.div
                  dir="rtl"
                  initial={{ scale: 0.985, opacity: 0.92 }}
                  animate={{ scale: 1.02, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 32, mass: 0.8 }}
                  className="rounded-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-2 border-indigo-500 shadow-2xl p-5 flex items-center justify-between gap-3 cursor-grabbing"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="h-8 w-8 rounded-lg bg-indigo-600 text-white inline-flex items-center justify-center shrink-0">
                      <GripVertical className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                        {DASHBOARD_WIDGET_META[activeDragWidgetId].title}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        کارت را در موقعیت دلخواه رها کنید
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </DragOverlay>
          </DndContext>
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
          onExpandCard={(analyticsCardId) => setExpandedCardId(analyticsCardId)}
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
        <div className="space-y-6">
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
      {/* Financial Voice Search Dialog (Persian Web Speech API + Instant Local Fuzzy Financial Engine) */}
      <FinancialVoiceSearchPanel
        open={voiceSearchOpen}
        onClose={() => {
          setVoiceSearchOpen(false);
          setVoiceAutoStart(false);
        }}
        query={voiceQuery}
        onQueryChange={setVoiceQuery}
        dataset={voiceDataset}
        onNavigate={onNavigate}
        onApplyDashboardFilter={(filterText) => {
          setQuickSearch(filterText);
          setActiveWorkspaceTab('executive');
        }}
        autoStartListening={voiceAutoStart}
      />
      {/* Full-Size / Fullscreen Dashboard Card Expand Modal */}
      <DashboardCardExpandModal
        cardId={expandedCardId}
        onClose={() => setExpandedCardId(null)}
        unit={unit}
        unitLabel={unitLabel}
        currencyWord={currencyWord}
        fiscalYear={profile.fiscalYear}
        liquidity={liquidity}
        totalReceivables={totalReceivables}
        totalInventoryValue={totalInventoryValue}
        netSales={incomeStatement.netSales}
        netProfit={incomeStatement.netProfit}
        netMarginPct={incomeStatement.netMarginPct}
        invoices={invoices}
        vouchers={vouchers}
        products={products}
        lowStockProducts={lowStockProducts}
        parties={parties}
        partyBalances={partyBalances}
        cheques={cheques}
        pendingCheques={pendingCheques}
        liquidityRadar={liquidityRadar}
        cashFlowChartData={cashFlowChartData}
        expensePieData={expensePieData}
        pnlBarData={pnlBarData}
        bankBalancesData={bankBalancesData}
        onNavigate={onNavigate}
      />
    </div>
  );
};
