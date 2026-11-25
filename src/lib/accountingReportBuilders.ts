import {
  Account,
  CompanyProfile,
  CurrencyUnit,
  Employee,
  Party,
  TrialBalanceRow,
} from '../types/accounting';
import {
  AccountReviewRow,
  BalanceSheetSummary,
  CashFlowStatementSummary,
  IncomeStatementSummary,
  InvoiceProfitabilityRow,
  LedgerEntry,
  ProductProfitabilityRow,
  Seasonal169Row,
} from './accountingEngine';
import { AbcIntelligenceReport } from './apexExtensions';
import { AgingBucketRow, BrokerCommissionRow } from './enterpriseAccounting';
import { formatMoney, formatWeight, getTodayShamsi, toPersianDigits } from './format';
import { ReportDataRow, StandardAccountingReportSpec } from './accountingReportExport';

export type ReportTabKey =
  | 'trial'
  | 'moroor'
  | 'abc'
  | 'pnl'
  | 'balance'
  | 'cashflow'
  | 'ledger'
  | 'party-ledger'
  | 'vat'
  | 'seasonal-169'
  | 'product-profit'
  | 'aging'
  | 'commissions'
  | 'statutory';

export interface VatSummaryMetrics {
  grossSalesNet: number;
  saleReturnNet: number;
  netSalesBase: number;
  grossSalesTax: number;
  saleReturnTax: number;
  netSalesTax: number;
  grossPurchaseNet: number;
  purchaseReturnNet: number;
  netPurchaseBase: number;
  grossPurchaseTax: number;
  purchaseReturnTax: number;
  netPurchaseTax: number;
  netPayableVat: number;
}

export interface BuildReportSpecParams {
  tab: ReportTabKey;
  profile: CompanyProfile;
  includeDraftsInReports: boolean;
  fromDate: string;
  toDate: string;
  trialCols: 2 | 4 | 6 | 8;
  trialBalance: TrialBalanceRow[];
  trialTotals: {
    openD: number;
    openC: number;
    perD: number;
    perC: number;
    totD: number;
    totC: number;
    balD: number;
    balC: number;
  };
  moroorLevel: 'group' | 'kol' | 'moein';
  moroorRows: AccountReviewRow[];
  abcReport: AbcIntelligenceReport;
  incomeStatement: IncomeStatementSummary;
  balanceSheet: BalanceSheetSummary;
  cashFlowSummary: CashFlowStatementSummary;
  ledgerCode: string;
  accounts: Account[];
  ledgerEntries: LedgerEntry[];
  selectedPartyObj?: Party;
  partyLedgerEntries: LedgerEntry[];
  includeChequesInPartyLedger: boolean;
  vatSummary: VatSummaryMetrics;
  vatSalesMatchesGl: boolean;
  vatPurchaseMatchesGl: boolean;
  seasonal169Rows: Seasonal169Row[];
  profitMode: 'product' | 'invoice';
  productProfitability: ProductProfitabilityRow[];
  invoiceProfitability: InvoiceProfitabilityRow[];
  agingRows: AgingBucketRow[];
  commissionRows: BrokerCommissionRow[];
  employees: Employee[];
  statutoryMonth: string;
}

function fmtNum(val: number, unit: CurrencyUnit, dashZero = true): string {
  if (dashZero && Math.abs(val) < 0.0001) return '—';
  return formatMoney(val, unit, false);
}

function fmtSignedMoney(val: number, unit: CurrencyUnit): string {
  if (val < 0) return `(${formatMoney(Math.abs(val), unit, false)})`;
  return formatMoney(val, unit, false);
}

function fmtPeriod(fiscalYear: string, fromDate: string, toDate: string): string {
  if (fromDate.trim() || toDate.trim()) {
    const start = fromDate.trim() ? toPersianDigits(fromDate.trim()) : `ابتدای ${toPersianDigits(fiscalYear)}`;
    const end = toDate.trim() ? toPersianDigits(toDate.trim()) : `انتهای ${toPersianDigits(fiscalYear)}`;
    return `از ${start} تا ${end}`;
  }
  return `کل سال مالی ${toPersianDigits(fiscalYear)}`;
}

