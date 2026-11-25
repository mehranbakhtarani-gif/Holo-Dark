import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Landmark,
  Maximize2,
  Minimize2,
  Package,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
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
import type {
  ActiveModule,
  Cheque,
  CurrencyUnit,
  Invoice,
  Party,
  Product,
  Voucher,
} from '../../types/accounting';
import type { DashboardKpiCardId, DashboardWidgetCardId } from '../../lib/dashboardLayout';
import type { computeChequeAlerts } from '../../lib/chequeAlerts';
import type { computeCashFlowLiquidityRadar } from '../../lib/smartIntelligence';
import { exportToCsv, formatCompactMoney, formatMoney, toPersianDigits } from '../../lib/format';
import { fuzzyFilterAndRank } from '../../lib/fuzzySearch';

export type AnalyticsExpandCardId =
  | 'analytics:radar'
  | 'analytics:cashflow'
  | 'analytics:expenses'
  | 'analytics:pnl'
  | 'analytics:banks'
  | 'analytics:vouchers';

export type DashboardExpandableCardId =
  | `kpi:${DashboardKpiCardId}`
  | `widget:${DashboardWidgetCardId}`
  | AnalyticsExpandCardId;

export interface CashFlowDatum {
  month: string;
  ورودی: number;
  خروجی: number;
  مانده: number;
}

export interface ExpensePieDatum {
  code: string;
  name: string;
  rawAmount: number;
  value: number;
  pct: number;
  color: string;
}

export interface PnlBarDatum {
  month: string;
  درآمد: number;
  هزینه: number;
  سود: number;
}

export interface BankBalanceDatum {
  code: string;
  name: string;
  fullTitle: string;
  rawBalance: number;
  مانده: number;
  isBank: boolean;
  color: string;
}

type ChequeAlertItem = ReturnType<typeof computeChequeAlerts>['allActiveAlerts'][number];
type LiquidityRadarResult = ReturnType<typeof computeCashFlowLiquidityRadar>;

export interface DashboardCardExpandModalProps {
  cardId: DashboardExpandableCardId | null;
  onClose: () => void;
  unit: CurrencyUnit;
  unitLabel: string;
  currencyWord: string;
  fiscalYear: string;
  liquidity: number;
  totalReceivables: number;
  totalInventoryValue: number;
  netSales: number;
  netProfit: number;
  netMarginPct: number;
  invoices: Invoice[];
  vouchers: Voucher[];
  products: Product[];
  lowStockProducts: Product[];
  parties: Party[];
  partyBalances: Map<string, number>;
  cheques: Cheque[];
  pendingCheques: ChequeAlertItem[];
  liquidityRadar: LiquidityRadarResult;
  cashFlowChartData: CashFlowDatum[];
  expensePieData: ExpensePieDatum[];
  pnlBarData: PnlBarDatum[];
  bankBalancesData: BankBalanceDatum[];
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}

const modalSpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 34,
  mass: 0.85,
};

const INVOICE_TYPE_LABEL: Record<string, string> = {
  sale: 'فاکتور فروش رسمی',
  purchase: 'فاکتور خرید',
  proforma: 'پیش‌فاکتور',
  sale_return: 'برگشت از فروش',
  purchase_return: 'برگشت از خرید',
  waste: 'ضایعات انبار',
};

const CHEQUE_STATUS_LABEL: Record<string, string> = {
  in_box: 'در صندوق',
  deposited: 'در جریان وصول',
  endorsed: 'خرج‌شده',
  cleared: 'پاس‌شده',
  bounced: 'برگشتی',
  cancelled: 'باطل‌شده',
};

interface CardMetaConfig {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  primaryActionLabel: string;
  onPrimaryAction: (onNavigate: DashboardCardExpandModalProps['onNavigate']) => void;
}