export function buildStandardReportSpec(params: BuildReportSpecParams): StandardAccountingReportSpec {
  const {
    tab,
    profile,
    includeDraftsInReports,
    fromDate,
    toDate,
    trialCols,
    trialBalance,
    trialTotals,
    moroorLevel,
    moroorRows,
    abcReport,
    incomeStatement,
    balanceSheet,
    cashFlowSummary,
    ledgerCode,
    accounts,
    ledgerEntries,
    selectedPartyObj,
    partyLedgerEntries,
    includeChequesInPartyLedger,
    vatSummary,
    vatSalesMatchesGl,
    vatPurchaseMatchesGl,
    seasonal169Rows,
    profitMode,
    productProfitability,
    invoiceProfitability,
    agingRows,
    commissionRows,
    employees,
    statutoryMonth,
  } = params;

  const unit = profile.currencyUnit;
  const voucherScopeLabel = includeDraftsInReports
    ? 'شامل اسناد قطعی و موقت'
    : 'فقط اسناد قطعی (رسمی)';
  const periodLabel = fmtPeriod(profile.fiscalYear, fromDate, toDate);

  if (tab === 'trial') {
    const showOpening = trialCols === 8;
    const showPeriod = trialCols >= 6;
    const showTotal = trialCols >= 4;
    return {
      reportId: `trial_${trialCols}`,
      fileNamePrefix: `holoo-trial-balance-${trialCols}col`,
      title: `تراز آزمایشی ${toPersianDigits(trialCols)} ستونی حساب‌ها`,
      subtitle: 'تراز گردش و مانده حساب‌های معین بر اساس استاندارد گزارشگری مالی',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: trialCols >= 6 ? 'landscape' : 'portrait',
      columns: [
        { key: 'code', label: 'کد حساب', isCode: true, defaultVisible: true, essential: true },
        { key: 'title', label: 'عنوان حساب', align: 'right', defaultVisible: true, essential: true },
        { key: 'openD', label: 'اول دوره بد', isNumeric: true, defaultVisible: showOpening },
        { key: 'openC', label: 'اول دوره بس', isNumeric: true, defaultVisible: showOpening },
        { key: 'perD', label: 'گردش دوره بد', isNumeric: true, defaultVisible: showPeriod },
        { key: 'perC', label: 'گردش دوره بس', isNumeric: true, defaultVisible: showPeriod },
        { key: 'totD', label: 'جمع گردش بد', isNumeric: true, defaultVisible: showTotal },
        { key: 'totC', label: 'جمع گردش بس', isNumeric: true, defaultVisible: showTotal },
        { key: 'balD', label: 'مانده بدهکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'balC', label: 'مانده بستانکار', isNumeric: true, defaultVisible: true, essential: true },
      ],
      rows: trialBalance.map((r) => ({
        id: r.accountCode,
        cells: {
          code: toPersianDigits(r.accountCode),
          title: r.accountTitle,
          openD: fmtNum(r.openingDebit, unit),
          openC: fmtNum(r.openingCredit, unit),
          perD: fmtNum(r.periodDebit, unit),
          perC: fmtNum(r.periodCredit, unit),
          totD: fmtNum(r.totalDebit, unit),
          totC: fmtNum(r.totalCredit, unit),
          balD: fmtNum(r.balanceDebit, unit),
          balC: fmtNum(r.balanceCredit, unit),
        },
      })),
      footerLabel: 'تراز کل (جمع ستون‌ها)',
      footerTotals: {
        openD: fmtNum(trialTotals.openD, unit, false),
        openC: fmtNum(trialTotals.openC, unit, false),
        perD: fmtNum(trialTotals.perD, unit, false),
        perC: fmtNum(trialTotals.perC, unit, false),
        totD: fmtNum(trialTotals.totD, unit, false),
        totC: fmtNum(trialTotals.totC, unit, false),
        balD: fmtNum(trialTotals.balD, unit, false),
        balC: fmtNum(trialTotals.balC, unit, false),
      },
      notes: [
        Math.abs(trialTotals.balD - trialTotals.balC) < 1 && Math.abs(trialTotals.totD - trialTotals.totC) < 1
          ? 'تراز آزمایشی کاملاً متوازن است (جمع بدهکار دقیقاً برابر با جمع بستانکار).'
          : 'هشدار: عدم توازن در ستون‌های تراز آزمایشی مشاهده شد.',
      ],
    };
  }

  if (tab === 'moroor') {
    const levelLabel = moroorLevel === 'group' ? 'سطح گروه حساب' : moroorLevel === 'kol' ? 'سطح حساب کل' : 'سطح حساب معین';
    const totals = moroorRows.reduce(
      (s, r) => ({
        tx: s.tx + r.txCount,
        totD: s.totD + r.totalDebit,
        totC: s.totC + r.totalCredit,
        balD: s.balD + r.balanceDebit,
        balC: s.balC + r.balanceCredit,
      }),
      { tx: 0, totD: 0, totC: 0, balD: 0, balC: 0 }
    );
    return {
      reportId: 'moroor',
      fileNamePrefix: `holoo-moroor-${moroorLevel}`,
      title: `گزارش مرور حساب‌ها (${levelLabel})`,
      subtitle: 'خلاصه گردش و مانده سرفصل‌های انتخابی حسابداری',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'code', label: 'کد حساب', isCode: true, defaultVisible: true, essential: true },
        { key: 'title', label: 'عنوان سرفصل', align: 'right', defaultVisible: true, essential: true },
        { key: 'txCount', label: 'تعداد آرتیکل', align: 'center', isCode: true, defaultVisible: true },
        { key: 'totD', label: 'گردش بدهکار', isNumeric: true, defaultVisible: true },
        { key: 'totC', label: 'گردش بستانکار', isNumeric: true, defaultVisible: true },
        { key: 'balD', label: 'مانده بدهکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'balC', label: 'مانده بستانکار', isNumeric: true, defaultVisible: true, essential: true },
      ],
      rows: moroorRows.map((r) => ({
        id: r.code,
        cells: {
          code: toPersianDigits(r.code),
          title: r.title,
          txCount: toPersianDigits(r.txCount),
          totD: fmtNum(r.totalDebit, unit),
          totC: fmtNum(r.totalCredit, unit),
          balD: fmtNum(r.balanceDebit, unit),
          balC: fmtNum(r.balanceCredit, unit),
        },
      })),
      footerLabel: 'جمع کل مرور حساب‌ها',
      footerTotals: {
        txCount: toPersianDigits(totals.tx),
        totD: fmtNum(totals.totD, unit, false),
        totC: fmtNum(totals.totC, unit, false),
        balD: fmtNum(totals.balD, unit, false),
        balC: fmtNum(totals.balC, unit, false),
      },
    };
  }

  if (tab === 'pnl') {
    const netSalesBase = Math.max(1, Math.abs(incomeStatement.netSales));
    const pct = (val: number) => `${toPersianDigits(((val / netSalesBase) * 100).toFixed(1))}٪`;
    const rows: ReportDataRow[] = [
      {
        id: 'gross_sales',
        cells: {
          code: '۶۰۱۰۱',
          item: 'درآمد ناخالص فروش کالا و خدمات',
          category: 'درآمد عملیاتی',
          amount: fmtSignedMoney(incomeStatement.grossSales, unit),
          sharePct: pct(incomeStatement.grossSales),
        },
      },
      {
        id: 'sales_returns',
        highlight: 'negative',
        cells: {
          code: '۶۰۲۰۱',
          item: 'کسر می‌شود: برگشت از فروش و تخفیفات',
          category: 'کاهنده درآمد',
          amount: `(${formatMoney(incomeStatement.salesReturns, unit, false)})`,
          sharePct: pct(-incomeStatement.salesReturns),
        },
      },
      {
        id: 'net_sales',
        rowType: 'subtotal',
        cells: {
          code: '—',
          item: 'فروش خالص دوره',
          category: 'جمع میانی',
          amount: fmtSignedMoney(incomeStatement.netSales, unit),
          sharePct: '۱۰۰٫۰٪',
        },
      },
      {
        id: 'cogs',
        cells: {
          code: '۷۰۱۰۱',
          item: 'کسر می‌شود: بهای تمام‌شده کالای فروش‌رفته (COGS)',
          category: 'بهای تمام‌شده',
          amount: `(${formatMoney(incomeStatement.cogs, unit, false)})`,
          sharePct: pct(-incomeStatement.cogs),
        },
      },
      {
        id: 'gross_profit',
        rowType: 'subtotal',
        highlight: 'accent',
        cells: {
          code: '—',
          item: 'سود (زیان) ناخالص',
          category: 'سود ناخالص',
          amount: fmtSignedMoney(incomeStatement.grossProfit, unit),
          sharePct: `${toPersianDigits(incomeStatement.grossMarginPct.toFixed(1))}٪`,
        },
      },
      ...incomeStatement.expenseRows
        .filter((e) => !e.code.startsWith('809'))
        .map((e) => ({
          id: `opex_${e.code}`,
          cells: {
            code: toPersianDigits(e.code),
            item: e.title,
            category: 'هزینه عملیاتی / اداری',
            amount: `(${formatMoney(e.amount, unit, false)})`,
            sharePct: pct(-e.amount),
          },
        })),
      {
        id: 'op_profit',
        rowType: 'subtotal',
        highlight: incomeStatement.operatingProfit >= 0 ? 'accent' : 'negative',
        cells: {
          code: '—',
          item: 'سود (زیان) عملیاتی دوره',
          category: 'سود عملیاتی',
          amount: fmtSignedMoney(incomeStatement.operatingProfit, unit),
          sharePct: pct(incomeStatement.operatingProfit),
        },
      },
      ...(incomeStatement.otherRevenue !== 0
        ? [
            {
              id: 'other_rev',
              highlight: 'positive' as const,
              cells: {
                code: '۶۰۳۰۱',
                item:
                  incomeStatement.fxGain !== 0
                    ? `سایر درآمدها و اضافی انبارگردانی (شامل تسعیر ارز)`
                    : 'سایر درآمدها و اضافی انبارگردانی',
                category: 'درآمد غیرعملیاتی',
                amount: fmtSignedMoney(incomeStatement.otherRevenue, unit),
                sharePct: pct(incomeStatement.otherRevenue),
              },
            },
          ]
        : []),
      ...incomeStatement.expenseRows
        .filter((e) => e.code.startsWith('809'))
        .map((e) => ({
          id: `nonop_${e.code}`,
          highlight: 'negative' as const,
          cells: {
            code: toPersianDigits(e.code),
            item: e.title,
            category: 'هزینه مالی / غیرعملیاتی',
            amount: `(${formatMoney(e.amount, unit, false)})`,
            sharePct: pct(-e.amount),
          },
        })),
      {
        id: 'net_profit',
        rowType: 'total',
        highlight: incomeStatement.netProfit >= 0 ? 'positive' : 'negative',
        cells: {
          code: '—',
          item: 'سود (زیان) خالص دوره',
          category: 'نتیجه نهایی دوره',
          amount: fmtSignedMoney(incomeStatement.netProfit, unit),
          sharePct: `${toPersianDigits(incomeStatement.netMarginPct.toFixed(1))}٪`,
        },
      },
    ];

    return {
      reportId: 'pnl',
      fileNamePrefix: 'holoo-income-statement',
      title: 'صورت سود و زیان جامع',
      subtitle: 'طبقه‌بندی استاندارد درآمدها، بهای تمام‌شده و هزینه‌های عملیاتی و غیرعملیاتی',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'portrait',
      kpis: [
        { label: 'فروش خالص', value: formatMoney(incomeStatement.netSales, unit) },
        {
          label: 'سود ناخالص',
          value: formatMoney(incomeStatement.grossProfit, unit),
          tone: incomeStatement.grossProfit >= 0 ? 'accent' : 'negative',
        },
        {
          label: 'حاشیه سود ناخالص',
          value: `${toPersianDigits(incomeStatement.grossMarginPct.toFixed(1))}٪`,
        },
        {
          label: 'سود (زیان) خالص',
          value: formatMoney(incomeStatement.netProfit, unit),
          tone: incomeStatement.netProfit >= 0 ? 'positive' : 'negative',
        },
      ],
      columns: [
        { key: 'code', label: 'کد سرفصل', isCode: true, defaultVisible: true, essential: true },
        { key: 'item', label: 'شرح اقلام سود و زیان', align: 'right', defaultVisible: true, essential: true },
        { key: 'category', label: 'طبقه‌بندی', align: 'right', defaultVisible: true },
        { key: 'amount', label: 'مبلغ دوره', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'sharePct', label: 'درصد از فروش خالص', align: 'center', isCode: true, defaultVisible: true },
      ],
      rows,
    };
  }

  if (tab === 'balance') {
    const assetBase = Math.max(1, balanceSheet.totalAssets);
    const share = (val: number) => `${toPersianDigits(((val / assetBase) * 100).toFixed(1))}٪`;
    const rows: ReportDataRow[] = [
      {
        id: 'sec_assets',
        rowType: 'section',
        cells: { group: 'دارایی‌ها', code: '۱', title: 'دارایی‌های جاری و غیرجاری', amount: '', share: '' },
      },
      ...balanceSheet.assets.map((a) => ({
        id: `ast_${a.code}`,
        cells: {
          group: 'دارایی‌ها',
          code: toPersianDigits(a.code),
          title: a.title,
          amount: fmtSignedMoney(a.amount, unit),
          share: share(a.amount),
        },
      })),
      {
        id: 'tot_assets',
        rowType: 'total',
        highlight: 'accent',
        cells: {
          group: 'جمع دارایی‌ها',
          code: '—',
          title: 'جمع کل دارایی‌ها',
          amount: fmtSignedMoney(balanceSheet.totalAssets, unit),
          share: '۱۰۰٫۰٪',
        },
      },
      {
        id: 'sec_liab',
        rowType: 'section',
        cells: { group: 'بدهی‌ها', code: '۳', title: 'بدهی‌های جاری و غیرجاری', amount: '', share: '' },
      },
      ...balanceSheet.liabilities.map((l) => ({
        id: `liab_${l.code}`,
        cells: {
          group: 'بدهی‌ها',
          code: toPersianDigits(l.code),
          title: l.title,
          amount: fmtSignedMoney(l.amount, unit),
          share: share(l.amount),
        },
      })),
      {
        id: 'sub_liab',
        rowType: 'subtotal',
        cells: {
          group: 'جمع بدهی‌ها',
          code: '—',
          title: 'جمع کل بدهی‌ها',
          amount: fmtSignedMoney(balanceSheet.totalLiabilities, unit),
          share: share(balanceSheet.totalLiabilities),
        },
      },
      {
        id: 'sec_eq',
        rowType: 'section',
        cells: { group: 'حقوق صاحبان سهام', code: '۵', title: 'سرمایه، اندوخته‌ها و سود انباشته', amount: '', share: '' },
      },
      ...balanceSheet.equity.map((e) => ({
        id: `eq_${e.code}`,
        cells: {
          group: 'حقوق مالکانه',
          code: toPersianDigits(e.code),
          title: e.title,
          amount: fmtSignedMoney(e.amount, unit),
          share: share(e.amount),
        },
      })),
      {
        id: 'tot_liab_eq',
        rowType: 'total',
        highlight: balanceSheet.isBalanced ? 'positive' : 'negative',
        cells: {
          group: 'تراز نهایی',
          code: '—',
          title: 'جمع کل بدهی‌ها و حقوق صاحبان سهام',
          amount: fmtSignedMoney(balanceSheet.totalLiabilities + balanceSheet.totalEquity, unit),
          share: share(balanceSheet.totalLiabilities + balanceSheet.totalEquity),
        },
      },
    ];

    return {
      reportId: 'balance',
      fileNamePrefix: 'holoo-balance-sheet',
      title: 'ترازنامه رسمی (صورت وضعیت مالی)',
      subtitle: 'معادله اساسی حسابداری: دارایی‌ها = بدهی‌ها + حقوق صاحبان سهام',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'portrait',
      kpis: [
        { label: 'جمع دارایی‌ها', value: formatMoney(balanceSheet.totalAssets, unit), tone: 'accent' },
        { label: 'جمع بدهی‌ها', value: formatMoney(balanceSheet.totalLiabilities, unit) },
        { label: 'حقوق صاحبان سهام', value: formatMoney(balanceSheet.totalEquity, unit) },
        {
          label: 'وضعیت ترازنامه',
          value: balanceSheet.isBalanced ? 'متوازن (۰ اختلاف)' : 'نامتوازن',
          tone: balanceSheet.isBalanced ? 'positive' : 'negative',
        },
      ],
      columns: [
        { key: 'group', label: 'طبقه حساب', align: 'right', defaultVisible: true },
        { key: 'code', label: 'کد حساب', isCode: true, defaultVisible: true, essential: true },
        { key: 'title', label: 'عنوان سرفصل', align: 'right', defaultVisible: true, essential: true },
        { key: 'amount', label: 'مبلغ مانده', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'share', label: 'سهم از کل دارایی‌ها', align: 'center', isCode: true, defaultVisible: true },
      ],
      rows,
      notes: [
        balanceSheet.isBalanced
          ? 'معادله اساسی ترازنامه کاملاً برقرار است (دارایی‌ها دقیقاً برابر با جمع بدهی‌ها و حقوق صاحبان سهام).'
          : 'عدم توازن در ترازنامه شناسایی شد؛ لطفاً بخش ممیزی حسابرسی را بررسی نمایید.',
      ],
    };
  }

  if (tab === 'cashflow') {
    const netFlow = cashFlowSummary.lines.reduce((s, l) => s + l.amount, 0);
    return {
      reportId: 'cashflow',
      fileNamePrefix: 'holoo-cash-flow',
      title: 'صورت جریان وجوه نقد (روش مستقیم — استاندارد شماره ۲)',
      subtitle: 'تفکیک جریان‌های عملیاتی، سرمایه‌گذاری و تأمین مالی (انتقالات داخلی صندوق و بانک خنثی شده‌اند)',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      kpis: [
        { label: 'موجودی نقد ابتدای دوره', value: formatMoney(cashFlowSummary.openingCash, unit) },
        {
          label: 'خالص عملیاتی',
          value: formatMoney(cashFlowSummary.netOperating, unit),
          tone: cashFlowSummary.netOperating >= 0 ? 'positive' : 'negative',
        },
        { label: 'خالص سرمایه‌گذاری', value: formatMoney(cashFlowSummary.netInvesting, unit) },
        { label: 'موجودی نقد پایان دوره', value: formatMoney(cashFlowSummary.closingCash, unit), tone: 'accent' },
      ],
      columns: [
        { key: 'voucherNumber', label: 'شماره سند', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'date', label: 'تاریخ', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'activity', label: 'طبقه‌بندی فعالیت', align: 'right', defaultVisible: true, essential: true },
        { key: 'counterpartCode', label: 'کد حساب متقابل', isCode: true, defaultVisible: true },
        { key: 'counterpartTitle', label: 'عنوان حساب متقابل', align: 'right', defaultVisible: true },
        { key: 'description', label: 'شرح جریان نقدی', align: 'right', defaultVisible: true, essential: true },
        { key: 'amount', label: 'ورود / خروج نقدی', isNumeric: true, defaultVisible: true, essential: true },
      ],
      rows: cashFlowSummary.lines.map((l, idx) => ({
        id: `${l.voucherId}_${idx}`,
        highlight: l.amount >= 0 ? 'positive' : 'negative',
        cells: {
          voucherNumber: `#${toPersianDigits(l.voucherNumber)}`,
          date: toPersianDigits(l.date),
          activity:
            l.activity === 'operating'
              ? 'عملیاتی'
              : l.activity === 'investing'
                ? 'سرمایه‌گذاری'
                : 'تأمین مالی',
          counterpartCode: toPersianDigits(l.counterpartCode),
          counterpartTitle: l.counterpartTitle,
          description: l.description,
          amount: `${l.amount >= 0 ? '+' : '−'}${formatMoney(Math.abs(l.amount), unit, false)}`,
        },
      })),
      footerLabel: 'خالص تغییر وجوه نقد طی دوره',
      footerTotals: {
        amount: `${netFlow >= 0 ? '+' : '−'}${formatMoney(Math.abs(netFlow), unit, false)}`,
      },
      notes: [
        cashFlowSummary.isReconciled
          ? 'تطابق ۱۰۰٪ صورت جریان وجوه نقد با مانده حساب‌های صندوق و بانک (۱۰۱/۱۰۲) تایید شده است.'
          : 'هشدار: مغایرت بین صورت جریان نقدی و مانده دفاتر نقدی وجود دارد.',
      ],
    };
  }

  if (tab === 'ledger') {
    const accObj = accounts.find((a) => a.code === ledgerCode);
    const totD = ledgerEntries.reduce((s, e) => s + e.debit, 0);
    const totC = ledgerEntries.reduce((s, e) => s + e.credit, 0);
    const endBal = ledgerEntries.length > 0 ? ledgerEntries[ledgerEntries.length - 1].runningBalance : 0;
    return {
      reportId: 'ledger',
      fileNamePrefix: `holoo-ledger-${ledgerCode}`,
      title: `دفتر کل و معین حساب ${toPersianDigits(ledgerCode)}${accObj ? ` — ${accObj.title}` : ''}`,
      subtitle: 'ریز گردش آرتیکل‌های حساب با مانده در خط و تشخیص ماهیت مانده',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'voucherNumber', label: 'شماره سند', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'date', label: 'تاریخ', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'accountCode', label: 'کد حساب', isCode: true, defaultVisible: false },
        { key: 'partyName', label: 'طرف‌حساب / تفصیلی', align: 'right', defaultVisible: true },
        { key: 'description', label: 'شرح آرتیکل', align: 'right', defaultVisible: true, essential: true },
        { key: 'debit', label: 'بدهکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'credit', label: 'بستانکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'runningBalance', label: 'مانده در خط', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'dc', label: 'تشخیص', align: 'center', defaultVisible: true },
      ],
      rows: ledgerEntries.map((e, idx) => ({
        id: `${e.voucherId}_${idx}`,
        cells: {
          voucherNumber: `#${toPersianDigits(e.voucherNumber)}`,
          date: toPersianDigits(e.date),
          accountCode: toPersianDigits(e.accountCode),
          partyName: e.partyName || '—',
          description: e.description,
          debit: fmtNum(e.debit, unit),
          credit: fmtNum(e.credit, unit),
          runningBalance: fmtNum(Math.abs(e.runningBalance), unit, false),
          dc: e.runningBalance > 0 ? 'بد' : e.runningBalance < 0 ? 'بس' : 'تسویه',
        },
      })),
      footerLabel: 'جمع گردش و مانده نهایی دفتر',
      footerTotals: {
        debit: fmtNum(totD, unit, false),
        credit: fmtNum(totC, unit, false),
        runningBalance: fmtNum(Math.abs(endBal), unit, false),
        dc: endBal > 0 ? 'بد' : endBal < 0 ? 'بس' : 'تسویه',
      },
    };
  }

  if (tab === 'party-ledger') {
    const totD = partyLedgerEntries.reduce((s, e) => s + e.debit, 0);
    const totC = partyLedgerEntries.reduce((s, e) => s + e.credit, 0);
    const endBal =
      partyLedgerEntries.length > 0 ? partyLedgerEntries[partyLedgerEntries.length - 1].runningBalance : 0;
    return {
      reportId: 'party-ledger',
      fileNamePrefix: `holoo-party-ledger-${selectedPartyObj?.code || 'party'}`,
      title: `صورتحساب تفصیلی طرف‌حساب — ${selectedPartyObj?.name || 'انتخاب‌نشده'}`,
      subtitle: `${selectedPartyObj?.code ? `کد تفصیلی: ${toPersianDigits(selectedPartyObj.code)} · ` : ''}${
        includeChequesInPartyLedger ? 'شامل گردش اسناد و چک‌های صیادی' : 'گردش حساب‌های تجاری (بدون چک‌ها)'
      }`,
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'voucherNumber', label: 'شماره سند', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'date', label: 'تاریخ', isCode: true, align: 'center', defaultVisible: true, essential: true },
        { key: 'account', label: 'سرفصل حساب', align: 'right', defaultVisible: true },
        { key: 'description', label: 'شرح عملیات', align: 'right', defaultVisible: true, essential: true },
        { key: 'debit', label: 'بدهکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'credit', label: 'بستانکار', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'runningBalance', label: 'مانده', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'dc', label: 'تشخیص', align: 'center', defaultVisible: true },
      ],
      rows: partyLedgerEntries.map((e, idx) => ({
        id: `${e.voucherId}_${idx}`,
        cells: {
          voucherNumber: `#${toPersianDigits(e.voucherNumber)}`,
          date: toPersianDigits(e.date),
          account: `${toPersianDigits(e.accountCode)} — ${e.accountTitle}`,
          description: e.description,
          debit: fmtNum(e.debit, unit),
          credit: fmtNum(e.credit, unit),
          runningBalance: fmtNum(Math.abs(e.runningBalance), unit, false),
          dc: e.runningBalance > 0 ? 'بدهکار' : e.runningBalance < 0 ? 'بستانکار' : 'تسویه',
        },
      })),
      footerLabel: 'جمع گردش و مانده نهایی طرف‌حساب',
      footerTotals: {
        debit: fmtNum(totD, unit, false),
        credit: fmtNum(totC, unit, false),
        runningBalance: fmtNum(Math.abs(endBal), unit, false),
        dc: endBal > 0 ? 'بدهکار' : endBal < 0 ? 'بستانکار' : 'تسویه',
      },
    };
  }

  if (tab === 'vat') {
    return {
      reportId: 'vat',
      fileNamePrefix: 'holoo-vat-report',
      title: 'گزارش خلاصه مالیات بر ارزش افزوده (سامانه مودیان)',
      subtitle: 'تطبیق مالیات فروش (۳۰۳۰۱) و اعتبار مالیاتی خرید (۳۰۳۰۲) با کسر برگشت‌ها و فاکتورهای ابطالی',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'portrait',
      kpis: [
        { label: 'مالیات خالص فروش (۳۰۳۰۱)', value: formatMoney(vatSummary.netSalesTax, unit) },
        { label: 'اعتبار خالص خرید (۳۰۳۰۲)', value: formatMoney(vatSummary.netPurchaseTax, unit) },
        {
          label: vatSummary.netPayableVat >= 0 ? 'خالص مالیات قابل پرداخت' : 'اضافه‌پرداختی / اعتبار',
          value: formatMoney(Math.abs(vatSummary.netPayableVat), unit),
          tone: vatSummary.netPayableVat >= 0 ? 'negative' : 'positive',
        },
      ],
      columns: [
        { key: 'title', label: 'شرح ردیف اظهارنامه ارزش افزوده', align: 'right', defaultVisible: true, essential: true },
        { key: 'glCode', label: 'سرفصل معین', isCode: true, align: 'center', defaultVisible: true },
        { key: 'taxBase', label: 'مبلغ مأخذ مشمول', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'vatAmount', label: 'مالیات ارزش افزوده (۱۰٪)', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'reconciled', label: 'تطابق دفتر کل', align: 'center', defaultVisible: true },
      ],
      rows: [
        {
          id: 'sales_gross',
          cells: {
            title: 'فروش ناخالص کالا و خدمات مشمول',
            glCode: '۳۰۳۰۱',
            taxBase: fmtNum(vatSummary.grossSalesNet, unit, false),
            vatAmount: fmtNum(vatSummary.grossSalesTax, unit, false),
            reconciled: '—',
          },
        },
        {
          id: 'sales_return',
          highlight: 'negative',
          cells: {
            title: 'کسر می‌شود: برگشت از فروش مشمول',
            glCode: '۳۰۳۰۱',
            taxBase: `(${fmtNum(vatSummary.saleReturnNet, unit, false)})`,
            vatAmount: `(${fmtNum(vatSummary.saleReturnTax, unit, false)})`,
            reconciled: '—',
          },
        },
        {
          id: 'sales_net',
          rowType: 'subtotal',
          cells: {
            title: 'جمع خالص فروش و مالیات فروش دوره',
            glCode: '۳۰۳۰۱',
            taxBase: fmtNum(vatSummary.netSalesBase, unit, false),
            vatAmount: fmtNum(vatSummary.netSalesTax, unit, false),
            reconciled: vatSalesMatchesGl ? 'مطابق' : 'مغایرت',
          },
        },
        {
          id: 'purchase_gross',
          cells: {
            title: 'خرید ناخالص کالا و خدمات مشمول',
            glCode: '۳۰۳۰۲',
            taxBase: fmtNum(vatSummary.grossPurchaseNet, unit, false),
            vatAmount: fmtNum(vatSummary.grossPurchaseTax, unit, false),
            reconciled: '—',
          },
        },
        {
          id: 'purchase_return',
          highlight: 'negative',
          cells: {
            title: 'کسر می‌شود: برگشت از خرید مشمول',
            glCode: '۳۰۳۰۲',
            taxBase: `(${fmtNum(vatSummary.purchaseReturnNet, unit, false)})`,
            vatAmount: `(${fmtNum(vatSummary.purchaseReturnTax, unit, false)})`,
            reconciled: '—',
          },
        },
        {
          id: 'purchase_net',
          rowType: 'subtotal',
          cells: {
            title: 'جمع خالص خرید و اعتبار مالیاتی خرید دوره',
            glCode: '۳۰۳۰۲',
            taxBase: fmtNum(vatSummary.netPurchaseBase, unit, false),
            vatAmount: fmtNum(vatSummary.netPurchaseTax, unit, false),
            reconciled: vatPurchaseMatchesGl ? 'مطابق' : 'مغایرت',
          },
        },
        {
          id: 'vat_payable',
          rowType: 'total',
          highlight: vatSummary.netPayableVat >= 0 ? 'accent' : 'positive',
          cells: {
            title:
              vatSummary.netPayableVat >= 0
                ? 'خالص مالیات بر ارزش افزوده قابل پرداخت به سازمان امور مالیاتی'
                : 'خالص اضافه‌پرداختی / اعتبار مالیاتی قابل انتقال به دوره بعد',
            glCode: '۳۰۳۰۱ / ۳۰۳۰۲',
            taxBase: '—',
            vatAmount: fmtSignedMoney(vatSummary.netPayableVat, unit),
            reconciled: vatSalesMatchesGl && vatPurchaseMatchesGl ? 'تاییدشده' : 'نیاز به بررسی',
          },
        },
      ],
    };
  }

  if (tab === 'seasonal-169') {
    const totals = seasonal169Rows.reduce(
      (s, r) => ({
        count: s.count + r.invoiceCount,
        sNet: s.sNet + r.salesNet,
        sVat: s.sVat + r.salesVat,
        pNet: s.pNet + r.purchasesNet,
        pVat: s.pVat + r.purchasesVat,
      }),
      { count: 0, sNet: 0, sVat: 0, pNet: 0, pVat: 0 }
    );
    return {
      reportId: 'seasonal-169',
      fileNamePrefix: 'holoo-seasonal-169',
      title: 'گزارش صورت معاملات فصلی (ماده ۱۶۹ مکرر قانون مالیات‌های مستقیم)',
      subtitle: 'تجمیع معاملات خرید و فروش به تفکیک طرف‌حساب، شناسه ملی و کد اقتصادی',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'partyCode', label: 'کد طرف‌حساب', isCode: true, defaultVisible: true },
        { key: 'partyName', label: 'نام شخص / شرکت', align: 'right', defaultVisible: true, essential: true },
        { key: 'nationalId', label: 'شناسه / کد ملی', isCode: true, defaultVisible: true, essential: true },
        { key: 'economicCode', label: 'کد اقتصادی', isCode: true, defaultVisible: true },
        { key: 'invoiceCount', label: 'تعداد فاکتور', align: 'center', isCode: true, defaultVisible: true },
        { key: 'salesNet', label: 'فروش خالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'salesVat', label: 'مالیات فروش', isNumeric: true, defaultVisible: true },
        { key: 'purchasesNet', label: 'خرید خالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'purchasesVat', label: 'مالیات خرید', isNumeric: true, defaultVisible: true },
      ],
      rows: seasonal169Rows.map((r) => ({
        id: r.partyId,
        cells: {
          partyCode: toPersianDigits(r.partyCode),
          partyName: r.partyName,
          nationalId: r.nationalId ? toPersianDigits(r.nationalId) : '—',
          economicCode: r.economicCode ? toPersianDigits(r.economicCode) : '—',
          invoiceCount: toPersianDigits(r.invoiceCount),
          salesNet: fmtNum(r.salesNet, unit),
          salesVat: fmtNum(r.salesVat, unit),
          purchasesNet: fmtNum(r.purchasesNet, unit),
          purchasesVat: fmtNum(r.purchasesVat, unit),
        },
      })),
      footerLabel: 'جمع کل معاملات فصلی',
      footerTotals: {
        invoiceCount: toPersianDigits(totals.count),
        salesNet: fmtNum(totals.sNet, unit, false),
        salesVat: fmtNum(totals.sVat, unit, false),
        purchasesNet: fmtNum(totals.pNet, unit, false),
        purchasesVat: fmtNum(totals.pVat, unit, false),
      },
    };
  }

  if (tab === 'product-profit') {
    if (profitMode === 'invoice') {
      const totSales = invoiceProfitability.reduce((s, r) => s + r.netSales, 0);
      const totCogs = invoiceProfitability.reduce((s, r) => s + r.cogs, 0);
      const totGross = invoiceProfitability.reduce((s, r) => s + r.grossProfit, 0);
      const avgMargin = totSales > 0 ? (totGross / totSales) * 100 : 0;
      return {
        reportId: 'profit-invoice',
        fileNamePrefix: 'holoo-invoice-profitability',
        title: 'گزارش سود و زیان ناخالص به تفکیک فاکتورهای فروش',
        subtitle: 'مقایسه فروش خالص هر فاکتور با بهای تمام‌شده و حاشیه سود واقعی',
        periodLabel,
        voucherScopeLabel,
        currencyUnit: unit,
        recommendedOrientation: 'landscape',
        columns: [
          { key: 'invoiceNumber', label: 'شماره فاکتور', isCode: true, defaultVisible: true, essential: true },
          { key: 'date', label: 'تاریخ', isCode: true, align: 'center', defaultVisible: true },
          { key: 'partyName', label: 'مشتری / خریدار', align: 'right', defaultVisible: true, essential: true },
          { key: 'netSales', label: 'فروش خالص', isNumeric: true, defaultVisible: true, essential: true },
          { key: 'cogs', label: 'بهای تمام‌شده', isNumeric: true, defaultVisible: true },
          { key: 'grossProfit', label: 'سود ناخالص', isNumeric: true, defaultVisible: true, essential: true },
          { key: 'marginPct', label: 'حاشیه سود', align: 'center', isCode: true, defaultVisible: true },
        ],
        rows: invoiceProfitability.map((r) => ({
          id: r.invoiceId,
          highlight: r.grossProfit >= 0 ? 'positive' : 'negative',
          cells: {
            invoiceNumber: r.invoiceNumber,
            date: toPersianDigits(r.date),
            partyName: r.partyName,
            netSales: fmtNum(r.netSales, unit, false),
            cogs: fmtNum(r.cogs, unit, false),
            grossProfit: fmtSignedMoney(r.grossProfit, unit),
            marginPct: `${toPersianDigits(r.marginPct.toFixed(1))}٪`,
          },
        })),
        footerLabel: `جمع کل (${toPersianDigits(invoiceProfitability.length)} فاکتور)`,
        footerTotals: {
          netSales: fmtNum(totSales, unit, false),
          cogs: fmtNum(totCogs, unit, false),
          grossProfit: fmtSignedMoney(totGross, unit),
          marginPct: `${toPersianDigits(avgMargin.toFixed(1))}٪`,
        },
      };
    }

    const totSales = productProfitability.reduce((s, r) => s + r.netSalesRevenue, 0);
    const totCogs = productProfitability.reduce((s, r) => s + r.estimatedCogs, 0);
    const totGross = productProfitability.reduce((s, r) => s + r.grossProfit, 0);
    const avgMargin = totSales > 0 ? (totGross / totSales) * 100 : 0;
    return {
      reportId: 'profit-product',
      fileNamePrefix: 'holoo-product-profitability',
      title: 'گزارش سود ناخالص و گردش فروش به تفکیک کالا',
      subtitle: 'محاسبه مقدار فروش خالص، برگشت از فروش، بهای تمام‌شده و حاشیه سود هر کالا',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'sku', label: 'کد کالا', isCode: true, defaultVisible: true, essential: true },
        { key: 'productName', label: 'نام کالا', align: 'right', defaultVisible: true, essential: true },
        { key: 'soldQty', label: 'فروش (مقدار)', isNumeric: true, defaultVisible: true },
        { key: 'returnedQty', label: 'برگشتی', isNumeric: true, defaultVisible: true },
        { key: 'netQty', label: 'خالص مقدار', isNumeric: true, defaultVisible: true },
        { key: 'netSales', label: 'فروش خالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'cogs', label: 'بهای تمام‌شده', isNumeric: true, defaultVisible: true },
        { key: 'grossProfit', label: 'سود ناخالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'marginPct', label: 'حاشیه سود', align: 'center', isCode: true, defaultVisible: true },
      ],
      rows: productProfitability.map((r) => ({
        id: r.productId,
        highlight: r.grossProfit >= 0 ? 'positive' : 'negative',
        cells: {
          sku: r.sku,
          productName: r.productName,
          soldQty: toPersianDigits(r.soldQty.toLocaleString('en-US')),
          returnedQty: toPersianDigits(r.returnedQty.toLocaleString('en-US')),
          netQty: toPersianDigits(r.netQty.toLocaleString('en-US')),
          netSales: fmtNum(r.netSalesRevenue, unit, false),
          cogs: fmtNum(r.estimatedCogs, unit, false),
          grossProfit: fmtSignedMoney(r.grossProfit, unit),
          marginPct: `${toPersianDigits(r.marginPct.toFixed(1))}٪`,
        },
      })),
      footerLabel: 'جمع کل سود ناخالص کالاها',
      footerTotals: {
        netSales: fmtNum(totSales, unit, false),
        cogs: fmtNum(totCogs, unit, false),
        grossProfit: fmtSignedMoney(totGross, unit),
        marginPct: `${toPersianDigits(avgMargin.toFixed(1))}٪`,
      },
    };
  }

  if (tab === 'abc') {
    const totRev = abcReport.products.reduce((s, r) => s + r.revenueIrr, 0);
    const totProfit = abcReport.products.reduce((s, r) => s + r.grossProfitIrr, 0);
    const totKg = abcReport.products.reduce((s, r) => s + r.soldKg, 0);
    return {
      reportId: 'abc',
      fileNamePrefix: 'holoo-abc-intelligence',
      title: 'گزارش تحلیل هوشمند پارتو (ABC) کالاها و گردش موجودی',
      subtitle: 'طبقه‌بندی کالاها بر اساس سهم فروش، حاشیه سود و شناسایی اقلام راکد',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'sku', label: 'کد کالا', isCode: true, defaultVisible: true, essential: true },
        { key: 'name', label: 'نام کالا', align: 'right', defaultVisible: true, essential: true },
        { key: 'soldKg', label: 'وزن فروش', align: 'left', isCode: true, defaultVisible: true },
        { key: 'revenue', label: 'فروش خالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'grossProfit', label: 'سود ناخالص', isNumeric: true, defaultVisible: true },
        { key: 'marginPct', label: 'حاشیه سود', align: 'center', isCode: true, defaultVisible: true },
        { key: 'sharePct', label: 'سهم از فروش', align: 'center', isCode: true, defaultVisible: true },
        { key: 'grade', label: 'رده ABC', align: 'center', defaultVisible: true, essential: true },
        { key: 'status', label: 'وضعیت گردش', align: 'center', defaultVisible: true },
      ],
      rows: abcReport.products.map((r) => ({
        id: r.productId,
        highlight: r.isStagnant ? 'negative' : r.grade === 'A' ? 'positive' : undefined,
        cells: {
          sku: r.sku,
          name: r.name,
          soldKg: formatWeight(r.soldKg),
          revenue: fmtNum(r.revenueIrr, unit, false),
          grossProfit: fmtSignedMoney(r.grossProfitIrr, unit),
          marginPct: `${toPersianDigits(r.marginPct.toFixed(1))}٪`,
          sharePct: `${toPersianDigits(r.revenueSharePct.toFixed(1))}٪`,
          grade: `رده ${r.grade}`,
          status: r.isStagnant ? 'راکد' : 'پویا',
        },
      })),
      footerLabel: 'جمع کل تحلیل ABC',
      footerTotals: {
        soldKg: formatWeight(totKg),
        revenue: fmtNum(totRev, unit, false),
        grossProfit: fmtSignedMoney(totProfit, unit),
      },
    };
  }

  if (tab === 'aging') {
    const totals = agingRows.reduce(
      (s, r) => ({
        b30: s.b30 + r.bucket0to30,
        b60: s.b60 + r.bucket31to60,
        b90: s.b90 + r.bucket61to90,
        bOver: s.bOver + r.bucketOver90,
        total: s.total + r.totalReceivable,
      }),
      { b30: 0, b60: 0, b90: 0, bOver: 0, total: 0 }
    );
    return {
      reportId: 'aging',
      fileNamePrefix: 'holoo-receivables-aging',
      title: 'گزارش سنی مطالبات مشتریان (Aging Report)',
      subtitle: `طبقه‌بندی مطالبات باز بر مبنای تاریخ ${toPersianDigits(getTodayShamsi())}`,
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'partyCode', label: 'کد مشتری', isCode: true, defaultVisible: true },
        { key: 'partyName', label: 'نام مشتری', align: 'right', defaultVisible: true, essential: true },
        { key: 'oldestDate', label: 'قدیمی‌ترین فاکتور', isCode: true, align: 'center', defaultVisible: true },
        { key: 'b30', label: '۰ تا ۳۰ روز', isNumeric: true, defaultVisible: true },
        { key: 'b60', label: '۳۱ تا ۶۰ روز', isNumeric: true, defaultVisible: true },
        { key: 'b90', label: '۶۱ تا ۹۰ روز', isNumeric: true, defaultVisible: true },
        { key: 'bOver', label: 'بالای ۹۰ روز (معوق)', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'total', label: 'جمع بدهی باز', isNumeric: true, defaultVisible: true, essential: true },
      ],
      rows: agingRows.map((r) => ({
        id: r.partyId,
        highlight: r.bucketOver90 > 0 ? 'negative' : undefined,
        cells: {
          partyCode: toPersianDigits(r.partyCode),
          partyName: r.partyName,
          oldestDate: r.oldestInvoiceDate ? toPersianDigits(r.oldestInvoiceDate) : 'مانده اول دوره',
          b30: fmtNum(r.bucket0to30, unit),
          b60: fmtNum(r.bucket31to60, unit),
          b90: fmtNum(r.bucket61to90, unit),
          bOver: fmtNum(r.bucketOver90, unit),
          total: fmtNum(r.totalReceivable, unit, false),
        },
      })),
      footerLabel: 'جمع کل مطالبات باز',
      footerTotals: {
        b30: fmtNum(totals.b30, unit, false),
        b60: fmtNum(totals.b60, unit, false),
        b90: fmtNum(totals.b90, unit, false),
        bOver: fmtNum(totals.bOver, unit, false),
        total: fmtNum(totals.total, unit, false),
      },
    };
  }

  if (tab === 'commissions') {
    const totInv = commissionRows.reduce((s, r) => s + r.invoiceCount, 0);
    const totKg = commissionRows.reduce((s, r) => s + r.totalWeightKg, 0);
    const totSales = commissionRows.reduce((s, r) => s + r.totalSalesIrr, 0);
    const totComm = commissionRows.reduce((s, r) => s + r.commissionAmountIrr, 0);
    return {
      reportId: 'commissions',
      fileNamePrefix: 'holoo-broker-commissions',
      title: 'گزارش محاسبه پورسانت بازاریابان و واسطه‌های فروش',
      subtitle: 'تجمیع فاکتورهای منتسب به واسطه‌ها و مبلغ قابل ثبت در هزینه پورسانت (۸۰۳۰۱)',
      periodLabel,
      voucherScopeLabel,
      currencyUnit: unit,
      recommendedOrientation: 'landscape',
      columns: [
        { key: 'partyCode', label: 'کد واسطه', isCode: true, defaultVisible: true },
        { key: 'partyName', label: 'نام بازاریاب / واسطه', align: 'right', defaultVisible: true, essential: true },
        { key: 'rate', label: 'نرخ پورسانت', align: 'center', isCode: true, defaultVisible: true, essential: true },
        { key: 'invoiceCount', label: 'تعداد فاکتور', align: 'center', isCode: true, defaultVisible: true },
        { key: 'weightKg', label: 'جمع وزن (کیلو)', isNumeric: true, defaultVisible: true },
        { key: 'salesIrr', label: 'فروش خالص', isNumeric: true, defaultVisible: true, essential: true },
        { key: 'commissionIrr', label: 'پورسانت قابل پرداخت', isNumeric: true, defaultVisible: true, essential: true },
      ],
      rows: commissionRows.map((r) => ({
        id: r.partyId,
        highlight: r.commissionAmountIrr > 0 ? 'accent' : undefined,
        cells: {
          partyCode: toPersianDigits(r.partyCode),
          partyName: r.partyName,
          rate: `${toPersianDigits(r.commissionRate)}٪`,
          invoiceCount: toPersianDigits(r.invoiceCount),
          weightKg: toPersianDigits(r.totalWeightKg.toLocaleString('en-US')),
          salesIrr: fmtNum(r.totalSalesIrr, unit, false),
          commissionIrr: fmtNum(r.commissionAmountIrr, unit, false),
        },
      })),
      footerLabel: 'جمع کل پورسانت‌ها',
      footerTotals: {
        invoiceCount: toPersianDigits(totInv),
        weightKg: toPersianDigits(totKg.toLocaleString('en-US')),
        salesIrr: fmtNum(totSales, unit, false),
        commissionIrr: fmtNum(totComm, unit, false),
      },
    };
  }

  // Statutory tab: active employees payroll base summary
  const activeEmployees = employees.filter((e) => e.active);
  const totBase = activeEmployees.reduce((s, e) => s + e.baseSalary, 0);
  const totHousing = activeEmployees.reduce((s, e) => s + e.housingAllowance, 0);
  const totFood = activeEmployees.reduce((s, e) => s + e.foodAllowance, 0);
  const totGross = totBase + totHousing + totFood;
  return {
    reportId: 'statutory',
    fileNamePrefix: 'holoo-statutory-payroll-summary',
    title: `خلاصه لیست پرسنل مشمول بیمه و مالیات — ${statutoryMonth}`,
    subtitle: 'مبنای تولید فایل‌های دیسکت بیمه تأمین اجتماعی (DSK) و مالیات حقوق (TTMS)',
    periodLabel: statutoryMonth || periodLabel,
    voucherScopeLabel,
    currencyUnit: unit,
    recommendedOrientation: 'landscape',
    columns: [
      { key: 'code', label: 'کد پرسنلی', isCode: true, defaultVisible: true, essential: true },
      { key: 'fullName', label: 'نام و نام خانوادگی', align: 'right', defaultVisible: true, essential: true },
      { key: 'department', label: 'واحد / دپارتمان', align: 'right', defaultVisible: true },
      { key: 'baseSalary', label: 'حقوق پایه', isNumeric: true, defaultVisible: true, essential: true },
      { key: 'housing', label: 'حق مسکن', isNumeric: true, defaultVisible: true },
      { key: 'food', label: 'بن خواربار', isNumeric: true, defaultVisible: true },
      { key: 'overtime', label: 'ساعات اضافه‌کاری', align: 'center', isCode: true, defaultVisible: true },
      { key: 'grossFixed', label: 'جمع حقوق و مزایای ثابت', isNumeric: true, defaultVisible: true, essential: true },
    ],
    rows: activeEmployees.map((e) => ({
      id: e.id,
      cells: {
        code: toPersianDigits(e.personnelCode),
        fullName: e.fullName,
        department: e.department,
        baseSalary: fmtNum(e.baseSalary, unit, false),
        housing: fmtNum(e.housingAllowance, unit, false),
        food: fmtNum(e.foodAllowance, unit, false),
        overtime: toPersianDigits(e.overtimeHours),
        grossFixed: fmtNum(e.baseSalary + e.housingAllowance + e.foodAllowance, unit, false),
      },
    })),
    footerLabel: `جمع کل (${toPersianDigits(activeEmployees.length)} پرسنل فعال)`,
    footerTotals: {
      baseSalary: fmtNum(totBase, unit, false),
      housing: fmtNum(totHousing, unit, false),
      food: fmtNum(totFood, unit, false),
      grossFixed: fmtNum(totGross, unit, false),
    },
  };
}