const CARD_META: Record<DashboardExpandableCardId, CardMetaConfig> = {
  'kpi:balance': {
    title: 'جزئیات کامل موجودی نقد و بانک',
    subtitle: 'تفکیک مانده حساب‌های صندوق، بانک‌ها و روند تجمعی جریان نقدینگی دوره',
    icon: Wallet,
    primaryActionLabel: 'ورود به ماژول خزانه‌داری',
    onPrimaryAction: (nav) => nav('treasury'),
  },
  'kpi:receivables': {
    title: 'جزئیات کامل مطالبات و اسناد دریافتنی',
    subtitle: 'فهرست مشتریان بدهکار، درصد مصرف سقف اعتبار و چک‌های دریافتنی در جریان',
    icon: Landmark,
    primaryActionLabel: 'مدیریت طرف‌حساب‌ها و چک‌ها',
    onPrimaryAction: (nav) => nav('parties'),
  },
  'kpi:inventory': {
    title: 'ارزش‌گذاری و جزئیات کامل موجودی انبار',
    subtitle: 'موجودی وزنی و ریالی کلیه اقلام انبار، مقایسه با نقطه سفارش و وضعیت تامین',
    icon: Package,
    primaryActionLabel: 'ورود به انبار و کاردکس',
    onPrimaryAction: (nav) => nav('inventory'),
  },
  'widget:recent_invoices': {
    title: 'فهرست کامل اسناد و فاکتورهای دوره',
    subtitle: 'جستجوی فازی، فیلتر بر اساس نوع فاکتور و مشاهده تفکیک مالیات و نحوه تسویه',
    icon: FileText,
    primaryActionLabel: 'باز کردن صفحه فاکتورها',
    onPrimaryAction: (nav) => nav('invoices'),
  },
  'widget:quick_actions': {
    title: 'مرکز دسترسی سریع و پایش نقطه سفارش انبار',
    subtitle: 'عملیات کلیدی حسابداری و فهرست دقیق کالاهای نیازمند تامین مجدد',
    icon: Package,
    primaryActionLabel: 'مدیریت انبار و خرید',
    onPrimaryAction: (nav) => nav('inventory'),
  },
  'widget:liquidity_pulse': {
    title: 'تحلیل کامل نبض نقدینگی ماهانه',
    subtitle: 'مقایسه ورودی نقدی، خروجی نقدی، خالص جریان ماهانه و مانده تجمعی نقد و بانک',
    icon: BarChart3,
    primaryActionLabel: 'مشاهده دفتر خزانه',
    onPrimaryAction: (nav) => nav('treasury'),
  },
  'widget:urgent_cheques': {
    title: 'جدول کامل سررسید چک‌ها و رادار نقدینگی',
    subtitle: 'بررسی چک‌های دریافتی و پرداختی اولویت‌دار به همراه پیش‌بینی ۳۰ روزه نقدینگی',
    icon: Landmark,
    primaryActionLabel: 'ورود به مدیریت چک صیادی',
    onPrimaryAction: (nav) => nav('treasury', 'cheques', 'tr-cheques'),
  },
  'analytics:radar': {
    title: 'رادار هوشمند نقدینگی و شبیه‌سازی ۳۰ روزه چک‌ها',
    subtitle: 'ارزیابی دقیق افق‌های ۷، ۱۵ و ۳۰ روزه و چک‌های موثر بر مانده نقدی',
    icon: ShieldCheck,
    primaryActionLabel: 'مدیریت چک‌ها و سررسیدها',
    onPrimaryAction: (nav) => nav('treasury', 'cheques', 'tr-cheques'),
  },
  'analytics:cashflow': {
    title: 'جریان نقدینگی ماهانه (ورودی، خروجی و مانده تجمعی)',
    subtitle: 'نمای عریض نمودار به همراه جدول دقیق گردش نقدی به تفکیک ماه‌های سال مالی',
    icon: BarChart3,
    primaryActionLabel: 'ورود به خزانه‌داری',
    onPrimaryAction: (nav) => nav('treasury'),
  },
  'analytics:expenses': {
    title: 'تحلیل جامع ترکیب هزینه‌ها و بهای تمام‌شده',
    subtitle: 'سهم درصدی و مبلغ دقیق هر سرفصل هزینه‌ای از کل هزینه‌های دوره مالی',
    icon: BarChart3,
    primaryActionLabel: 'مشاهده تراز آزمایشی',
    onPrimaryAction: (nav) => nav('reports', 'trial', 'rep-trial'),
  },
  'analytics:pnl': {
    title: 'تحلیل کامل سود و زیان ماهانه',
    subtitle: 'مقایسه درآمد فروش، هزینه‌ها و سود (زیان) خالص ماهانه همراه با حاشیه سود',
    icon: BarChart3,
    primaryActionLabel: 'گزارش رسمی سود و زیان',
    onPrimaryAction: (nav) => nav('reports', 'pnl', 'rep-pnl'),
  },
  'analytics:banks': {
    title: 'گزارش تفکیکی حساب‌های بانکی و صندوق‌ها',
    subtitle: 'مقایسه تصویری و جدولی مانده لحظه‌ای تمامی حساب‌های کدینگ ۱۰۱ و ۱۰۲',
    icon: Wallet,
    primaryActionLabel: 'مشاهده کدینگ حساب‌ها',
    onPrimaryAction: (nav) => nav('accounts'),
  },
  'analytics:vouchers': {
    title: 'دفتر کامل اسناد حسابداری ثبت‌شده',
    subtitle: 'جستجو و بررسی کلیه اسناد دائم و موقت به همراه جمع گردش بدهکار و بستانکار',
    icon: BookOpen,
    primaryActionLabel: 'ورود به کارتابل اسناد',
    onPrimaryAction: (nav) => nav('vouchers'),
  },
};

export const DashboardCardExpandModal: React.FC<DashboardCardExpandModalProps> = ({
  cardId,
  onClose,
  unit,
  unitLabel,
  currencyWord,
  fiscalYear,
  liquidity,
  totalReceivables,
  totalInventoryValue,
  netSales,
  netProfit,
  netMarginPct,
  invoices,
  vouchers,
  products,
  lowStockProducts,
  parties,
  partyBalances,
  cheques,
  pendingCheques,
  liquidityRadar,
  cashFlowChartData,
  expensePieData,
  pnlBarData,
  bankBalancesData,
  onNavigate,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [invoiceTypeFilter, setInvoiceTypeFilter] = useState<string>('all');
  const [inventoryFilter, setInventoryFilter] = useState<'all' | 'low'>('all');
  const [chequeDirFilter, setChequeDirFilter] = useState<'all' | 'receivable' | 'payable'>('all');
  const [voucherStatusFilter, setVoucherStatusFilter] = useState<'all' | 'permanent' | 'draft'>('all');

  useEffect(() => {
    setSearchQuery('');
    setInvoiceTypeFilter('all');
    setInventoryFilter('all');
    setChequeDirFilter('all');
    setVoucherStatusFilter('all');
    setIsFullscreen(false);
  }, [cardId]);

  useEffect(() => {
    if (!cardId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cardId, onClose]);

  const tooltipStyle = useMemo(
    () => ({
      borderRadius: '10px',
      border: '1px solid #cbd5e1',
      backgroundColor: '#ffffff',
      color: '#0f172a',
      fontSize: '12px',
      direction: 'rtl' as const,
      textAlign: 'right' as const,
    }),
    []
  );

  // Derived detailed datasets for expanded inspection
  const sortedInvoices = useMemo(() => {
    const base = [...invoices].sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      return cmp !== 0 ? cmp : b.invoiceNumber.localeCompare(a.invoiceNumber);
    });
    const byType =
      invoiceTypeFilter === 'all'
        ? base
        : base.filter((inv) => inv.invoiceType === invoiceTypeFilter);
    if (!searchQuery.trim()) return byType;
    return fuzzyFilterAndRank(byType, searchQuery, (inv) => [
      { text: inv.invoiceNumber, weight: 1.5 },
      { text: inv.partyName, weight: 1.35 },
      { text: inv.date, weight: 1.0 },
      { text: INVOICE_TYPE_LABEL[inv.invoiceType] || inv.invoiceType, weight: 1.0 },
      { text: inv.items.map((it) => `${it.productName} ${it.sku}`).join(' '), weight: 0.9 },
    ]).map((r) => r.item);
  }, [invoices, invoiceTypeFilter, searchQuery]);

  const filteredProducts = useMemo(() => {
    const base = inventoryFilter === 'low' ? lowStockProducts : products;
    const sorted = [...base].sort(
      (a, b) =>
        (b.inventoryValueIrr ?? Math.round(b.stock * b.buyPrice)) -
        (a.inventoryValueIrr ?? Math.round(a.stock * a.buyPrice))
    );
    if (!searchQuery.trim()) return sorted;
    return fuzzyFilterAndRank(sorted, searchQuery, (p) => [
      { text: p.name, weight: 1.4 },
      { text: p.sku, weight: 1.35 },
      { text: p.warehouse, weight: 1.05 },
      { text: p.category, weight: 1.0 },
    ]).map((r) => r.item);
  }, [products, lowStockProducts, inventoryFilter, searchQuery]);

  const debtorParties = useMemo(() => {
    const rows = parties
      .map((p) => ({
        party: p,
        balance: partyBalances.get(p.id) ?? 0,
      }))
      .filter((r) => r.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    if (!searchQuery.trim()) return rows;
    return fuzzyFilterAndRank(rows, searchQuery, (r) => [
      { text: r.party.name, weight: 1.4 },
      { text: r.party.code, weight: 1.3 },
      { text: r.party.phone || '', weight: 1.0 },
    ]).map((r) => r.item);
  }, [parties, partyBalances, searchQuery]);

  const filteredChequeAlerts = useMemo(() => {
    const byDir =
      chequeDirFilter === 'all'
        ? pendingCheques
        : pendingCheques.filter((a) => a.cheque.direction === chequeDirFilter);
    if (!searchQuery.trim()) return byDir;
    return fuzzyFilterAndRank(byDir, searchQuery, (a) => [
      { text: a.cheque.partyName, weight: 1.4 },
      { text: a.cheque.bankName, weight: 1.2 },
      { text: a.cheque.sayadiId, weight: 1.35 },
      { text: a.cheque.serial, weight: 1.25 },
      { text: a.cheque.dueDate, weight: 1.1 },
    ]).map((r) => r.item);
  }, [pendingCheques, chequeDirFilter, searchQuery]);

  const filteredVouchers = useMemo(() => {
    const sorted = [...vouchers].sort((a, b) => b.voucherNumber - a.voucherNumber);
    const byStatus =
      voucherStatusFilter === 'all'
        ? sorted
        : sorted.filter((v) => v.status === voucherStatusFilter);
    if (!searchQuery.trim()) return byStatus;
    return fuzzyFilterAndRank(byStatus, searchQuery, (v) => [
      { text: String(v.voucherNumber), weight: 1.5 },
      { text: v.description, weight: 1.3 },
      { text: v.date, weight: 1.0 },
      { text: v.lines.map((l) => `${l.accountTitle} ${l.accountCode}`).join(' '), weight: 0.9 },
    ]).map((r) => r.item);
  }, [vouchers, voucherStatusFilter, searchQuery]);

  const meta = cardId ? CARD_META[cardId] : null;

  const handleExportCurrentCsv = () => {
    if (!cardId) return;
    if (cardId === 'widget:recent_invoices') {
      exportToCsv(
        `invoices-${fiscalYear}.csv`,
        ['شماره فاکتور', 'نوع', 'طرف حساب', 'تاریخ', `جمع کل (${currencyWord})`, 'وضعیت'],
        sortedInvoices.map((inv) => [
          inv.invoiceNumber,
          INVOICE_TYPE_LABEL[inv.invoiceType] || inv.invoiceType,
          inv.partyName,
          inv.date,
          unit === 'IRT' ? Math.round(inv.grandTotal / 10) : inv.grandTotal,
          inv.status === 'settled' ? 'تسویه‌شده' : inv.status === 'cancelled' ? 'ابطال‌شده' : 'صادرشده',
        ])
      );
      return;
    }
    if (cardId === 'kpi:inventory') {
      exportToCsv(
        `inventory-valuation-${fiscalYear}.csv`,
        ['کد کالا', 'نام کالا', 'انبار', 'موجودی', 'نقطه سفارش', `ارزش ریالی (${currencyWord})`],
        filteredProducts.map((p) => {
          const val = p.inventoryValueIrr ?? Math.round(p.stock * p.buyPrice);
          return [
            p.sku,
            p.name,
            p.warehouse,
            p.stock,
            p.reorderPoint,
            unit === 'IRT' ? Math.round(val / 10) : val,
          ];
        })
      );
      return;
    }
    if (cardId === 'widget:liquidity_pulse' || cardId === 'analytics:cashflow') {
      exportToCsv(
        `monthly-cashflow-${fiscalYear}.csv`,
        ['ماه', `ورودی (${unitLabel})`, `خروجی (${unitLabel})`, `خالص ماه (${unitLabel})`, `مانده تجمعی (${unitLabel})`],
        cashFlowChartData.map((d) => [d.month, d.ورودی, d.خروجی, d.ورودی - d.خروجی, d.مانده])
      );
      return;
    }
    if (cardId === 'analytics:pnl') {
      exportToCsv(
        `monthly-pnl-${fiscalYear}.csv`,
        ['ماه', `درآمد (${unitLabel})`, `هزینه (${unitLabel})`, `سود خالص (${unitLabel})`],
        pnlBarData.map((d) => [d.month, d.درآمد, d.هزینه, d.سود])
      );
      return;
    }
    if (cardId === 'analytics:expenses') {
      exportToCsv(
        `expense-composition-${fiscalYear}.csv`,
        ['کد حساب', 'عنوان سرفصل', `مبلغ (${currencyWord})`, 'سهم (٪)'],
        expensePieData.map((e) => [
          e.code,
          e.name,
          unit === 'IRT' ? Math.round(e.rawAmount / 10) : e.rawAmount,
          e.pct,
        ])
      );
      return;
    }
    if (cardId === 'kpi:balance' || cardId === 'analytics:banks') {
      exportToCsv(
        `cash-bank-balances-${fiscalYear}.csv`,
        ['کد حساب', 'عنوان حساب', 'نوع', `مانده (${currencyWord})`],
        bankBalancesData.map((b) => [
          b.code,
          b.fullTitle,
          b.isBank ? 'بانک' : 'صندوق',
          unit === 'IRT' ? Math.round(b.rawBalance / 10) : b.rawBalance,
        ])
      );
      return;
    }
    if (cardId === 'widget:urgent_cheques' || cardId === 'analytics:radar') {
      exportToCsv(
        `urgent-cheques-${fiscalYear}.csv`,
        ['طرف حساب', 'بانک', 'شناسه صیادی', 'نوع', 'سررسید', 'وضعیت فوریت', `مبلغ (${currencyWord})`],
        filteredChequeAlerts.map((a) => [
          a.cheque.partyName,
          a.cheque.bankName,
          a.cheque.sayadiId,
          a.cheque.direction === 'receivable' ? 'دریافتی' : 'پرداختی',
          a.cheque.dueDate,
          a.urgencyLabel,
          unit === 'IRT' ? Math.round(a.cheque.amount / 10) : a.cheque.amount,
        ])
      );
    }
  };

  const canExportCsv =
    cardId === 'widget:recent_invoices' ||
    cardId === 'kpi:inventory' ||
    cardId === 'widget:liquidity_pulse' ||
    cardId === 'analytics:cashflow' ||
    cardId === 'analytics:pnl' ||
    cardId === 'analytics:expenses' ||
    cardId === 'kpi:balance' ||
    cardId === 'analytics:banks' ||
    cardId === 'widget:urgent_cheques' ||
    cardId === 'analytics:radar';

  const navigateAndClose = (mod: ActiveModule, intent?: string, subKey?: string) => {
    onClose();
    onNavigate(mod, intent, subKey);
  };

  return (
    <AnimatePresence>
      {cardId && meta && (
        <motion.div
          key="dashboard-expand-backdrop"
          dir="rtl"
          role="dialog"
          aria-modal="true"
          aria-label={meta.title}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          className={`fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center ${
            isFullscreen ? 'p-0' : 'p-3 sm:p-6'
          }`}
        >
          <motion.div
            key={`dashboard-expand-shell-${cardId}`}
            layout
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={modalSpring}
            onClick={(e) => e.stopPropagation()}
            className={`bg-white dark:bg-[#0F141F] border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col overflow-hidden transition-[width,height,border-radius] duration-200 ${
              isFullscreen
                ? 'w-screen h-screen rounded-none border-0'
                : 'w-full max-w-6xl max-h-[90vh] rounded-2xl'
            }`}
          >
            {/* Modal Header */}
            <header className="px-5 py-4 border-b border-slate-200/80 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-[#151A24] shrink-0">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/70 dark:border-indigo-800/60 flex items-center justify-center shrink-0">
                  <meta.icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white tracking-tight truncate">
                    {meta.title}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {meta.subtitle}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {canExportCsv && (
                  <button
                    type="button"
                    onClick={handleExportCurrentCsv}
                    className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline">خروجی CSV</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    meta.onPrimaryAction(onNavigate);
                  }}
                  className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                >
                  <span>{meta.primaryActionLabel}</span>
                  <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                </button>

                <button
                  type="button"
                  onClick={() => setIsFullscreen((prev) => !prev)}
                  title={isFullscreen ? 'بازگشت به ابعاد پنجره' : 'نمایش تمام‌صفحه'}
                  aria-label={isFullscreen ? 'بازگشت به ابعاد پنجره' : 'نمایش تمام‌صفحه'}
                  className="h-9 w-9 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-700 inline-flex items-center justify-center cursor-pointer transition-colors"
                >
                  {isFullscreen ? (
                    <Minimize2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <Maximize2 className="w-4 h-4 shrink-0" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  title="بستن (Esc)"
                  aria-label="بستن پنجره جزئیات"
                  className="h-9 w-9 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4 shrink-0" />
                </button>
              </div>
            </header>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
              {/* 1. KPI: CASH & BANK BALANCE OR ANALYTICS: BANKS */}
              {(cardId === 'kpi:balance' || cardId === 'analytics:banks') && (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-slate-200/80 dark:divide-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">جمع نقد و بانک</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-indigo-600 dark:text-indigo-400">
                        {formatMoney(liquidity, unit)}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">تعداد حساب‌های فعال</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-slate-900 dark:text-white">
                        {toPersianDigits(bankBalancesData.length)} حساب
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">فروش خالص دوره</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCompactMoney(netSales, unit)}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">پیش‌بینی ۳۰ روزه</div>
                      <div
                        className={`mt-1 text-lg font-extrabold font-code tabular-nums ${
                          liquidityRadar.riskLevel === 'critical'
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        {formatCompactMoney(
                          liquidityRadar.horizons[liquidityRadar.horizons.length - 1]?.projectedBalance ??
                            liquidity,
                          unit
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <div className="lg:col-span-6 rounded-xl border border-slate-200/80 dark:border-slate-800 p-4 bg-white dark:bg-[#151A24]">
                      <div className="text-sm font-bold text-slate-900 dark:text-white mb-1">
                        مقایسه مانده صندوق‌ها و بانک‌ها
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        واحد محور افقی: {unitLabel}
                      </div>
                      <div className="h-72 w-full" dir="ltr">
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
                              width={120}
                              tick={{ fontSize: 11, fill: '#475569' }}
                            />
                            <Tooltip
                              contentStyle={tooltipStyle}
                              formatter={(value: unknown) => [
                                `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                                'مانده حساب',
                              ]}
                            />
                            <Bar dataKey="مانده" radius={[0, 4, 4, 0]} barSize={22}>
                              {bankBalancesData.map((entry) => (
                                <Cell key={entry.code} fill={entry.color} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="lg:col-span-6 rounded-xl border border-slate-200/80 dark:border-slate-800 p-4 bg-white dark:bg-[#151A24]">
                      <div className="text-sm font-bold text-slate-900 dark:text-white mb-1">
                        روند تجمعی نقدینگی سال مالی {toPersianDigits(fiscalYear)}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        بر حسب {unitLabel}
                      </div>
                      <div className="h-72 w-full" dir="ltr">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart
                            data={cashFlowChartData}
                            margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                          >
                            <defs>
                              <linearGradient id="expandCashGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.28} />
                                <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.02} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                            <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                            <Tooltip
                              contentStyle={tooltipStyle}
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
                              fill="url(#expandCashGrad)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                            <th className="py-3 px-4 font-medium whitespace-nowrap">کد حساب</th>
                            <th className="py-3 px-4 font-medium">عنوان کامل حساب</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">گروه</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">سهم از نقدینگی</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">مانده ({currencyWord})</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {bankBalancesData.map((b) => {
                            const share =
                              liquidity > 0 ? Math.max(0, Math.round((b.rawBalance / liquidity) * 1000) / 10) : 0;
                            return (
                              <tr
                                key={b.code}
                                onClick={() => navigateAndClose('accounts')}
                                className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                              >
                                <td className="py-3 px-4 font-code tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                                  {toPersianDigits(b.code)}
                                </td>
                                <td className="py-3 px-4 font-medium text-slate-900 dark:text-white">
                                  {b.fullTitle}
                                </td>
                                <td className="py-3 px-4 text-slate-500 dark:text-slate-400">
                                  {b.isBank ? 'حساب بانکی' : 'صندوق نقدی'}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                                  {toPersianDigits(share)}٪
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                                  {formatMoney(b.rawBalance, unit, false)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* 2. KPI: RECEIVABLES */}
              {cardId === 'kpi:receivables' && (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-slate-200/80 dark:divide-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">کل مطالبات و اسناد دریافتنی</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatMoney(totalReceivables, unit)}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">مشتریان دارای مانده بدهکار</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-slate-900 dark:text-white">
                        {toPersianDigits(debtorParties.length)} طرف‌حساب
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">سود خالص دوره</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-indigo-600 dark:text-indigo-400">
                        {formatCompactMoney(netProfit, unit)}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">حاشیه سود خالص</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-slate-900 dark:text-white">
                        {toPersianDigits(netMarginPct.toFixed(1))}٪
                      </div>
                    </div>
                  </div>

                  <div className="relative max-w-md">
                    <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="جستجوی طرف‌حساب، کد یا شماره تماس..."
                      className="w-full h-10 pr-10 pl-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    {debtorParties.length === 0 ? (
                      <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                        هیچ طرف‌حساب بدهکاری با فیلتر فعلی یافت نشد.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-right border-collapse text-xs sm:text-sm">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                              <th className="py-3 px-4 font-medium whitespace-nowrap">کد</th>
                              <th className="py-3 px-4 font-medium">نام طرف‌حساب</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">تلفن</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">سقف اعتبار</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">مانده بدهکار ({currencyWord})</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {debtorParties.map(({ party, balance }) => {
                              const overLimit = party.creditLimit > 0 && balance > party.creditLimit;
                              return (
                                <tr
                                  key={party.id}
                                  onClick={() => navigateAndClose('parties')}
                                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                                >
                                  <td className="py-3 px-4 font-code tabular-nums text-slate-500 dark:text-slate-400">
                                    {toPersianDigits(party.code)}
                                  </td>
                                  <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                    {party.name}
                                  </td>
                                  <td className="py-3 px-4 font-code tabular-nums text-slate-600 dark:text-slate-300">
                                    {party.phone ? toPersianDigits(party.phone) : '—'}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                    {party.creditLimit > 0
                                      ? formatCompactMoney(party.creditLimit, unit)
                                      : 'نامحدود'}
                                  </td>
                                  <td
                                    className={`py-3 px-4 text-left font-code tabular-nums font-bold whitespace-nowrap ${
                                      overLimit
                                        ? 'text-rose-600 dark:text-rose-400'
                                        : 'text-slate-900 dark:text-white'
                                    }`}
                                  >
                                    {formatMoney(balance, unit, false)}
                                    {overLimit && (
                                      <span className="mr-2 text-[11px] font-sans font-semibold text-rose-600 dark:text-rose-400">
                                        · عبور از سقف
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 3. KPI: INVENTORY VALUATION */}
              {cardId === 'kpi:inventory' && (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-slate-200/80 dark:divide-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">ارزش کل موجودی انبار</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-indigo-600 dark:text-indigo-400">
                        {formatMoney(totalInventoryValue, unit)}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">تعداد کل ردیف‌های کالا</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-slate-900 dark:text-white">
                        {toPersianDigits(products.length)} قلم
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">کالاهای زیر نقطه سفارش</div>
                      <div
                        className={`mt-1 text-lg font-extrabold font-code tabular-nums ${
                          lowStockProducts.length > 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {toPersianDigits(lowStockProducts.length)} قلم
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs text-slate-500 dark:text-slate-400">جمع مقدار فیزیکی</div>
                      <div className="mt-1 text-lg font-extrabold font-code tabular-nums text-slate-900 dark:text-white">
                        {toPersianDigits(
                          Math.round(products.reduce((s, p) => s + p.stock, 0)).toLocaleString('en-US')
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[220px] max-w-md">
                      <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="جستجوی نام کالا، کد SKU، انبار یا دسته‌بندی..."
                        className="w-full h-10 pr-10 pl-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
                      <button
                        type="button"
                        onClick={() => setInventoryFilter('all')}
                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                          inventoryFilter === 'all'
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 font-medium'
                        }`}
                      >
                        همه کالاها ({toPersianDigits(products.length)})
                      </button>
                      <button
                        type="button"
                        onClick={() => setInventoryFilter('low')}
                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                          inventoryFilter === 'low'
                            ? 'bg-rose-600 text-white font-semibold shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 font-medium'
                        }`}
                      >
                        زیر نقطه سفارش ({toPersianDigits(lowStockProducts.length)})
                      </button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                            <th className="py-3 px-4 font-medium whitespace-nowrap">کد SKU</th>
                            <th className="py-3 px-4 font-medium">نام کالا</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">انبار</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">موجودی فعلی</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">نقطه سفارش</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">بهای واحد</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">ارزش کل ({currencyWord})</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {filteredProducts.map((p) => {
                            const val = p.inventoryValueIrr ?? Math.round(p.stock * p.buyPrice);
                            const isLow = p.stock < p.reorderPoint;
                            return (
                              <tr
                                key={p.id}
                                onClick={() => navigateAndClose('inventory', 'kardex', 'inv-kardex')}
                                className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                              >
                                <td className="py-3 px-4 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                  {toPersianDigits(p.sku)}
                                </td>
                                <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                  {p.name}
                                </td>
                                <td className="py-3 px-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                  {p.warehouse}
                                </td>
                                <td
                                  className={`py-3 px-4 text-left font-code tabular-nums font-bold whitespace-nowrap ${
                                    isLow
                                      ? 'text-rose-600 dark:text-rose-400'
                                      : 'text-emerald-700 dark:text-emerald-400'
                                  }`}
                                >
                                  {toPersianDigits(p.stock.toLocaleString('en-US'))} {p.unit}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                  {toPersianDigits(p.reorderPoint.toLocaleString('en-US'))}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                  {formatMoney(p.buyPrice, unit, false)}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                                  {formatMoney(val, unit, false)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* 4. WIDGET: RECENT INVOICES (FULL ARCHIVE TABLE) */}
              {cardId === 'widget:recent_invoices' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[220px] max-w-md">
                      <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="جستجوی فازی شماره فاکتور، طرف‌حساب، تاریخ یا کالا..."
                        className="w-full h-10 pr-10 pl-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
                      {[
                        { id: 'all', label: 'همه' },
                        { id: 'sale', label: 'فروش رسمی' },
                        { id: 'purchase', label: 'خرید' },
                        { id: 'proforma', label: 'پیش‌فاکتور' },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setInvoiceTypeFilter(tab.id)}
                          className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                            invoiceTypeFilter === tab.id
                              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold shadow-xs'
                              : 'text-slate-600 dark:text-slate-400 font-medium'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    {sortedInvoices.length === 0 ? (
                      <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                        فاکتوری مطابق با جستجو یا فیلتر انتخابی یافت نشد.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-right border-collapse text-xs sm:text-sm">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                              <th className="py-3 px-4 font-medium whitespace-nowrap">شماره فاکتور</th>
                              <th className="py-3 px-4 font-medium">طرف حساب</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">تاریخ</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">تعداد اقلام</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">مالیات</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">مبلغ کل ({currencyWord})</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">وضعیت</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {sortedInvoices.map((inv) => {
                              const isSettled = inv.status === 'settled';
                              const isCancelled = inv.status === 'cancelled';
                              return (
                                <tr
                                  key={inv.id}
                                  onClick={() => navigateAndClose('invoices')}
                                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                                >
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <div className="font-code tabular-nums font-semibold text-slate-900 dark:text-white">
                                      {toPersianDigits(inv.invoiceNumber)}
                                    </div>
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                      {INVOICE_TYPE_LABEL[inv.invoiceType] || inv.invoiceType}
                                    </div>
                                  </td>
                                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                                    {inv.partyName}
                                  </td>
                                  <td className="py-3 px-4 font-code tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                    {toPersianDigits(inv.date)}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                                    {toPersianDigits(inv.items.length)} ردیف
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                    {formatMoney(inv.vatAmount, unit, false)}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                                    {formatMoney(inv.grandTotal, unit, false)}
                                  </td>
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <span
                                      className={`inline-flex items-center gap-1 text-xs font-semibold ${
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
                    )}
                  </div>
                </>
              )}

              {/* 5. WIDGET: QUICK ACTIONS & REORDER ALERTS */}
              {cardId === 'widget:quick_actions' && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      {
                        title: 'دریافت و پرداخت سریع',
                        sub: 'صندوق و بانک‌ها',
                        icon: ArrowLeftRight,
                        action: () => navigateAndClose('treasury', 'quick', 'tr-quick'),
                      },
                      {
                        title: 'کاردکس ریالی و وزنی',
                        sub: 'ورود و خروج انبار',
                        icon: Package,
                        action: () => navigateAndClose('inventory', 'kardex', 'inv-kardex'),
                      },
                      {
                        title: 'مدیریت چک‌های صیادی',
                        sub: `${toPersianDigits(pendingCheques.length)} چک فعال`,
                        icon: Landmark,
                        action: () => navigateAndClose('treasury', 'cheques', 'tr-cheques'),
                      },
                      {
                        title: 'تراز آزمایشی و مرور',
                        sub: 'گزارش‌های حسابداری',
                        icon: BarChart3,
                        action: () => navigateAndClose('reports', 'trial', 'rep-trial'),
                      },
                    ].map((item) => (
                      <button
                        key={item.title}
                        type="button"
                        onClick={item.action}
                        className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 hover:border-indigo-400 dark:hover:border-indigo-600 text-right transition-colors cursor-pointer space-y-2"
                      >
                        <item.icon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                        <div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white">{item.title}</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                            {item.sub}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="px-4 py-3.5 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          فهرست کامل هشدارهای نقطه سفارش انبار
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                          {lowStockProducts.length > 0
                            ? `${toPersianDigits(lowStockProducts.length)} قلم کالا پایین‌تر از حداقل موجودی تعریف‌شده`
                            : `تمامی ${toPersianDigits(products.length)} کالا دارای موجودی کافی هستند`}
                        </p>
                      </div>
                      {lowStockProducts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => navigateAndClose('invoices', 'new-purchase', 'inv-purchase')}
                          className="h-9 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold whitespace-nowrap cursor-pointer"
                        >
                          ثبت فاکتور خرید تامین
                        </button>
                      )}
                    </div>

                    {lowStockProducts.length === 0 ? (
                      <div className="p-10 text-center text-sm text-emerald-700 dark:text-emerald-400 font-medium">
                        هیچ کالایی در وضعیت کسری موجودی یا زیر نقطه سفارش قرار ندارد.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-right border-collapse text-xs sm:text-sm">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                              <th className="py-3 px-4 font-medium">کالا</th>
                              <th className="py-3 px-4 font-medium">انبار</th>
                              <th className="py-3 px-4 font-medium text-left">موجودی فعلی</th>
                              <th className="py-3 px-4 font-medium text-left">حداقل نقطه سفارش</th>
                              <th className="py-3 px-4 font-medium text-left">کسری برای تامین</th>
                              <th className="py-3 px-4 font-medium text-left">برآورد بودجه خرید ({currencyWord})</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {lowStockProducts.map((p) => {
                              const deficit = Math.max(0, p.reorderPoint - p.stock);
                              const estCost = Math.round(deficit * p.buyPrice);
                              return (
                                <tr
                                  key={p.id}
                                  onClick={() => navigateAndClose('inventory', 'kardex', 'inv-kardex')}
                                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                                >
                                  <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                    {p.name}
                                  </td>
                                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300">{p.warehouse}</td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-rose-600 dark:text-rose-400">
                                    {toPersianDigits(p.stock.toLocaleString('en-US'))} {p.unit}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                                    {toPersianDigits(p.reorderPoint.toLocaleString('en-US'))} {p.unit}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                                    {toPersianDigits(deficit.toLocaleString('en-US'))} {p.unit}
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white">
                                    {formatMoney(estCost, unit, false)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 6. WIDGET: LIQUIDITY PULSE OR ANALYTICS: MONTHLY CASHFLOW */}
              {(cardId === 'widget:liquidity_pulse' || cardId === 'analytics:cashflow') && (
                <>
                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-5 bg-white dark:bg-[#151A24]">
                    <div className="h-80 sm:h-96 w-full" dir="ltr">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          data={cashFlowChartData}
                          margin={{ top: 12, right: 20, left: 4, bottom: 4 }}
                        >
                          <defs>
                            <linearGradient id="expandLiquidityArea" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.26} />
                              <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748b' }} />
                          <YAxis tick={{ fontSize: 12, fill: '#64748b' }} />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(value: unknown, name: unknown) => [
                              `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                              String(name),
                            ]}
                          />
                          <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                          <Bar dataKey="ورودی" name="ورودی نقدی" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={26} />
                          <Bar dataKey="خروجی" name="خروجی نقدی" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={26} />
                          <Area
                            type="monotone"
                            dataKey="مانده"
                            name="مانده تجمعی نقد"
                            stroke="#4f46e5"
                            strokeWidth={2.5}
                            fill="url(#expandLiquidityArea)"
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                            <th className="py-3 px-4 font-medium">ماه</th>
                            <th className="py-3 px-4 font-medium text-left">ورودی نقدی ({unitLabel})</th>
                            <th className="py-3 px-4 font-medium text-left">خروجی نقدی ({unitLabel})</th>
                            <th className="py-3 px-4 font-medium text-left">خالص جریان ماه</th>
                            <th className="py-3 px-4 font-medium text-left">مانده تجمعی نقد</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {cashFlowChartData.map((row) => {
                            const net = row.ورودی - row.خروجی;
                            return (
                              <tr key={row.month} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                  {row.month}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {toPersianDigits(row.ورودی.toLocaleString('en-US'))}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-rose-700 dark:text-rose-400">
                                  {toPersianDigits(row.خروجی.toLocaleString('en-US'))}
                                </td>
                                <td
                                  className={`py-3 px-4 text-left font-code tabular-nums font-semibold ${
                                    net >= 0
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : 'text-rose-700 dark:text-rose-400'
                                  }`}
                                >
                                  {net > 0 ? '+' : ''}
                                  {toPersianDigits(net.toLocaleString('en-US'))}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white">
                                  {toPersianDigits(row.مانده.toLocaleString('en-US'))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* 7. WIDGET: URGENT CHEQUES OR ANALYTICS: LIQUIDITY RADAR */}
              {(cardId === 'widget:urgent_cheques' || cardId === 'analytics:radar') && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {liquidityRadar.horizons.map((h) => (
                      <div
                        key={h.horizonDays}
                        className={`rounded-xl border p-4 ${
                          h.hasDeficit
                            ? 'border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/25'
                            : 'border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{h.label}</span>
                          <span>{h.hasDeficit ? 'هشدار کسری' : 'مانده پیش‌بینی'}</span>
                        </div>
                        <div
                          className={`text-xl font-extrabold font-code tabular-nums mt-2 ${
                            h.hasDeficit
                              ? 'text-rose-700 dark:text-rose-400'
                              : 'text-slate-900 dark:text-white'
                          }`}
                        >
                          {formatMoney(h.projectedBalance, unit)}
                        </div>
                        <div className="mt-3 pt-2.5 border-t border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs font-code tabular-nums">
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

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[220px] max-w-md">
                      <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="جستجوی طرف‌حساب، بانک، شناسه صیادی یا تاریخ سررسید..."
                        className="w-full h-10 pr-10 pl-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
                      {(
                        [
                          { id: 'all', label: `همه (${toPersianDigits(pendingCheques.length)})` },
                          { id: 'receivable', label: 'دریافتی' },
                          { id: 'payable', label: 'پرداختی' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setChequeDirFilter(opt.id)}
                          className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                            chequeDirFilter === opt.id
                              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold shadow-xs'
                              : 'text-slate-600 dark:text-slate-400 font-medium'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    {filteredChequeAlerts.length === 0 ? (
                      <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                        چک فعالی با فیلتر انتخابی یافت نشد (تعداد کل چک‌های ثبت‌شده: {toPersianDigits(cheques.length)}).
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-right border-collapse text-xs sm:text-sm">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                              <th className="py-3 px-4 font-medium">طرف حساب</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">بانک / صیادی</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">نوع</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">سررسید</th>
                              <th className="py-3 px-4 font-medium whitespace-nowrap">فوریت</th>
                              <th className="py-3 px-4 font-medium text-left whitespace-nowrap">مبلغ ({currencyWord})</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {filteredChequeAlerts.map((alert) => {
                              const ch = alert.cheque;
                              const isCrit =
                                alert.severity === 'bounced' ||
                                alert.severity === 'overdue' ||
                                alert.severity === 'today';
                              return (
                                <tr
                                  key={ch.id}
                                  onClick={() => navigateAndClose('treasury', `cheque:${ch.id}`, 'tr-cheques')}
                                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                                >
                                  <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                    {ch.partyName}
                                  </td>
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <div className="text-slate-800 dark:text-slate-200">{ch.bankName}</div>
                                    <div className="text-[11px] font-code tabular-nums text-slate-500">
                                      صیادی: {toPersianDigits(ch.sayadiId)} · {CHEQUE_STATUS_LABEL[ch.status] || ch.status}
                                    </div>
                                  </td>
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <span
                                      className={
                                        ch.direction === 'receivable'
                                          ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                                          : 'text-rose-700 dark:text-rose-400 font-semibold'
                                      }
                                    >
                                      {ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی'}
                                    </span>
                                  </td>
                                  <td className="py-3 px-4 font-code tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                                    {toPersianDigits(ch.dueDate)}
                                  </td>
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <span
                                      className={
                                        isCrit
                                          ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                          : 'text-amber-600 dark:text-amber-400 font-medium'
                                      }
                                    >
                                      {alert.urgencyLabel}
                                    </span>
                                  </td>
                                  <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                                    {formatMoney(ch.amount, unit, false)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 8. ANALYTICS: EXPENSE COMPOSITION */}
              {cardId === 'analytics:expenses' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-5 rounded-xl border border-slate-200/80 dark:border-slate-800 p-5 bg-white dark:bg-[#151A24]">
                    <div className="h-80 w-full" dir="ltr">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={expensePieData}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={70}
                            outerRadius={118}
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
                  </div>
                  <div className="lg:col-span-7 rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <table className="w-full text-right border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                          <th className="py-3 px-4 font-medium">کد</th>
                          <th className="py-3 px-4 font-medium">سرفصل هزینه / بهای تمام‌شده</th>
                          <th className="py-3 px-4 font-medium text-left">سهم</th>
                          <th className="py-3 px-4 font-medium text-left">مبلغ ({currencyWord})</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {expensePieData.map((item) => (
                          <tr key={item.code} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-3 px-4 font-code tabular-nums text-slate-500">
                              {toPersianDigits(item.code)}
                            </td>
                            <td className="py-3 px-4 font-medium text-slate-900 dark:text-white flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-xs shrink-0"
                                style={{ backgroundColor: item.color }}
                                aria-hidden="true"
                              />
                              <span>{item.name}</span>
                            </td>
                            <td className="py-3 px-4 text-left font-code tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                              {toPersianDigits(item.pct)}٪
                            </td>
                            <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {formatMoney(item.rawAmount, unit, false)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 9. ANALYTICS: MONTHLY P&L */}
              {cardId === 'analytics:pnl' && (
                <>
                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-5 bg-white dark:bg-[#151A24]">
                    <div className="h-80 sm:h-96 w-full" dir="ltr">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={pnlBarData} margin={{ top: 12, right: 20, left: 4, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748b' }} />
                          <YAxis tick={{ fontSize: 12, fill: '#64748b' }} />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(value: unknown, name: unknown) => [
                              `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                              String(name),
                            ]}
                          />
                          <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                          <Bar dataKey="درآمد" name="درآمد فروش" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="هزینه" name="بهای تمام‌شده و هزینه" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="سود" name="سود (زیان) خالص" fill="#10b981" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                            <th className="py-3 px-4 font-medium">ماه</th>
                            <th className="py-3 px-4 font-medium text-left">درآمد ({unitLabel})</th>
                            <th className="py-3 px-4 font-medium text-left">هزینه ({unitLabel})</th>
                            <th className="py-3 px-4 font-medium text-left">سود (زیان) خالص</th>
                            <th className="py-3 px-4 font-medium text-left">حاشیه سود</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {pnlBarData.map((row) => {
                            const margin =
                              row.درآمد > 0 ? Math.round((row.سود / row.درآمد) * 1000) / 10 : 0;
                            return (
                              <tr key={row.month} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                                  {row.month}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-indigo-700 dark:text-indigo-400">
                                  {toPersianDigits(row.درآمد.toLocaleString('en-US'))}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                                  {toPersianDigits(row.هزینه.toLocaleString('en-US'))}
                                </td>
                                <td
                                  className={`py-3 px-4 text-left font-code tabular-nums font-bold ${
                                    row.سود >= 0
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : 'text-rose-700 dark:text-rose-400'
                                  }`}
                                >
                                  {toPersianDigits(row.سود.toLocaleString('en-US'))}
                                </td>
                                <td className="py-3 px-4 text-left font-code tabular-nums text-slate-600 dark:text-slate-300">
                                  {toPersianDigits(margin)}٪
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* 10. ANALYTICS: RECENT VOUCHERS (FULL SEARCHABLE LEDGER) */}
              {cardId === 'analytics:vouchers' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[220px] max-w-md">
                      <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="جستجوی شماره سند، شرح یا نام حساب..."
                        className="w-full h-10 pr-10 pl-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
                      {(
                        [
                          { id: 'all', label: `همه (${toPersianDigits(vouchers.length)})` },
                          { id: 'permanent', label: 'دائم و قطعی' },
                          { id: 'draft', label: 'موقت' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setVoucherStatusFilter(opt.id)}
                          className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                            voucherStatusFilter === opt.id
                              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold shadow-xs'
                              : 'text-slate-600 dark:text-slate-400 font-medium'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-[#151A24]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-slate-50 dark:bg-slate-900/70 text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
                            <th className="py-3 px-4 font-medium whitespace-nowrap">شماره سند</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">تاریخ</th>
                            <th className="py-3 px-4 font-medium">شرح سند</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">تعداد آرتیکل</th>
                            <th className="py-3 px-4 font-medium text-left whitespace-nowrap">گردش بدهکار/بستانکار ({currencyWord})</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">وضعیت</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {filteredVouchers.map((v) => (
                            <tr
                              key={v.id}
                              onClick={() => navigateAndClose('vouchers')}
                              className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                            >
                              <td className="py-3 px-4 font-code tabular-nums font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                                #{toPersianDigits(v.voucherNumber)}
                              </td>
                              <td className="py-3 px-4 font-code tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                {toPersianDigits(v.date)}
                              </td>
                              <td className="py-3 px-4 text-slate-800 dark:text-slate-200">
                                {v.description}
                              </td>
                              <td className="py-3 px-4 text-left font-code tabular-nums text-slate-500 dark:text-slate-400">
                                {toPersianDigits(v.lines.length)} ردیف
                              </td>
                              <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white whitespace-nowrap">
                                {formatMoney(v.totalDebit, unit, false)}
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <span
                                  className={
                                    v.status === 'permanent'
                                      ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                                      : 'text-amber-700 dark:text-amber-400 font-semibold'
                                  }
                                >
                                  {v.status === 'permanent' ? 'دائم و قطعی' : 'موقت'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
