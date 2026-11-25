import {
  Account,
  Cheque,
  ConsumedCostLayerAllocation,
  CostCenter,
  Employee,
  FixedAsset,
  InventoryCostingMethod,
  InventoryCostLayer,
  Invoice,
  IranFiscalYearStatutoryParams,
  Party,
  Product,
  TrialBalanceRow,
  Voucher,
  VoucherLine,
} from '../types/accounting';
import {
  applyInventoryMovementStep,
  normalizeProductCostState,
  roundQty,
} from './inventoryCostingEngine';
import {
  calculateIranMonthlyPayrollTax,
  getStatutoryParamsForYear,
} from './iranStatutoryParams';

export interface LedgerFilterOptions {
  /** Official reports default to false (excludes draft vouchers). Pass true to preview drafts. */
  includeDrafts?: boolean;
  /** Optional Shamsi fiscal year (e.g. "1405") to isolate vouchers strictly to that fiscal period. */
  fiscalYear?: string;
  /** Exclude year-end closing vouchers (used for Income Statement calculation). */
  excludeClosing?: boolean;
}

/**
 * Filters vouchers for financial reporting:
 * 1. Excludes draft (`status === 'draft'`) vouchers by default so official reports only reflect permanent postings.
 * 2. Isolates a specific fiscal period (`YYYY/`) when `fiscalYear` is provided.
 * 3. Optionally excludes year-end closing vouchers.
 */
export function filterVouchersForReport(
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): Voucher[] {
  const includeDrafts = options?.includeDrafts === true;
  const excludeClosing = options?.excludeClosing === true;
  const fyPrefix = options?.fiscalYear ? `${String(options.fiscalYear).trim()}/` : '';

  return vouchers.filter((v) => {
    if (!includeDrafts && v.status === 'draft') return false;
    if (excludeClosing && v.voucherType === 'closing') return false;
    if (fyPrefix && typeof v.date === 'string' && v.date.length >= 5) {
      if (!v.date.startsWith(fyPrefix)) return false;
    }
    return true;
  });
}

export function computeTrialBalance(
  accounts: Account[],
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): TrialBalanceRow[] {
  const accountMap = new Map<string, Account>();
  accounts.forEach((a) => accountMap.set(a.code, a));

  const totals = new Map<
    string,
    { openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number }
  >();

  const scopedVouchers = filterVouchersForReport(vouchers, options);

  for (const v of scopedVouchers) {
    const isOpening = v.voucherType === 'opening';
    for (const line of v.lines) {
      const prev = totals.get(line.accountCode) ?? {
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 0,
        periodCredit: 0,
      };
      const d = Number.isFinite(Number(line.debit)) ? Math.max(0, Math.round(Number(line.debit))) : 0;
      const c = Number.isFinite(Number(line.credit)) ? Math.max(0, Math.round(Number(line.credit))) : 0;
      if (isOpening) {
        prev.openingDebit += d;
        prev.openingCredit += c;
      } else {
        prev.periodDebit += d;
        prev.periodCredit += c;
      }
      totals.set(line.accountCode, prev);
    }
  }

  const rows: TrialBalanceRow[] = [];
  totals.forEach((vals, code) => {
    const acc = accountMap.get(code);
    const totalDebit = vals.openingDebit + vals.periodDebit;
    const totalCredit = vals.openingCredit + vals.periodCredit;
    const diff = totalDebit - totalCredit;
    rows.push({
      accountCode: code,
      accountTitle: acc?.title ?? `حساب ${code}`,
      category: acc?.category ?? 'asset',
      openingDebit: vals.openingDebit,
      openingCredit: vals.openingCredit,
      periodDebit: vals.periodDebit,
      periodCredit: vals.periodCredit,
      totalDebit,
      totalCredit,
      balanceDebit: diff > 0 ? diff : 0,
      balanceCredit: diff < 0 ? Math.abs(diff) : 0,
    });
  });

  return rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

export interface IncomeStatementSummary {
  grossSales: number;
  salesReturns: number;
  otherRevenue: number;
  fxGain: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  nonOperatingExpenses: number;
  operatingProfit: number;
  netProfit: number;
  grossMarginPct: number;
  netMarginPct: number;
  expenseRows: { code: string; title: string; amount: number }[];
}

export function computeIncomeStatement(trialRows: TrialBalanceRow[]): IncomeStatementSummary {
  let grossSales = 0;
  let salesReturns = 0;
  let otherRevenue = 0;
  let fxGain = 0;
  let cogs = 0;
  let operatingExpenses = 0;
  let nonOperatingExpenses = 0;
  const expenseRows: { code: string; title: string; amount: number }[] = [];

  for (const row of trialRows) {
    const netCredit = row.balanceCredit - row.balanceDebit;
    const netDebit = row.balanceDebit - row.balanceCredit;
    if (row.category === 'revenue') {
      if (row.accountCode.startsWith('602')) {
        salesReturns += netDebit;
      } else if (row.accountCode.startsWith('609')) {
        fxGain += netCredit;
        otherRevenue += netCredit;
      } else if (row.accountCode.startsWith('603')) {
        otherRevenue += netCredit;
      } else {
        grossSales += netCredit;
      }
    } else if (row.category === 'cogs') {
      cogs += netDebit;
    } else if (row.category === 'expense') {
      if (row.accountCode.startsWith('809')) {
        nonOperatingExpenses += netDebit;
      } else {
        operatingExpenses += netDebit;
      }
      if (netDebit !== 0) {
        expenseRows.push({ code: row.accountCode, title: row.accountTitle, amount: netDebit });
      }
    }
  }

  const netSales = grossSales - salesReturns;
  const grossProfit = netSales - cogs;
  const operatingProfit = grossProfit - operatingExpenses;
  const netProfit = operatingProfit + otherRevenue - nonOperatingExpenses;
  const grossMarginPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
  const netMarginPct = netSales > 0 ? (netProfit / netSales) * 100 : 0;

  return {
    grossSales,
    salesReturns,
    otherRevenue,
    fxGain,
    netSales,
    cogs,
    grossProfit,
    operatingExpenses,
    nonOperatingExpenses,
    operatingProfit,
    netProfit,
    grossMarginPct,
    netMarginPct,
    expenseRows,
  };
}

export interface BalanceSheetSummary {
  assets: { code: string; title: string; amount: number }[];
  liabilities: { code: string; title: string; amount: number }[];
  equity: { code: string; title: string; amount: number }[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentPeriodProfit: number;
  difference: number;
  isBalanced: boolean;
}

export function computeBalanceSheet(trialRows: TrialBalanceRow[]): BalanceSheetSummary {
  // Compute unclosed current-period net profit directly from the provided trial balance
  // (after year-end closing, temporary accounts are zeroed and profit is already inside 50201, so no double-counting)
  const income = computeIncomeStatement(trialRows);
  const assets: { code: string; title: string; amount: number }[] = [];
  const liabilities: { code: string; title: string; amount: number }[] = [];
  const equity: { code: string; title: string; amount: number }[] = [];

  for (const row of trialRows) {
    const netDebit = row.balanceDebit - row.balanceCredit;
    const netCredit = row.balanceCredit - row.balanceDebit;
    if (row.category === 'asset' && netDebit !== 0) {
      assets.push({ code: row.accountCode, title: row.accountTitle, amount: netDebit });
    } else if (row.category === 'liability' && netCredit !== 0) {
      // Reclassify debit-balance VAT input credit (30302) as a Current Asset under Iranian accounting standards
      if (row.accountCode === '30302' && netDebit > 0) {
        assets.push({
          code: row.accountCode,
          title: `${row.accountTitle} (اعتبار قابل استرداد)`,
          amount: netDebit,
        });
      } else {
        liabilities.push({ code: row.accountCode, title: row.accountTitle, amount: netCredit });
      }
    } else if (row.category === 'equity' && netCredit !== 0) {
      equity.push({ code: row.accountCode, title: row.accountTitle, amount: netCredit });
    }
  }

  if (income.netProfit !== 0) {
    equity.push({
      code: '90101',
      title: 'سود (زیان) خالص دوره جاری',
      amount: income.netProfit,
    });
  }

  const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalEquity = equity.reduce((s, e) => s + e.amount, 0);
  const difference = totalAssets - (totalLiabilities + totalEquity);

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentPeriodProfit: income.netProfit,
    difference,
    isBalanced: Math.abs(difference) < 1,
  };
}

/**
 * Computes exact open account balances for each Party (excluding cheque instruments 103* and 302*
 * so that Party Subsidiary Ledgers reconcile 100% with General Ledger 10401 and 30101).
 */
export function computePartyBalances(
  parties: Party[],
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const p of parties) {
    balances.set(p.id, 0);
  }
  const scopedVouchers = filterVouchersForReport(vouchers, options);
  for (const v of scopedVouchers) {
    for (const line of v.lines) {
      if (!line.partyId || !balances.has(line.partyId)) continue;
      // Exclude cheque tracking accounts (اسناد دریافتنی/پرداختنی) from open party AR/AP balance
      if (line.accountCode.startsWith('103') || line.accountCode.startsWith('302')) continue;
      const cur = balances.get(line.partyId) ?? 0;
      balances.set(line.partyId, cur + (Number(line.debit) || 0) - (Number(line.credit) || 0));
    }
  }
  return balances;
}

export interface LedgerEntry {
  voucherId: string;
  voucherNumber: number;
  date: string;
  accountCode: string;
  accountTitle: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
  partyName?: string;
}

export function computeAccountLedger(
  accountCode: string,
  vouchers: Voucher[],
  fromDate?: string,
  toDate?: string,
  options?: LedgerFilterOptions
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let running = 0;
  const scoped = filterVouchersForReport(vouchers, options);
  const sorted = [...scoped].sort((a, b) => a.voucherNumber - b.voucherNumber);
  for (const v of sorted) {
    if (toDate && v.date > toDate) continue;
    for (const line of v.lines) {
      if (line.accountCode === accountCode || line.accountCode.startsWith(accountCode)) {
        const d = Number(line.debit) || 0;
        const c = Number(line.credit) || 0;
        running += d - c;
        if (fromDate && v.date < fromDate) continue;
        entries.push({
          voucherId: v.id,
          voucherNumber: v.voucherNumber,
          date: v.date,
          accountCode: line.accountCode,
          accountTitle: line.accountTitle,
          description: line.description || v.description,
          debit: d,
          credit: c,
          runningBalance: running,
          partyName: line.partyName,
        });
      }
    }
  }
  return entries;
}

export function computePartyLedger(
  partyId: string,
  vouchers: Voucher[],
  includeCheques = false,
  fromDate?: string,
  toDate?: string,
  options?: LedgerFilterOptions
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let running = 0;
  const scoped = filterVouchersForReport(vouchers, options);
  const sorted = [...scoped].sort((a, b) => a.voucherNumber - b.voucherNumber);
  for (const v of sorted) {
    if (toDate && v.date > toDate) continue;
    for (const line of v.lines) {
      if (line.partyId !== partyId) continue;
      const isChequeAcc = line.accountCode.startsWith('103') || line.accountCode.startsWith('302');
      if (!includeCheques && isChequeAcc) continue;
      const d = Number(line.debit) || 0;
      const c = Number(line.credit) || 0;
      running += d - c;
      if (fromDate && v.date < fromDate) continue;
      entries.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        accountCode: line.accountCode,
        accountTitle: line.accountTitle,
        description: line.description || v.description,
        debit: d,
        credit: c,
        runningBalance: running,
        partyName: line.partyName,
      });
    }
  }
  return entries;
}

export interface ProductProfitabilityRow {
  productId: string;
  sku: string;
  productName: string;
  soldQty: number;
  returnedQty: number;
  netQty: number;
  netSalesRevenue: number;
  estimatedCogs: number;
  grossProfit: number;
  marginPct: number;
}

export function computeProductProfitability(
  invoices: Invoice[],
  products: Product[],
  fiscalYear?: string
): ProductProfitabilityRow[] {
  const productMap = new Map<string, Product>();
  products.forEach((p) => productMap.set(p.id, p));
  const fyPrefix = fiscalYear ? `${String(fiscalYear).trim()}/` : '';

  const acc = new Map<string, ProductProfitabilityRow>();

  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    if (inv.invoiceType !== 'sale' && inv.invoiceType !== 'sale_return') continue;
    if (fyPrefix && typeof inv.date === 'string' && !inv.date.startsWith(fyPrefix)) continue;
    const isReturn = inv.invoiceType === 'sale_return';

    for (const item of inv.items) {
      const prod = productMap.get(item.productId);
      const buyPrice = item.unitCostSnapshot !== undefined ? item.unitCostSnapshot : (prod?.buyPrice ?? 0);
      const netLineRev = Math.round(item.quantity * item.unitPrice) - item.discount;
      const lineCogs =
        item.totalCostIrr !== undefined && Number.isFinite(item.totalCostIrr)
          ? Math.round(item.totalCostIrr)
          : Math.round(item.quantity * buyPrice);

      const row = acc.get(item.productId) ?? {
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        soldQty: 0,
        returnedQty: 0,
        netQty: 0,
        netSalesRevenue: 0,
        estimatedCogs: 0,
        grossProfit: 0,
        marginPct: 0,
      };

      if (isReturn) {
        row.returnedQty += item.quantity;
        row.netQty -= item.quantity;
        row.netSalesRevenue -= netLineRev;
        row.estimatedCogs -= lineCogs;
      } else {
        row.soldQty += item.quantity;
        row.netQty += item.quantity;
        row.netSalesRevenue += netLineRev;
        row.estimatedCogs += lineCogs;
      }

      row.grossProfit = row.netSalesRevenue - row.estimatedCogs;
      row.marginPct = row.netSalesRevenue > 0 ? (row.grossProfit / row.netSalesRevenue) * 100 : 0;
      acc.set(item.productId, row);
    }
  }

  return Array.from(acc.values()).sort((a, b) => b.grossProfit - a.grossProfit);
}

export interface CostCenterPnLRow {
  costCenter: CostCenter;
  revenue: number;
  cogs: number;
  expenses: number;
  netResult: number;
  budgetUsagePct: number;
}

export function computeCostCenterPnL(
  costCenters: CostCenter[],
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): CostCenterPnLRow[] {
  const stats = new Map<string, { revenue: number; cogs: number; expenses: number }>();
  costCenters.forEach((cc) => stats.set(cc.id, { revenue: 0, cogs: 0, expenses: 0 }));

  const scopedVouchers = filterVouchersForReport(vouchers, options);
  for (const v of scopedVouchers) {
    for (const l of v.lines) {
      if (!l.costCenterId || !stats.has(l.costCenterId)) continue;
      const s = stats.get(l.costCenterId)!;
      if (l.accountCode.startsWith('6')) {
        s.revenue += (Number(l.credit) || 0) - (Number(l.debit) || 0);
      } else if (l.accountCode.startsWith('7')) {
        s.cogs += (Number(l.debit) || 0) - (Number(l.credit) || 0);
      } else if (l.accountCode.startsWith('8')) {
        s.expenses += (Number(l.debit) || 0) - (Number(l.credit) || 0);
      }
    }
  }

  return costCenters.map((cc) => {
    const s = stats.get(cc.id)!;
    const totalCost = s.cogs + s.expenses;
    return {
      costCenter: cc,
      revenue: s.revenue,
      cogs: s.cogs,
      expenses: s.expenses,
      netResult: s.revenue - totalCost,
      budgetUsagePct: cc.budget > 0 ? Math.round((totalCost / cc.budget) * 100) : 0,
    };
  });
}

export type AuditSeverity = 'pass' | 'warning' | 'error';

export interface AuditCheckItem {
  id: string;
  title: string;
  category: string;
  status: AuditSeverity;
  /** Structured severity label for reporting ('critical' | 'warning' | 'info') */
  severity?: 'critical' | 'warning' | 'info';
  summary: string;
  details: string[];
  probableCause?: string;
  relatedRefs?: string[];
  discrepancyAmount?: number;
  suggestedFix?: string;
  targetModule: 'vouchers' | 'reports' | 'parties' | 'inventory' | 'treasury' | 'invoices';
}

export interface AuditReport {
  score: number;
  passedCount: number;
  warningCount: number;
  errorCount: number;
  checks: AuditCheckItem[];
  reconciliation: {
    glReceivables: number;
    subReceivables: number;
    glPayables: number;
    subPayables: number;
    glSalesVat: number;
    invSalesVat: number;
    glPurchaseVat: number;
    invPurchaseVat: number;
    glInventory: number;
    subInventory: number;
    glChequesReceivableBox: number;
    subChequesReceivableBox: number;
    glChequesReceivableBank: number;
    subChequesReceivableBank: number;
    glChequesPayable: number;
    subChequesPayable: number;
    glCogs: number;
    invCogs: number;
  };
}

export function computeAuditReport(input: {
  accounts: Account[];
  vouchers: Voucher[];
  invoices: Invoice[];
  parties: Party[];
  products: Product[];
  cheques: Cheque[];
  trialBalance: TrialBalanceRow[];
  balanceSheet: BalanceSheetSummary;
  partyBalances: Map<string, number>;
  fiscalYear?: string;
  pendingOutboxCount?: number;
}): AuditReport {
  const {
    accounts,
    vouchers,
    invoices,
    parties,
    products,
    cheques,
    trialBalance,
    balanceSheet,
    partyBalances,
    fiscalYear,
    pendingOutboxCount,
  } = input;
  const checks: AuditCheckItem[] = [];
  const fyPrefix = fiscalYear ? `${String(fiscalYear).trim()}/` : '';
  const scopedVouchers = fiscalYear
    ? vouchers.filter((v) => !v.date || v.date.startsWith(fyPrefix))
    : vouchers;
  const scopedInvoices = fiscalYear
    ? invoices.filter((i) => !i.date || i.date.startsWith(fyPrefix))
    : invoices;
  const accountMap = new Map(accounts.map((a) => [a.code, a]));

  // 1. Voucher double-entry mathematical integrity & postable account check
  const unbalancedVouchers: string[] = [];
  const unbalancedRefs: string[] = [];
  let maxUnbalancedDiff = 0;
  for (const v of scopedVouchers) {
    const sumD = v.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const sumC = v.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    const diff = Math.abs(sumD - sumC);
    const hasZeroOrDual = v.lines.some(
      (l) =>
        (Number(l.debit) || 0) < 0 ||
        (Number(l.credit) || 0) < 0 ||
        ((Number(l.debit) || 0) === 0 && (Number(l.credit) || 0) === 0) ||
        ((Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0)
    );
    const hasInvalidAcc = v.lines.some((l) => {
      const a = accountMap.get(l.accountCode);
      return !a || a.level === 'group' || a.level === 'kol';
    });
    if (diff > 0 || v.lines.length < 2 || Math.abs(sumD - v.totalDebit) > 0 || sumD <= 0 || hasZeroOrDual || hasInvalidAcc) {
      maxUnbalancedDiff = Math.max(maxUnbalancedDiff, diff);
      unbalancedRefs.push(v.id);
      unbalancedVouchers.push(
        `سند #${v.voucherNumber} (بدهکار: ${sumD.toLocaleString('en-US')} / بستانکار: ${sumC.toLocaleString('en-US')}${hasZeroOrDual ? ' — آرتیکل صفر یا دوطرفه' : ''}${hasInvalidAcc ? ' — کد حساب نامعتبر/کل' : ''})`
      );
    }
  }
  checks.push({
    id: 'voucher-balance',
    title: 'کنترل تراز دوبل و اعتبار آرتیکل‌های تمامی اسناد حسابداری',
    category: 'هسته حسابداری',
    status: unbalancedVouchers.length === 0 ? 'pass' : 'error',
    severity: unbalancedVouchers.length === 0 ? 'info' : 'critical',
    summary:
      unbalancedVouchers.length === 0
        ? `تمامی ${scopedVouchers.length} سند ثبت‌شده دارای تراز دقیق (بدهکار = بستانکار)، حساب معین معتبر و حداقل ۲ آرتیکل هستند.`
        : `${unbalancedVouchers.length} سند دارای عدم توازن یا خطای ساختاری آرتیکل شناسایی شد.`,
    details: unbalancedVouchers,
    probableCause:
      unbalancedVouchers.length > 0
        ? 'ثبت سند دستی ناتراز، استفاده از کد حساب کل/گروه به جای معین، یا دستکاری داده خام.'
        : undefined,
    relatedRefs: unbalancedRefs,
    discrepancyAmount: maxUnbalancedDiff,
    suggestedFix:
      unbalancedVouchers.length > 0
        ? 'سندهای نامعتبر را بازبینی کرده و در صورت دائم بودن، با صدور سند اصلاحی/معکوس تراز را برقرار کنید.'
        : undefined,
    targetModule: 'vouchers',
  });

  // 2. Per-Fiscal-Year Voucher numbering continuity & chronological date check
  const byYear = new Map<string, Voucher[]>();
  for (const v of scopedVouchers) {
    const yr = v.fiscalYear || extractFiscalYearFromDate(v.date) || 'unknown';
    const arr = byYear.get(yr) || [];
    arr.push(v);
    byYear.set(yr, arr);
  }
  const seqIssues: string[] = [];
  const seqRefs: string[] = [];
  for (const [yr, yrVouchers] of byYear.entries()) {
    const sortedByNum = [...yrVouchers].sort((a, b) => a.voucherNumber - b.voucherNumber);
    for (let i = 0; i < sortedByNum.length; i++) {
      const expected = i + 1;
      if (sortedByNum[i].voucherNumber !== expected) {
        seqIssues.push(
          `سال ${yr} — گسست در شماره سند: انتظار #${expected} اما سند #${sortedByNum[i].voucherNumber} ثبت شده است.`
        );
        seqRefs.push(sortedByNum[i].id);
        break;
      }
      if (i > 0 && sortedByNum[i].date < sortedByNum[i - 1].date) {
        seqIssues.push(
          `سال ${yr} — عدم ترتیب تاریخی بین سند #${sortedByNum[i - 1].voucherNumber} (${sortedByNum[i - 1].date}) و سند #${sortedByNum[i].voucherNumber} (${sortedByNum[i].date}).`
        );
        seqRefs.push(sortedByNum[i].id);
      }
    }
  }
  checks.push({
    id: 'voucher-sequence',
    title: 'کنترل توالی شماره‌گذاری و ترتیب تاریخی اسناد به تفکیک سال مالی',
    category: 'دفاتر قانونی',
    status: seqIssues.length === 0 ? 'pass' : 'warning',
    severity: seqIssues.length === 0 ? 'info' : 'warning',
    summary:
      seqIssues.length === 0
        ? 'شماره اسناد در هر سال مالی از ۱ تا آخرین سند بدون گسست و منطبق بر ترتیب تاریخ شمسی است.'
        : 'گسست شماره یا ناهماهنگی تاریخ در اسناد وجود دارد (قابل اصلاح با مرتب‌سازی سالانه).',
    details: seqIssues,
    probableCause: seqIssues.length > 0 ? 'حذف سند موقت یا ثبت سند عطف به تاریخ گذشته.' : undefined,
    relatedRefs: seqRefs,
    suggestedFix:
      seqIssues.length > 0 ? 'از ابزار «مرتب‌سازی و شماره‌گذاری مجدد اسناد» در بخش اسناد حسابداری استفاده کنید.' : undefined,
    targetModule: 'vouchers',
  });

  // 3. Duplicate Voucher & Duplicate Reference Check
  const dupIssues: string[] = [];
  const dupRefs: string[] = [];
  const seenRefMap = new Map<string, Voucher>();
  const seenFpMap = new Map<string, Voucher>();
  for (const v of scopedVouchers) {
    if (v.referenceId && !v.reversalOfVoucherId) {
      const prevRef = seenRefMap.get(v.referenceId);
      if (prevRef) {
        dupIssues.push(
          `سند تکراری برای مرجع ${v.referenceId}: سند #${prevRef.voucherNumber} و سند #${v.voucherNumber}`
        );
        dupRefs.push(prevRef.id, v.id);
      } else {
        seenRefMap.set(v.referenceId, v);
      }
    }
    if (!v.reversalOfVoucherId && v.voucherType !== 'opening' && v.voucherType !== 'closing') {
      const fp = computeVoucherFingerprint({
        date: v.date,
        voucherType: v.voucherType,
        lines: v.lines,
      });
      const prevFp = seenFpMap.get(fp);
      if (prevFp) {
        dupIssues.push(
          `سندهای کاملاً همسان (مظنون به ثبت تکراری): سند #${prevFp.voucherNumber} و سند #${v.voucherNumber} در تاریخ ${v.date}`
        );
        dupRefs.push(prevFp.id, v.id);
      } else {
        seenFpMap.set(fp, v);
      }
    }
  }
  checks.push({
    id: 'duplicate-vouchers',
    title: 'کنترل عدم ثبت سند تکراری یا فاکتور دارای دو سند',
    category: 'کنترل داخلی',
    status: dupIssues.length === 0 ? 'pass' : 'error',
    severity: dupIssues.length === 0 ? 'info' : 'critical',
    summary:
      dupIssues.length === 0
        ? 'هیچ سند تکراری یا فاکتور دارای دو سند حسابداری شناسایی نشد.'
        : `${dupIssues.length} مورد سند تکراری یا مرجع همپوشان شناسایی شد.`,
    details: dupIssues,
    probableCause: dupIssues.length > 0 ? 'تکرار ارسال فاکتور یا ثبت دستی مجدد سند اتوماتیک.' : undefined,
    relatedRefs: Array.from(new Set(dupRefs)),
    suggestedFix:
      dupIssues.length > 0 ? 'سند تکراری را با سند معکوس خنثی کرده و مرجع فاکتور را بررسی کنید.' : undefined,
    targetModule: 'vouchers',
  });

  // 4. Invoice-to-Voucher Coverage (Missing & Orphan Vouchers)
  const voucherById = new Map(vouchers.map((v) => [v.id, v]));
  const voucherByRef = new Map<string, Voucher>();
  vouchers.forEach((v) => {
    if (v.referenceId && !v.reversalOfVoucherId) voucherByRef.set(v.referenceId, v);
  });
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const invVoucherIssues: string[] = [];
  const invVoucherRefs: string[] = [];
  for (const inv of scopedInvoices) {
    if (inv.status === 'cancelled' || inv.invoiceType === 'proforma') continue;
    const hasVoucher =
      (inv.voucherId && voucherById.has(inv.voucherId)) || voucherByRef.has(inv.id);
    if (!hasVoucher) {
      invVoucherIssues.push(`فاکتور ${inv.invoiceNumber} (${inv.date}) فاقد سند حسابداری متصل است.`);
      invVoucherRefs.push(inv.id);
    }
  }
  for (const v of scopedVouchers) {
    if (v.referenceId && v.referenceId.startsWith('inv_')) {
      const inv = invoiceById.get(v.referenceId);
      if (!inv) {
        invVoucherIssues.push(`سند #${v.voucherNumber} به فاکتور ناموجود (${v.referenceId}) ارجاع دارد (سند یتیم).`);
        invVoucherRefs.push(v.id);
      } else if (inv.status === 'cancelled' && !v.reversalOfVoucherId) {
        const hasReversal = scopedVouchers.some(
          (rv) => rv.reversalOfVoucherId === v.id || (rv.referenceId === inv.id && rv.id !== v.id)
        );
        if (!hasReversal) {
          invVoucherIssues.push(
            `فاکتور ${inv.invoiceNumber} ابطال شده اما سند #${v.voucherNumber} بدون سند معکوس باقی مانده است.`
          );
          invVoucherRefs.push(v.id);
        }
      }
    }
  }
  checks.push({
    id: 'invoice-voucher-coverage',
    title: 'تطابق یک‌به‌یک فاکتورهای فعال با اسناد حسابداری (عدم وجود سند یتیم یا فاکتور بی‌سند)',
    category: 'حسابرسی تطبیقی',
    status: invVoucherIssues.length === 0 ? 'pass' : 'error',
    severity: invVoucherIssues.length === 0 ? 'info' : 'critical',
    summary:
      invVoucherIssues.length === 0
        ? 'تمامی فاکتورهای رسمی دارای سند حسابداری معتبر بوده و هیچ سند یتیمی وجود ندارد.'
        : `${invVoucherIssues.length} مورد ناهماهنگی بین فاکتورها و اسناد حسابداری یافت شد.`,
    details: invVoucherIssues,
    probableCause:
      invVoucherIssues.length > 0
        ? 'ثبت ناقص فاکتور در نسخه‌های قدیمی یا حذف/ابطال غیرمتقارن سند.'
        : undefined,
    relatedRefs: invVoucherRefs,
    suggestedFix:
      invVoucherIssues.length > 0
        ? 'برای فاکتورهای بی‌سند، سند متناظر صادر کرده و اسناد یتیم را معکوس نمایید.'
        : undefined,
    targetModule: 'invoices',
  });

  // 5. Trial Balance equality
  const totD = trialBalance.reduce((s, r) => s + r.totalDebit, 0);
  const totC = trialBalance.reduce((s, r) => s + r.totalCredit, 0);
  const balD = trialBalance.reduce((s, r) => s + r.balanceDebit, 0);
  const balC = trialBalance.reduce((s, r) => s + r.balanceCredit, 0);
  const tbBalanced = Math.abs(totD - totC) < 1 && Math.abs(balD - balC) < 1;
  checks.push({
    id: 'trial-balance',
    title: 'توازن تراز آزمایشی (گردش کل و مانده)',
    category: 'تراز و صورت‌های مالی',
    status: tbBalanced ? 'pass' : 'error',
    severity: tbBalanced ? 'info' : 'critical',
    summary: tbBalanced
      ? 'جمع ستون‌های گردش بدهکار/بستانکار و مانده بدهکار/بستانکار تراز آزمایشی کاملاً برابر است.'
      : `اختلاف در تراز آزمایشی: گردش (${totD - totC}) / مانده (${balD - balC}).`,
    details: tbBalanced ? [] : [`اختلاف گردش: ${totD - totC}`, `اختلاف مانده: ${balD - balC}`],
    discrepancyAmount: Math.max(Math.abs(totD - totC), Math.abs(balD - balC)),
    probableCause: !tbBalanced ? 'وجود حداقل یک سند ناتراز در دوره مالی جاری.' : undefined,
    suggestedFix: !tbBalanced ? 'کنترل «تراز دوبل اسناد» را بررسی و سند ناتراز را اصلاح کنید.' : undefined,
    targetModule: 'reports',
  });

  // 6. Balance Sheet equation integrity
  checks.push({
    id: 'balance-sheet',
    title: 'صحت معادله اساسی ترازنامه (دارایی = بدهی + سرمایه)',
    category: 'تراز و صورت‌های مالی',
    status: balanceSheet.isBalanced ? 'pass' : 'error',
    severity: balanceSheet.isBalanced ? 'info' : 'critical',
    summary: balanceSheet.isBalanced
      ? 'معادله ترازنامه با احتساب سود/زیان دوره جاری دقیقاً متوازن است.'
      : `ترازنامه دارای اختلاف ${Math.abs(balanceSheet.difference).toLocaleString('en-US')} ریال است.`,
    details: balanceSheet.isBalanced
      ? []
      : [
          `جمع دارایی‌ها: ${balanceSheet.totalAssets.toLocaleString('en-US')}`,
          `جمع بدهی و حقوق صاحبان سهام: ${(balanceSheet.totalLiabilities + balanceSheet.totalEquity).toLocaleString('en-US')}`,
        ],
    discrepancyAmount: Math.abs(balanceSheet.difference),
    probableCause: !balanceSheet.isBalanced
      ? 'عدم توازن تراز آزمایشی یا دسته‌بندی نادرست ماهیت یکی از حساب‌ها در کدینگ.'
      : undefined,
    suggestedFix: !balanceSheet.isBalanced
      ? 'کدینگ حساب‌ها (دارایی/بدهی/سرمایه/درآمد/هزینه) و تراز اسناد را بررسی کنید.'
      : undefined,
    targetModule: 'reports',
  });

  // 7. Subsidiary Ledger (Party Balances) vs General Ledger (10401 & 30101)
  const gl10401Row = trialBalance.find((r) => r.accountCode === '10401');
  const gl30101Row = trialBalance.find((r) => r.accountCode === '30101');
  const glReceivables = gl10401Row ? gl10401Row.balanceDebit - gl10401Row.balanceCredit : 0;
  const glPayables = gl30101Row ? gl30101Row.balanceCredit - gl30101Row.balanceDebit : 0;

  let subReceivables = 0;
  let subPayables = 0;
  const missingPartyRefs: string[] = [];
  const officialAuditVouchers = filterVouchersForReport(vouchers, {
    includeDrafts: false,
    fiscalYear,
  });
  for (const v of officialAuditVouchers) {
    for (const l of v.lines) {
      if (l.accountCode === '10401') {
        if (l.partyId) subReceivables += (Number(l.debit) || 0) - (Number(l.credit) || 0);
        else missingPartyRefs.push(`سند #${v.voucherNumber} (معین ۱۰۴۰۱ فاقد تفصیلی شخص)`);
      } else if (l.accountCode === '30101') {
        if (l.partyId) subPayables += (Number(l.credit) || 0) - (Number(l.debit) || 0);
        else missingPartyRefs.push(`سند #${v.voucherNumber} (معین ۳۰۱۰۱ فاقد تفصیلی شخص)`);
      }
    }
  }
  const subDiffAr = Math.abs(glReceivables - subReceivables);
  const subDiffAp = Math.abs(glPayables - subPayables);
  checks.push({
    id: 'sub-gl-reconcile',
    title: 'تطبیق دفتر معین بدهکاران/بستانکاران با تفصیلی اشخاص',
    category: 'حسابرسی تطبیقی',
    status: subDiffAr < 1 && subDiffAp < 1 && missingPartyRefs.length === 0 ? 'pass' : 'warning',
    severity: subDiffAr < 1 && subDiffAp < 1 && missingPartyRefs.length === 0 ? 'info' : 'warning',
    summary:
      subDiffAr < 1 && subDiffAp < 1 && missingPartyRefs.length === 0
        ? 'مانده کل معین ۱۰۴۰۱ و ۳۰۱۰۱ به ریال دقیق با جمع گردش تفصیلی طرف‌حساب‌ها منطبق است.'
        : 'برخی آرتیکل‌های ۱۰۴۰۱ یا ۳۰۱۰۱ فاقد انتخاب طرف‌حساب (تفصیلی) هستند.',
    details: [
      ...(subDiffAr >= 1 ? [`اختلاف معین و تفصیلی بدهکاران (۱۰۴۰۱): ${subDiffAr.toLocaleString('en-US')} ریال`] : []),
      ...(subDiffAp >= 1 ? [`اختلاف معین و تفصیلی بستانکاران (۳۰۱۰۱): ${subDiffAp.toLocaleString('en-US')} ریال`] : []),
      ...missingPartyRefs.slice(0, 8),
    ],
    discrepancyAmount: subDiffAr + subDiffAp,
    probableCause:
      subDiffAr >= 1 || subDiffAp >= 1
        ? 'ثبت آرتیکل روی معین ۱۰۴۰۱ یا ۳۰۱۰۱ بدون انتخاب کد تفصیلی شخص.'
        : undefined,
    suggestedFix:
      subDiffAr >= 1 || subDiffAp >= 1
        ? 'سندهای فاقد تفصیلی را اصلاح کرده و طرف‌حساب مربوطه را تخصیص دهید.'
        : undefined,
    targetModule: 'parties',
  });

  // 8. Cash & Bank negative balance check
  const negativeCashRows = trialBalance
    .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
    .filter((r) => r.balanceCredit > 0);
  const negativeCash = negativeCashRows.map(
    (r) => `${r.accountCode} — ${r.accountTitle} (مانده بستانکار / منفی: ${r.balanceCredit.toLocaleString('en-US')} ریال)`
  );
  checks.push({
    id: 'cash-negative',
    title: 'کنترل منفی نشدن موجودی صندوق و حساب‌های بانکی',
    category: 'خزانه‌داری',
    status: negativeCash.length === 0 ? 'pass' : 'error',
    severity: negativeCash.length === 0 ? 'info' : 'critical',
    summary:
      negativeCash.length === 0
        ? 'تمامی حساب‌های صندوق و بانک دارای مانده بدهکار (مثبت) معتبر هستند.'
        : `${negativeCash.length} حساب نقدی/بانکی دارای مانده بستانکار (منفی) است!`,
    details: negativeCash,
    discrepancyAmount: negativeCashRows.reduce((s, r) => s + r.balanceCredit, 0),
    probableCause:
      negativeCash.length > 0 ? 'ثبت پرداخت پیش از ثبت دریافت یا اشتباه در انتخاب حساب بانکی.' : undefined,
    suggestedFix:
      negativeCash.length > 0
        ? 'گردش حساب صندوق/بانک مربوطه را در گزارش دفتر معین بررسی و سند مغایر را اصلاح کنید.'
        : undefined,
    targetModule: 'treasury',
  });

  // 9. Cheques Subledger vs Treasury GL (10301, 10302, 30201)
  const gl10301Row = trialBalance.find((r) => r.accountCode === '10301');
  const gl10302Row = trialBalance.find((r) => r.accountCode === '10302');
  const gl30201Row = trialBalance.find((r) => r.accountCode === '30201');
  const glChequesReceivableBox = gl10301Row ? gl10301Row.balanceDebit - gl10301Row.balanceCredit : 0;
  const glChequesReceivableBank = gl10302Row ? gl10302Row.balanceDebit - gl10302Row.balanceCredit : 0;
  const glChequesPayable = gl30201Row ? gl30201Row.balanceCredit - gl30201Row.balanceDebit : 0;

  const subChequesReceivableBox = cheques
    .filter((c) => c.direction === 'receivable' && c.status === 'in_box')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const subChequesReceivableBank = cheques
    .filter((c) => c.direction === 'receivable' && c.status === 'deposited')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const subChequesPayable = cheques
    .filter((c) => c.direction === 'payable' && c.status === 'in_box')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);

  const chqDiffBox = Math.abs(glChequesReceivableBox - subChequesReceivableBox);
  const chqDiffBank = Math.abs(glChequesReceivableBank - subChequesReceivableBank);
  const chqDiffPay = Math.abs(glChequesPayable - subChequesPayable);
  const chqTotalDiff = chqDiffBox + chqDiffBank + chqDiffPay;
  const chqDetails: string[] = [];
  if (chqDiffBox >= 1) {
    chqDetails.push(
      `چک‌های دریافتنی نزد صندوق (۱۰۳۰۱): دفتر ${glChequesReceivableBox.toLocaleString('en-US')} / لیست چک‌ها ${subChequesReceivableBox.toLocaleString('en-US')}`
    );
  }
  if (chqDiffBank >= 1) {
    chqDetails.push(
      `چک‌های در جریان وصول (۱۰۳۰۲): دفتر ${glChequesReceivableBank.toLocaleString('en-US')} / لیست چک‌ها ${subChequesReceivableBank.toLocaleString('en-US')}`
    );
  }
  if (chqDiffPay >= 1) {
    chqDetails.push(
      `اسناد پرداختنی جاری (۳۰۲۰۱): دفتر ${glChequesPayable.toLocaleString('en-US')} / لیست چک‌ها ${subChequesPayable.toLocaleString('en-US')}`
    );
  }
  checks.push({
    id: 'cheques-gl-reconcile',
    title: 'تطبیق دفتر چک‌های صیادی با معین‌های خزانه‌داری (۱۰۳۰۱ / ۱۰۳۰۲ / ۳۰۲۰۱)',
    category: 'خزانه‌داری',
    status: chqTotalDiff < 1 ? 'pass' : 'warning',
    severity: chqTotalDiff < 1 ? 'info' : 'warning',
    summary:
      chqTotalDiff < 1
        ? 'مانده کل چک‌های دریافتنی نزد صندوق، در جریان وصول و چک‌های پرداختنی دقیقاً با دفاتر کل منطبق است.'
        : `اختلاف ${chqTotalDiff.toLocaleString('en-US')} ریال بین لیست چک‌های صیادی و مانده معین‌های خزانه‌داری وجود دارد.`,
    details: chqDetails,
    discrepancyAmount: chqTotalDiff,
    probableCause:
      chqTotalDiff >= 1
        ? 'ثبت دستی سند روی حساب چک بدون ثبت رکورد در ماژول خزانه‌داری یا تغییر وضعیت چک بدون سند متناظر.'
        : undefined,
    suggestedFix:
      chqTotalDiff >= 1
        ? 'لیست چک‌های فعال را با گردش معین‌های ۱۰۳۰۱، ۱۰۳۰۲ و ۳۰۲۰۱ مطابقت دهید.'
        : undefined,
    targetModule: 'treasury',
  });

  // 10. Inventory stock & reorder audit
  const negStock = products.filter((p) => p.stock < 0).map((p) => `${p.sku} — ${p.name} (${p.stock})`);
  const lowStock = products
    .filter((p) => p.stock >= 0 && p.stock <= p.reorderPoint)
    .map((p) => `${p.sku} — ${p.name} (موجودی: ${p.stock} / نقطه سفارش: ${p.reorderPoint})`);
  checks.push({
    id: 'inventory-audit',
    title: 'کنترل موجودی منفی انبار و نقطه سفارش کالاها',
    category: 'انبارداری',
    status: negStock.length > 0 ? 'error' : lowStock.length > 0 ? 'warning' : 'pass',
    severity: negStock.length > 0 ? 'critical' : lowStock.length > 0 ? 'warning' : 'info',
    summary:
      negStock.length > 0
        ? `${negStock.length} کالا دارای موجودی منفی است.`
        : lowStock.length > 0
          ? `موجودی منفی وجود ندارد؛ ${lowStock.length} کالا در نقطه سفارش است.`
          : 'موجودی تمامی کالاها مثبت و بالاتر از نقطه سفارش است.',
    details: [...negStock, ...lowStock],
    probableCause:
      negStock.length > 0 ? 'خروج کالا بدون ثبت فاکتور خرید قبلی یا مغایرت انبارگردانی.' : undefined,
    suggestedFix:
      negStock.length > 0 ? 'فاکتور خرید معوق یا سند تعدیل انبارگردانی را ثبت کنید.' : undefined,
    targetModule: 'inventory',
  });

  // 11. Inventory Subledger (Kardex / exact inventoryValueIrr) vs General Ledger 10501
  const glInvRow = trialBalance.find((r) => r.accountCode === '10501');
  const glInventory = glInvRow ? glInvRow.balanceDebit - glInvRow.balanceCredit : 0;
  const subInventory = Math.round(
    products.reduce(
      (s, p) =>
        s +
        (p.inventoryValueIrr !== undefined && Number.isFinite(p.inventoryValueIrr)
          ? p.inventoryValueIrr
          : Math.round((Number(p.stock) || 0) * (Number(p.buyPrice) || 0))),
      0
    )
  );
  const invDiff = Math.abs(glInventory - subInventory);
  const invMatched = invDiff <= 5_000;
  checks.push({
    id: 'inventory-gl-reconcile',
    title: 'تطبیق ارزش ریالی انبار (کاردکس/لایه‌های بهای تمام‌شده) با معین ۱۰۵۰۱',
    category: 'حسابرسی انبار و بهای تمام‌شده',
    status: invMatched ? 'pass' : 'warning',
    severity: invMatched ? 'info' : 'warning',
    summary: invMatched
      ? 'ارزش ریالی موجودی انبار به ریال دقیق با مانده حساب معین ۱۰۵۰۱ منطبق است.'
      : `اختلاف ${invDiff.toLocaleString('en-US')} ریال بین موجودی ریالی انبار و مانده دفتر ۱۰۵۰۱ شناسایی شد.`,
    details: invMatched
      ? []
      : [
          `مانده معین ۱۰۵۰۱ در دفاتر: ${glInventory.toLocaleString('en-US')} ریال`,
          `ارزش کل موجودی کالاها (کاردکس): ${subInventory.toLocaleString('en-US')} ریال`,
        ],
    discrepancyAmount: invDiff,
    probableCause: !invMatched
      ? 'ثبت سند دستی روی حساب ۱۰۵۰۱ بدون حرکت انبار یا تغییر دستی موجودی/قیمت خرید کالا.'
      : undefined,
    suggestedFix: !invMatched
      ? 'گردش حساب ۱۰۵۰۱ را با کاردکس کالاها مقایسه و در صورت لزوم سند تعدیل بهای تمام‌شده ثبت کنید.'
      : undefined,
    targetModule: 'inventory',
  });

  // 12. COGS Reconciliation (Invoices vs GL 70101)
  const glCogsRow = trialBalance.find((r) => r.accountCode === '70101');
  const glCogs = glCogsRow ? glCogsRow.balanceDebit - glCogsRow.balanceCredit : 0;
  const prodProfit = computeProductProfitability(scopedInvoices, products, fiscalYear);
  const invCogs = prodProfit.reduce((s, r) => s + r.estimatedCogs, 0);
  const cogsDiff = Math.abs(glCogs - invCogs);
  const cogsMatched = cogsDiff <= 10_000;
  checks.push({
    id: 'cogs-gl-reconcile',
    title: 'تطبیق بهای تمام‌شده فاکتورهای فروش با حساب ۷۰۱۰۱',
    category: 'حسابرسی انبار و بهای تمام‌شده',
    status: cogsMatched ? 'pass' : 'warning',
    severity: cogsMatched ? 'info' : 'warning',
    summary: cogsMatched
      ? 'جمع بهای تمام‌شده فاکتورهای فروش و برگشت فروش با مانده حساب ۷۰۱۰۱ منطبق است.'
      : `اختلاف ${cogsDiff.toLocaleString('en-US')} ریال بین بهای تمام‌شده فاکتورها و مانده حساب ۷۰۱۰۱ مشاهده شد.`,
    details: cogsMatched
      ? []
      : [
          `بهای تمام‌شده محاسبه‌شده فاکتورها: ${invCogs.toLocaleString('en-US')} ریال`,
          `مانده حساب معین ۷۰۱۰۱: ${glCogs.toLocaleString('en-US')} ریال`,
        ],
    discrepancyAmount: cogsDiff,
    probableCause: !cogsMatched
      ? 'وجود سند تعدیل بهای تمام‌شده، انحراف قیمت برگشت خرید، یا فاکتور فاقد snapshot بهای خرید.'
      : undefined,
    suggestedFix: !cogsMatched
      ? 'گزارش بهای تمام‌شده را با گردش حساب ۷۰۱۰۱ تطبیق دهید.'
      : undefined,
    targetModule: 'reports',
  });

  // 13. VAT Reconciliation (Invoices vs GL 30301 & 30302)
  const glSalesVatRow = trialBalance.find((r) => r.accountCode === '30301');
  const glPurchaseVatRow = trialBalance.find((r) => r.accountCode === '30302');
  const glSalesVat = glSalesVatRow ? glSalesVatRow.balanceCredit - glSalesVatRow.balanceDebit : 0;
  const glPurchaseVat = glPurchaseVatRow ? glPurchaseVatRow.balanceDebit - glPurchaseVatRow.balanceCredit : 0;

  const activeInvoices = scopedInvoices.filter(
    (i) => i.status !== 'cancelled' && i.invoiceType !== 'proforma'
  );
  const invSalesVat =
    activeInvoices.filter((i) => i.invoiceType === 'sale').reduce((s, i) => s + i.vatAmount, 0) -
    activeInvoices.filter((i) => i.invoiceType === 'sale_return').reduce((s, i) => s + i.vatAmount, 0);
  const invPurchaseVat =
    activeInvoices.filter((i) => i.invoiceType === 'purchase').reduce((s, i) => s + i.vatAmount, 0) -
    activeInvoices.filter((i) => i.invoiceType === 'purchase_return').reduce((s, i) => s + i.vatAmount, 0);

  const vatDiff = Math.abs(glSalesVat - invSalesVat) + Math.abs(glPurchaseVat - invPurchaseVat);
  const vatMatch = Math.abs(glSalesVat - invSalesVat) < 10 && Math.abs(glPurchaseVat - invPurchaseVat) < 10;
  checks.push({
    id: 'vat-reconcile',
    title: 'تطبیق مالیات ارزش افزوده فاکتورهای مودیان با دفاتر معین (۳۰۳۰۱ / ۳۰۳۰۲)',
    category: 'مالیاتی و مودیان',
    status: vatMatch ? 'pass' : 'warning',
    severity: vatMatch ? 'info' : 'warning',
    summary: vatMatch
      ? 'مالیات ارزش افزوده خرید و فروش در فاکتورها دقیقاً با مانده دفاتر ۳۰۳۰۱ و ۳۰۳۰۲ برابر است.'
      : 'اختلاف بین مالیات فاکتورها و مانده حساب‌های ارزش افزوده (ممکن است بابت سند تسویه اظهارنامه باشد).',
    details: vatMatch
      ? []
      : [
          `مالیات فروش فاکتورها: ${invSalesVat.toLocaleString('en-US')} / دفتر ۳۰۳۰۱: ${glSalesVat.toLocaleString('en-US')}`,
          `مالیات خرید فاکتورها: ${invPurchaseVat.toLocaleString('en-US')} / دفتر ۳۰۳۰۲: ${glPurchaseVat.toLocaleString('en-US')}`,
        ],
    discrepancyAmount: vatDiff,
    probableCause: !vatMatch
      ? 'صدور سند دستی تهاتر/پرداخت مالیات فصلی یا خطای نرخ مالیات در فاکتور.'
      : undefined,
    suggestedFix: !vatMatch
      ? 'اسناد حساب‌های ۳۰۳۰۱ و ۳۰۳۰۲ را با گزارش فصلی ۱۶۹ مطابقت دهید.'
      : undefined,
    targetModule: 'invoices',
  });

  // 14. Date Validity & Fiscal Period Boundary Check
  const invalidDateIssues: string[] = [];
  const invalidDateRefs: string[] = [];
  for (const v of vouchers) {
    if (!isValidShamsiDate(v.date)) {
      invalidDateIssues.push(`سند #${v.voucherNumber} دارای تاریخ شمسی نامعتبر است: «${v.date}»`);
      invalidDateRefs.push(v.id);
    } else if (fiscalYear && v.fiscalYear && v.fiscalYear !== extractFiscalYearFromDate(v.date)) {
      invalidDateIssues.push(
        `سند #${v.voucherNumber} دارای سال مالی ${v.fiscalYear} اما تاریخ ${v.date} است.`
      );
      invalidDateRefs.push(v.id);
    }
  }
  checks.push({
    id: 'date-fiscal-period',
    title: 'کنترل صحت تاریخ شمسی و انطباق اسناد با دوره مالی',
    category: 'دفاتر قانونی',
    status: invalidDateIssues.length === 0 ? 'pass' : 'warning',
    severity: invalidDateIssues.length === 0 ? 'info' : 'warning',
    summary:
      invalidDateIssues.length === 0
        ? 'تاریخ تمامی اسناد معتبر و منطبق با دوره مالی مربوطه است.'
        : `${invalidDateIssues.length} سند با تاریخ نامعتبر یا ناهماهنگ با دوره مالی یافت شد.`,
    details: invalidDateIssues,
    relatedRefs: invalidDateRefs,
    probableCause: invalidDateIssues.length > 0 ? 'ورود تاریخ خارج از فرمت YYYY/MM/DD یا ثبت در سال مالی اشتباه.' : undefined,
    suggestedFix: invalidDateIssues.length > 0 ? 'تاریخ اسناد مشخص‌شده را بررسی و اصلاح کنید.' : undefined,
    targetModule: 'vouchers',
  });

  // 15. Permanent Voucher Tamper-Seal Integrity Check
  const tamperedIssues: string[] = [];
  const tamperedRefs: string[] = [];
  for (const v of scopedVouchers) {
    if (v.status === 'permanent' && v.integrityHash) {
      const expected = computeVoucherIntegrityHash(v);
      if (expected !== v.integrityHash) {
        tamperedIssues.push(
          `مُهر اصالت سند دائم #${v.voucherNumber} (${v.date}) با محتوای فعلی آرتیکل‌ها مطابقت ندارد!`
        );
        tamperedRefs.push(v.id);
      }
    }
  }
  checks.push({
    id: 'permanent-voucher-seal',
    title: 'کنترل مُهر اصالت و عدم دستکاری اسناد دائم (Audit Seal)',
    category: 'امنیت و کنترل داخلی',
    status: tamperedIssues.length === 0 ? 'pass' : 'error',
    severity: tamperedIssues.length === 0 ? 'info' : 'critical',
    summary:
      tamperedIssues.length === 0
        ? 'تمامی اسناد دائم مُهرشده بدون هیچ‌گونه تغییر یا دستکاری پس از قطعی‌سازی هستند.'
        : `${tamperedIssues.length} سند دائم دارای مغایرت مُهر اصالت شناسایی شد!`,
    details: tamperedIssues,
    relatedRefs: tamperedRefs,
    probableCause:
      tamperedIssues.length > 0
        ? 'تغییر مستقیم رکورد سند دائم در پایگاه‌داده یا فایل پشتیبان بدون استفاده از سند اصلاحی.'
        : undefined,
    suggestedFix:
      tamperedIssues.length > 0
        ? 'تاریخچه رویدادها (Audit Log) و آخرین بکاپ امن را بررسی و از صحت سند اطمینان حاصل کنید.'
        : undefined,
    targetModule: 'vouchers',
  });

  // 16. Draft vouchers, bounced cheques & credit limit breaches
  const draftVouchers = scopedVouchers.filter((v) => v.status === 'draft');
  const bouncedCheques = cheques.filter((c) => c.status === 'bounced');
  const overLimitParties = parties.filter((p) => {
    const bal = partyBalances.get(p.id) ?? 0;
    return p.creditLimit > 0 && bal > p.creditLimit;
  });
  const opDetails: string[] = [
    ...draftVouchers.map((v) => `سند موقت #${v.voucherNumber} (${v.date}) هنوز دائم نشده است.`),
    ...bouncedCheques.map((c) => `چک برگشتی صیادی ${c.sayadiId} — ${c.partyName}`),
    ...overLimitParties.map((p) => `عبور طرف‌حساب «${p.name}» از سقف اعتبار مصوب.`),
  ];
  checks.push({
    id: 'operational-controls',
    title: 'کنترل اسناد موقت، چک‌های برگشتی و سقف اعتبار مشتریان',
    category: 'کنترل داخلی',
    status: opDetails.length === 0 ? 'pass' : 'warning',
    severity: opDetails.length === 0 ? 'info' : 'warning',
    summary:
      opDetails.length === 0
        ? 'تمامی اسناد دائم هستند، چک برگشتی وجود ندارد و سقف اعتبار مشتریان رعایت شده است.'
        : `${opDetails.length} مورد نیازمند پیگیری حسابدار یا مدیر مالی شناسایی شد.`,
    details: opDetails,
    probableCause:
      opDetails.length > 0
        ? 'اسناد در انتظار قطعی‌سازی، چک وصول‌نشده یا فروش نسیه بیش از حد اعتبار.'
        : undefined,
    suggestedFix:
      opDetails.length > 0
        ? 'اسناد موقت را قطعی کنید، وضعیت چک‌های برگشتی را پیگیری و وصول مطالبات مشتریان را انجام دهید.'
        : undefined,
    targetModule: draftVouchers.length > 0 ? 'vouchers' : bouncedCheques.length > 0 ? 'treasury' : 'parties',
  });

  // 17. Offline Sync Outbox Health (when provided)
  if (typeof pendingOutboxCount === 'number') {
    checks.push({
      id: 'sync-outbox-health',
      title: 'سلامت صف همگام‌سازی آفلاین-اول (Outbox Queue)',
      category: 'همگام‌سازی و زیرساخت',
      status: pendingOutboxCount === 0 ? 'pass' : 'warning',
      severity: pendingOutboxCount === 0 ? 'info' : 'warning',
      summary:
        pendingOutboxCount === 0
          ? 'تمامی عملیات محلی با موفقیت پردازش شده و صف همگام‌سازی پاک (۰) است.'
          : `${pendingOutboxCount} عملیات در صف انتظار همگام‌سازی با ابر قرار دارد.`,
      details:
        pendingOutboxCount === 0
          ? []
          : [`تعداد عملیات معوق در IndexedDB Outbox: ${pendingOutboxCount}`],
      probableCause: pendingOutboxCount > 0 ? 'کار در حالت آفلاین یا قطع موقت دسترسی ابری.' : undefined,
      suggestedFix:
        pendingOutboxCount > 0 ? 'پس از اتصال به اینترنت، دکمه همگام‌سازی را اجرا کنید.' : undefined,
      targetModule: 'vouchers',
    });
  }

  const passedCount = checks.filter((c) => c.status === 'pass').length;
  const warningCount = checks.filter((c) => c.status === 'warning').length;
  const errorCount = checks.filter((c) => c.status === 'error').length;
  const score = Math.round(((passedCount + warningCount * 0.5) / checks.length) * 100);

  return {
    score,
    passedCount,
    warningCount,
    errorCount,
    checks,
    reconciliation: {
      glReceivables,
      subReceivables,
      glPayables,
      subPayables,
      glSalesVat,
      invSalesVat,
      glPurchaseVat,
      invPurchaseVat,
      glInventory,
      subInventory,
      glChequesReceivableBox,
      subChequesReceivableBox,
      glChequesReceivableBank,
      subChequesReceivableBank,
      glChequesPayable,
      subChequesPayable,
      glCogs,
      invCogs,
    },
  };
}

export interface PayrollCalculation {
  employee: Employee;
  fiscalYear: string;
  statutoryParams: IranFiscalYearStatutoryParams;
  overtimePay: number;
  childAllowance: number;
  grossPay: number;
  insurableBase: number;
  employeeInsurance: number;
  employerInsurance: number;
  taxableIncome: number;
  incomeTax: number;
  netPay: number;
  totalEmployerCost: number;
}

export function calculateEmployeePayroll(
  emp: Employee,
  fiscalYear = '1405',
  customStatutoryByYear?: Record<string, IranFiscalYearStatutoryParams>
): PayrollCalculation {
  const statutoryParams = getStatutoryParamsForYear(fiscalYear, customStatutoryByYear);
  const hoursBase = Math.max(1, statutoryParams.monthlyWorkingHoursBase || 220);
  const hourlyRate = emp.baseSalary / hoursBase;
  const overtimePay = Math.round(emp.overtimeHours * hourlyRate * (statutoryParams.overtimeMultiplier || 1.4));
  const childAllowance = Math.max(0, Math.round(emp.childrenCount * statutoryParams.childAllowancePerChildIrr));
  const grossPay = Math.max(
    0,
    Math.round(emp.baseSalary + emp.housingAllowance + emp.foodAllowance + childAllowance + overtimePay)
  );
  const insurableBase = Math.min(grossPay, statutoryParams.insurableWageCeilingIrr);
  const employeeInsurance = Math.round(insurableBase * statutoryParams.employeeInsuranceRate);
  const employerInsurance = Math.round(insurableBase * statutoryParams.employerInsuranceRate);

  // Per Iranian Direct Taxes Act (Art. 84 & 85 + annual Budget Law), compute progressive monthly tax
  // on taxable salary base (deducting employee SSO share 2/7 exemption convention or configurable base —
  // here deducting employee insurance share cleanly so total deductions never exceed grossPay).
  const taxableIncome = Math.max(0, grossPay - employeeInsurance);
  const incomeTax = calculateIranMonthlyPayrollTax(
    taxableIncome,
    statutoryParams.monthlyTaxExemptionIrr,
    statutoryParams.monthlyTaxBrackets
  );

  const netPay = Math.max(0, grossPay - employeeInsurance - incomeTax);
  const totalEmployerCost = grossPay + employerInsurance;

  return {
    employee: emp,
    fiscalYear: statutoryParams.fiscalYear,
    statutoryParams,
    overtimePay,
    childAllowance,
    grossPay,
    insurableBase,
    employeeInsurance,
    employerInsurance,
    taxableIncome,
    incomeTax,
    netPay,
    totalEmployerCost,
  };
}

export function calculateMonthlyDepreciation(asset: FixedAsset): number {
  const depreciable = Math.max(0, asset.purchaseCost - asset.salvageValue);
  const remaining = Math.max(0, depreciable - asset.accumulatedDepreciation);
  if (remaining <= 0) return 0;
  const monthly = Math.round(depreciable / (asset.usefulLifeYears * 12));
  return Math.min(monthly, remaining);
}

/**
 * Generates a mathematically balanced double-entry VoucherLine[] for Sales, Purchase, Returns, or Waste Invoices.
 */
export function buildInvoiceVoucherLines(
  invoice: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>,
  cogsTotal: number,
  purchaseReturnVarianceIrr = 0
): VoucherLine[] {
  const lines: VoucherLine[] = [];

  if (invoice.invoiceType === 'sale') {
    if (invoice.paidCash > 0) {
      lines.push({
        accountCode: '10101',
        accountTitle: 'صندوق مرکزی شرکت',
        costCenterId: invoice.costCenterId,
        description: `دریافت نقدی بابت فاکتور فروش ${invoice.invoiceNumber}`,
        debit: invoice.paidCash,
        credit: 0,
      });
    }
    if (invoice.paidBank > 0) {
      lines.push({
        accountCode: '10201',
        accountTitle: 'بانک ملت — حساب جاری شرکتی',
        costCenterId: invoice.costCenterId,
        description: `واریز بانکی/کارتخوان فاکتور فروش ${invoice.invoiceNumber}`,
        debit: invoice.paidBank,
        credit: 0,
      });
    }
    if (invoice.paidCheque > 0) {
      lines.push({
        accountCode: '10301',
        accountTitle: 'اسناد دریافتنی نزد صندوق',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `چک صیادی دریافتی فاکتور ${invoice.invoiceNumber}`,
        debit: invoice.paidCheque,
        credit: 0,
      });
    }
    if (invoice.creditAmount > 0) {
      lines.push({
        accountCode: '10401',
        accountTitle: 'بدهکاران تجاری و مشتریان',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `مانده نسیه فاکتور فروش ${invoice.invoiceNumber}`,
        debit: invoice.creditAmount,
        credit: 0,
      });
    }

    const netRevenue = Math.max(0, Math.round(invoice.grandTotal - invoice.vatAmount));
    lines.push({
      accountCode: '60101',
      accountTitle: 'فروش رسمی محصولات',
      costCenterId: invoice.costCenterId,
      description: `فروش کالا — فاکتور ${invoice.invoiceNumber}`,
      debit: 0,
      credit: netRevenue,
    });
    if (invoice.vatAmount > 0) {
      lines.push({
        accountCode: '30301',
        accountTitle: 'مالیات بر ارزش افزوده فروش (۱۰٪)',
        description: `مالیات ارزش افزوده فاکتور ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.vatAmount),
      });
    }

    if (cogsTotal > 0) {
      lines.push({
        accountCode: '70101',
        accountTitle: 'بهای تمام‌شده کالای فروش‌رفته',
        costCenterId: invoice.costCenterId,
        description: `بهای تمام‌شده اقلام فاکتور ${invoice.invoiceNumber}`,
        debit: Math.round(cogsTotal),
        credit: 0,
      });
      lines.push({
        accountCode: '10501',
        accountTitle: 'موجودی انبار مرکزی',
        description: `خروج کالا از ${invoice.warehouse}`,
        debit: 0,
        credit: Math.round(cogsTotal),
      });
    }
  } else if (invoice.invoiceType === 'purchase') {
    const netPurchase = Math.max(0, Math.round(invoice.grandTotal - invoice.vatAmount));
    lines.push({
      accountCode: '10501',
      accountTitle: 'موجودی انبار مرکزی',
      costCenterId: invoice.costCenterId,
      description: `ورود کالا به ${invoice.warehouse} — فاکتور خرید ${invoice.invoiceNumber}`,
      debit: netPurchase,
      credit: 0,
    });
    if (invoice.vatAmount > 0) {
      lines.push({
        accountCode: '30302',
        accountTitle: 'مالیات بر ارزش افزوده خرید',
        description: `مالیات خرید فاکتور ${invoice.invoiceNumber}`,
        debit: Math.round(invoice.vatAmount),
        credit: 0,
      });
    }
    if (invoice.paidCash > 0) {
      lines.push({
        accountCode: '10101',
        accountTitle: 'صندوق مرکزی شرکت',
        description: `پرداخت نقدی فاکتور خرید ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidCash),
      });
    }
    if (invoice.paidBank > 0) {
      lines.push({
        accountCode: '10201',
        accountTitle: 'بانک ملت — حساب جاری شرکتی',
        description: `حواله بانکی فاکتور خرید ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidBank),
      });
    }
    if (invoice.paidCheque > 0) {
      lines.push({
        accountCode: '30201',
        accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `چک صادره بابت خرید ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidCheque),
      });
    }
    if (invoice.creditAmount > 0) {
      lines.push({
        accountCode: '30101',
        accountTitle: 'بستانکاران و تأمین‌کنندگان',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `مانده نسیه فاکتور خرید ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.creditAmount),
      });
    }
  } else if (invoice.invoiceType === 'sale_return') {
    const netRet = Math.max(0, Math.round(invoice.grandTotal - invoice.vatAmount));
    lines.push({
      accountCode: '60201',
      accountTitle: 'برگشت از فروش کالا',
      costCenterId: invoice.costCenterId,
      description: `برگشت از فروش ${invoice.invoiceNumber}`,
      debit: netRet,
      credit: 0,
    });
    if (invoice.vatAmount > 0) {
      lines.push({
        accountCode: '30301',
        accountTitle: 'مالیات بر ارزش افزوده فروش (۱۰٪)',
        description: `کاهش مالیات بابت برگشت فروش ${invoice.invoiceNumber}`,
        debit: Math.round(invoice.vatAmount),
        credit: 0,
      });
    }
    if (invoice.paidCash > 0) {
      lines.push({
        accountCode: '10101',
        accountTitle: 'صندوق مرکزی شرکت',
        description: `استرداد نقدی بابت برگشت فروش ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidCash),
      });
    }
    if (invoice.paidBank > 0) {
      lines.push({
        accountCode: '10201',
        accountTitle: 'بانک ملت — حساب جاری شرکتی',
        description: `استرداد بانکی بابت برگشت فروش ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidBank),
      });
    }
    if (invoice.paidCheque > 0) {
      lines.push({
        accountCode: '30201',
        accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `چک استردادی بابت برگشت فروش ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.paidCheque),
      });
    }
    const creditPart = Math.max(
      0,
      Math.round(invoice.grandTotal - invoice.paidCash - invoice.paidBank - invoice.paidCheque)
    );
    if (creditPart > 0) {
      lines.push({
        accountCode: '10401',
        accountTitle: 'بدهکاران تجاری و مشتریان',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `بستانکاری مشتری بابت برگشت فروش ${invoice.invoiceNumber}`,
        debit: 0,
        credit: creditPart,
      });
    }
    if (cogsTotal > 0) {
      lines.push({
        accountCode: '10501',
        accountTitle: 'موجودی انبار مرکزی',
        description: `بازگشت کالا به انبار — ${invoice.invoiceNumber}`,
        debit: Math.round(cogsTotal),
        credit: 0,
      });
      lines.push({
        accountCode: '70101',
        accountTitle: 'بهای تمام‌شده کالای فروش‌رفته',
        description: `تعدیل بهای تمام‌شده برگشت فروش ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(cogsTotal),
      });
    }
  } else if (invoice.invoiceType === 'purchase_return') {
    const netRet = Math.max(0, Math.round(invoice.grandTotal - invoice.vatAmount));
    if (invoice.paidCash > 0) {
      lines.push({
        accountCode: '10101',
        accountTitle: 'صندوق مرکزی شرکت',
        description: `دریافت نقدی بابت برگشت خرید ${invoice.invoiceNumber}`,
        debit: Math.round(invoice.paidCash),
        credit: 0,
      });
    }
    if (invoice.paidBank > 0) {
      lines.push({
        accountCode: '10201',
        accountTitle: 'بانک ملت — حساب جاری شرکتی',
        description: `دریافت بانکی بابت برگشت خرید ${invoice.invoiceNumber}`,
        debit: Math.round(invoice.paidBank),
        credit: 0,
      });
    }
    if (invoice.paidCheque > 0) {
      lines.push({
        accountCode: '10301',
        accountTitle: 'اسناد دریافتنی نزد صندوق',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `چک دریافتی بابت برگشت خرید ${invoice.invoiceNumber}`,
        debit: Math.round(invoice.paidCheque),
        credit: 0,
      });
    }
    const creditPart = Math.max(
      0,
      Math.round(invoice.grandTotal - invoice.paidCash - invoice.paidBank - invoice.paidCheque)
    );
    if (creditPart > 0) {
      lines.push({
        accountCode: '30101',
        accountTitle: 'بستانکاران و تأمین‌کنندگان',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        description: `کاهش بدهی بابت برگشت خرید ${invoice.invoiceNumber}`,
        debit: creditPart,
        credit: 0,
      });
    }
    const variance = Math.round(purchaseReturnVarianceIrr || 0);
    const invCredit = Math.max(0, netRet - variance);
    if (invCredit > 0) {
      lines.push({
        accountCode: '10501',
        accountTitle: 'موجودی انبار مرکزی',
        description: `خروج کالای برگشتی از انبار — ${invoice.invoiceNumber}`,
        debit: 0,
        credit: invCredit,
      });
    }
    if (variance > 0) {
      lines.push({
        accountCode: '70101',
        accountTitle: 'بهای تمام‌شده کالای فروش‌رفته',
        description: `تعدیل انحراف قیمت برگشت از خرید — ${invoice.invoiceNumber}`,
        debit: 0,
        credit: variance,
      });
    } else if (variance < 0) {
      lines.push({
        accountCode: '70101',
        accountTitle: 'بهای تمام‌شده کالای فروش‌رفته',
        description: `تعدیل انحراف قیمت برگشت از خرید — ${invoice.invoiceNumber}`,
        debit: Math.abs(variance),
        credit: 0,
      });
    }
    if (invoice.vatAmount > 0) {
      lines.push({
        accountCode: '30302',
        accountTitle: 'مالیات بر ارزش افزوده خرید',
        description: `تعدیل مالیات خرید — ${invoice.invoiceNumber}`,
        debit: 0,
        credit: Math.round(invoice.vatAmount),
      });
    }
  } else if (invoice.invoiceType === 'waste') {
    const wasteCost = cogsTotal > 0 ? cogsTotal : Math.max(0, invoice.subtotal - invoice.discount);
    if (wasteCost > 0) {
      lines.push({
        accountCode: '80401',
        accountTitle: 'کسری انبارگردانی و ضایعات کالا',
        costCenterId: invoice.costCenterId,
        description: `ثبت هزینه ضایعات کالا — برگه ${invoice.invoiceNumber}`,
        debit: wasteCost,
        credit: 0,
      });
      lines.push({
        accountCode: '10501',
        accountTitle: 'موجودی انبار مرکزی',
        description: `خروج کالای ضایعاتی از ${invoice.warehouse}`,
        debit: 0,
        credit: wasteCost,
      });
    }
  }

  return lines;
}

export interface AccountReviewRow {
  code: string;
  title: string;
  level: 'group' | 'kol' | 'moein';
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  totalDebit: number;
  totalCredit: number;
  balanceDebit: number;
  balanceCredit: number;
  txCount: number;
}

/**
 * Holoo Signature Report: «مرور حساب‌ها» (Multi-level Drill-Down Review)
 * Aggregates debit/credit turnover & balances by Group (1-digit), Kol (3-digit), or Moein (5-digit)
 * with optional Shamshi date range filtering.
 */
export function computeAccountReview(
  accounts: Account[],
  vouchers: Voucher[],
  level: 'group' | 'kol' | 'moein',
  parentPrefix?: string,
  fromDate?: string,
  toDate?: string,
  options?: LedgerFilterOptions
): AccountReviewRow[] {
  const accountMap = new Map<string, Account>();
  accounts.forEach((a) => accountMap.set(a.code, a));

  const codeLen = level === 'group' ? 1 : level === 'kol' ? 3 : 5;
  const buckets = new Map<
    string,
    { openD: number; openC: number; perD: number; perC: number; txCount: number }
  >();

  // Pre-seed known accounts of this level under parentPrefix so even 0-turnover accounts can be inspected if needed
  for (const acc of accounts) {
    if (acc.level === level && (!parentPrefix || acc.code.startsWith(parentPrefix))) {
      buckets.set(acc.code, { openD: 0, openC: 0, perD: 0, perC: 0, txCount: 0 });
    }
  }

  const scopedVouchers = filterVouchersForReport(vouchers, options);

  for (const v of scopedVouchers) {
    if (toDate && v.date > toDate) continue;
    const isOpening = v.voucherType === 'opening' || (!!fromDate && v.date < fromDate);
    for (const l of v.lines) {
      if (parentPrefix && !l.accountCode.startsWith(parentPrefix)) continue;
      const key = l.accountCode.slice(0, codeLen);
      const prev = buckets.get(key) ?? { openD: 0, openC: 0, perD: 0, perC: 0, txCount: 0 };
      const d = Number(l.debit) || 0;
      const c = Number(l.credit) || 0;
      if (isOpening) {
        prev.openD += d;
        prev.openC += c;
      } else {
        prev.perD += d;
        prev.perC += c;
      }
      prev.txCount += 1;
      buckets.set(key, prev);
    }
  }

  const rows: AccountReviewRow[] = [];
  buckets.forEach((b, code) => {
    const totalDebit = b.openD + b.perD;
    const totalCredit = b.openC + b.perC;
    if (totalDebit === 0 && totalCredit === 0 && b.txCount === 0) return;
    const diff = totalDebit - totalCredit;
    rows.push({
      code,
      title: accountMap.get(code)?.title ?? `حساب ${code}`,
      level,
      openingDebit: b.openD,
      openingCredit: b.openC,
      periodDebit: b.perD,
      periodCredit: b.perC,
      totalDebit,
      totalCredit,
      balanceDebit: diff > 0 ? diff : 0,
      balanceCredit: diff < 0 ? Math.abs(diff) : 0,
      txCount: b.txCount,
    });
  });

  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

export interface InvoiceProfitabilityRow {
  invoiceId: string;
  invoiceNumber: string;
  date: string;
  partyName: string;
  netSales: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
}

export function computeInvoiceProfitability(
  invoices: Invoice[],
  products: Product[],
  fiscalYear?: string
): InvoiceProfitabilityRow[] {
  const productMap = new Map<string, Product>();
  products.forEach((p) => productMap.set(p.id, p));
  const fyPrefix = fiscalYear ? `${String(fiscalYear).trim()}/` : '';

  return invoices
    .filter(
      (inv) =>
        inv.status !== 'cancelled' &&
        inv.invoiceType === 'sale' &&
        (!fyPrefix || (typeof inv.date === 'string' && inv.date.startsWith(fyPrefix)))
    )
    .map((inv) => {
      const netSales = Math.max(0, inv.subtotal - inv.discount);
      const cogs = inv.items.reduce((s, it) => {
        if (it.totalCostIrr !== undefined && Number.isFinite(it.totalCostIrr)) {
          return s + Math.round(it.totalCostIrr);
        }
        const prod = productMap.get(it.productId);
        const unitCost = it.unitCostSnapshot !== undefined ? it.unitCostSnapshot : (prod?.buyPrice ?? 0);
        return s + Math.round(it.quantity * unitCost);
      }, 0);
      const grossProfit = netSales - cogs;
      const marginPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: inv.date,
        partyName: inv.partyName,
        netSales,
        cogs,
        grossProfit,
        marginPct,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface Seasonal169Row {
  partyId: string;
  partyCode: string;
  partyName: string;
  nationalId: string;
  economicCode: string;
  salesNet: number;
  salesVat: number;
  purchasesNet: number;
  purchasesVat: number;
  invoiceCount: number;
}

export function computeSeasonal169Report(
  invoices: Invoice[],
  parties: Party[]
): Seasonal169Row[] {
  const partyMap = new Map<string, Party>();
  parties.forEach((p) => partyMap.set(p.id, p));
  const map = new Map<string, Seasonal169Row>();

  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    if (inv.invoiceType === 'proforma' || inv.invoiceType === 'waste') continue;
    const p = partyMap.get(inv.partyId);
    const row = map.get(inv.partyId) ?? {
      partyId: inv.partyId,
      partyCode: p?.code ?? '—',
      partyName: p?.name ?? inv.partyName,
      nationalId: p?.nationalId ?? 'ثبت‌نشده',
      economicCode: p?.economicCode ?? 'ثبت‌نشده',
      salesNet: 0,
      salesVat: 0,
      purchasesNet: 0,
      purchasesVat: 0,
      invoiceCount: 0,
    };

    const net = Math.max(0, inv.subtotal - inv.discount);
    if (inv.invoiceType === 'sale') {
      row.salesNet += net;
      row.salesVat += inv.vatAmount;
    } else if (inv.invoiceType === 'sale_return') {
      row.salesNet -= net;
      row.salesVat -= inv.vatAmount;
    } else if (inv.invoiceType === 'purchase') {
      row.purchasesNet += net;
      row.purchasesVat += inv.vatAmount;
    } else if (inv.invoiceType === 'purchase_return') {
      row.purchasesNet -= net;
      row.purchasesVat -= inv.vatAmount;
    }
    row.invoiceCount += 1;
    map.set(inv.partyId, row);
  }

  return Array.from(map.values()).sort(
    (a, b) => b.salesNet + b.purchasesNet - (a.salesNet + a.purchasesNet)
  );
}

export interface AtomicInvoicePlanInput {
  invoiceId: string;
  voucherId: string;
  chequeId?: string;
  nextVoucherNumber: number;
  ownerId: string;
  deviceId: string;
  payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>;
  products: Product[];
  trialBalance?: TrialBalanceRow[];
  party?: Party;
  currentPartyBalance?: number;
  enforceCashOverdraftGuard?: boolean;
  enforceCreditLimitHardBlock?: boolean;
  allowNegativeStock?: boolean;
  defaultCostingMethod?: InventoryCostingMethod;
  originalInvoice?: Invoice;
  existingInvoices?: Invoice[];
  existingVouchers?: Voucher[];
  closedFiscalYears?: string[];
  fxDecimals?: number;
}

export interface AtomicInvoicePlanResult {
  updatedProducts: Product[];
  productDeltas: Map<
    string,
    {
      stock: number;
      buyPrice: number;
      costLayers: InventoryCostLayer[];
      inventoryValueIrr: number;
      prevVersion: number;
    }
  >;
  voucher?: Voucher;
  cheque?: Cheque;
  invoice: Invoice;
  cogsTotal: number;
  purchaseReturnVarianceIrr: number;
  creditLimitWarning?: string;
}

/**
 * Pure deterministic atomic invoice planner.
 * Pre-validates ALL accounting invariants (Shamsi date, closed fiscal year lock, duplicate invoice guard,
 * settlement equality, FIFO / Moving Weighted Average cost layers, historical sale-return cost recovery,
 * purchase-return variance accounting, cash/bank overdrafts, double-entry equilibrium) and constructs all 4
 * correlated records (Inventory updates, sealed Accounting Voucher, Sayadi Cheque, Invoice)
 * BEFORE any storage write executes — guaranteeing strict all-or-nothing atomicity.
 */
export function planAtomicInvoiceCommit(input: AtomicInvoicePlanInput): AtomicInvoicePlanResult {
  const {
    invoiceId,
    voucherId,
    chequeId,
    nextVoucherNumber,
    ownerId,
    deviceId,
    payload,
    products,
    trialBalance = [],
    party,
    currentPartyBalance = 0,
    enforceCashOverdraftGuard = false,
    enforceCreditLimitHardBlock = false,
    allowNegativeStock = false,
    defaultCostingMethod = 'moving_average',
    originalInvoice,
    existingInvoices = [],
    existingVouchers = [],
    closedFiscalYears = [],
  } = input;

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('فاکتور باید حداقل یک ردیف کالا داشته باشد.');
  }

  // 0. Validate Shamsi date, closed fiscal year lock & duplicate invoice number / voucher
  if (!isValidShamsiDate(payload.date)) {
    throw new Error(`تاریخ فاکتور نامعتبر است («${payload.date}»). قالب صحیح: YYYY/MM/DD`);
  }
  const invoiceFiscalYear = extractFiscalYearFromDate(payload.date);
  if (closedFiscalYears.includes(invoiceFiscalYear)) {
    throw new Error(
      `سال مالی ${invoiceFiscalYear} بسته شده است و امکان ثبت فاکتور جدید در این دوره وجود ندارد.`
    );
  }
  if (
    existingInvoices.some(
      (inv) =>
        inv.status !== 'cancelled' &&
        inv.invoiceNumber.trim() === payload.invoiceNumber.trim() &&
        inv.invoiceType === payload.invoiceType &&
        inv.id !== invoiceId
    )
  ) {
    throw new Error(`شماره فاکتور «${payload.invoiceNumber}» قبلاً ثبت شده است (جلوگیری از ثبت تکراری).`);
  }
  if (existingVouchers.some((v) => v.referenceId === invoiceId && !v.reversalOfVoucherId)) {
    throw new Error('برای این فاکتور قبلاً سند حسابداری صادر شده است.');
  }

  // 1. Validate arithmetic & settlement totals strictly before any mutation
  if (payload.invoiceType !== 'proforma' && payload.invoiceType !== 'waste') {
    const expectedGrand = Math.max(
      0,
      Math.round((Number(payload.subtotal) || 0) - (Number(payload.discount) || 0) + (Number(payload.vatAmount) || 0))
    );
    if (Math.abs(expectedGrand - Math.round(Number(payload.grandTotal) || 0)) > 1) {
      throw new Error(
        `جمع کل فاکتور (${Math.round(payload.grandTotal).toLocaleString('en-US')}) با (جمع ناخالص − تخفیف + مالیات = ${expectedGrand.toLocaleString('en-US')}) برابر نیست.`
      );
    }
    const paymentSum =
      (Number(payload.paidCash) || 0) +
      (Number(payload.paidBank) || 0) +
      (Number(payload.paidCheque) || 0) +
      (Number(payload.creditAmount) || 0);
    if (Math.abs(paymentSum - payload.grandTotal) > 1) {
      throw new Error('جمع مبالغ تسویه (نقد + بانک + چک + نسیه) باید دقیقاً برابر جمع کل فاکتور باشد.');
    }
  }

  // 2. Balance control: prevent cash/bank overdraft on purchases or sale returns when enabled
  if (
    enforceCashOverdraftGuard &&
    (payload.invoiceType === 'purchase' || payload.invoiceType === 'sale_return') &&
    trialBalance.length > 0
  ) {
    const cashRow = trialBalance.find((r) => r.accountCode === '10101');
    const bankRow = trialBalance.find((r) => r.accountCode === '10201');
    const cashBal = cashRow ? cashRow.balanceDebit - cashRow.balanceCredit : 0;
    const bankBal = bankRow ? bankRow.balanceDebit - bankRow.balanceCredit : 0;
    if (payload.paidCash > 0 && payload.paidCash > cashBal + 1) {
      throw new Error(
        `موجودی صندوق (۱۰۱۰۱) برای پرداخت نقدی کافی نیست (موجودی فعلی: ${cashBal.toLocaleString('en-US')} ریال).`
      );
    }
    if (payload.paidBank > 0 && payload.paidBank > bankBal + 1) {
      throw new Error(
        `موجودی بانک جاری (۱۰۲۰۱) برای پرداخت بانکی کافی نیست (موجودی فعلی: ${bankBal.toLocaleString('en-US')} ریال).`
      );
    }
  }

  // 2b. Hard credit limit guard (when explicitly enforced)
  let creditLimitWarning: string | undefined;
  if (
    payload.invoiceType === 'sale' &&
    party &&
    party.creditLimit > 0 &&
    payload.creditAmount > 0 &&
    currentPartyBalance + payload.creditAmount > party.creditLimit
  ) {
    creditLimitWarning = `هشدار سقف اعتبار: مانده جدید «${party.name}» از سقف اعتبار مصوب عبور کرد.`;
    if (enforceCreditLimitHardBlock) {
      throw new Error(
        `ثبت فاکتور نسیه مسدود شد: مانده جدید «${party.name}» (${(currentPartyBalance + payload.creditAmount).toLocaleString('en-US')} ریال) بیش از سقف اعتبار مصوب (${party.creditLimit.toLocaleString('en-US')} ریال) است.`
      );
    }
  }

  // 3. Aggregate duplicate SKU lines & apply exact FIFO / Moving Average inventory engine
  const aggregated = new Map<string, { qty: number; netCostIrr: number; fallbackName: string }>();
  for (const item of payload.items) {
    const qty = roundQty(Number(item.quantity) || 0);
    if (qty <= 0) {
      throw new Error(`مقدار کالا در ردیف «${item.productName}» باید بزرگ‌تر از صفر باشد.`);
    }
    const prev = aggregated.get(item.productId) || {
      qty: 0,
      netCostIrr: 0,
      fallbackName: item.productName,
    };
    prev.qty = roundQty(prev.qty + qty);
    prev.netCostIrr += Math.max(0, Math.round(qty * (Number(item.unitPrice) || 0)) - (Number(item.discount) || 0));
    aggregated.set(item.productId, prev);
  }

  // Distribute invoice-level discount proportionally across purchase/purchase_return net costs if subtotal-discount differs from sum of item net costs
  const sumItemNet = Array.from(aggregated.values()).reduce((s, a) => s + a.netCostIrr, 0);
  const invoiceNetTotal = Math.max(0, Math.round(payload.grandTotal - payload.vatAmount));
  if (
    (payload.invoiceType === 'purchase' || payload.invoiceType === 'purchase_return') &&
    sumItemNet > 0 &&
    Math.abs(invoiceNetTotal - sumItemNet) > 0
  ) {
    const entries = Array.from(aggregated.entries());
    let allocated = 0;
    for (let i = 0; i < entries.length; i++) {
      const [pid, info] = entries[i];
      const isLast = i === entries.length - 1;
      const adjusted = isLast
        ? Math.max(0, invoiceNetTotal - allocated)
        : Math.round((invoiceNetTotal * info.netCostIrr) / sumItemNet);
      info.netCostIrr = adjusted;
      allocated += adjusted;
      aggregated.set(pid, info);
    }
  }

  const productMap = new Map(products.map((p) => [p.id, p]));
  const productDeltas = new Map<
    string,
    {
      stock: number;
      buyPrice: number;
      costLayers: InventoryCostLayer[];
      inventoryValueIrr: number;
      prevVersion: number;
    }
  >();
  const updatedProducts: Product[] = [];
  const liveUnitCostMap = new Map<string, number>();
  const liveTotalCostMap = new Map<string, number>();
  const liveConsumedLayersMap = new Map<string, ConsumedCostLayerAllocation[]>();
  let cogsTotal = 0;
  let purchaseReturnVarianceIrr = 0;

  if (payload.invoiceType !== 'proforma') {
    for (const [pid, info] of aggregated.entries()) {
      const prod = productMap.get(pid);
      if (!prod) continue;

      const currentState = normalizeProductCostState(
        prod,
        defaultCostingMethod,
        `${invoiceFiscalYear}/01/01`
      );

      // Historical cost lookup for sale_return from originalInvoice (if linked)
      const origSaleItem =
        payload.invoiceType === 'sale_return'
          ? originalInvoice?.items.find((it) => it.productId === pid)
          : undefined;
      const explicitItemUnitCost =
        payload.invoiceType === 'sale_return'
          ? payload.items.find((it) => it.productId === pid && it.unitCostSnapshot && it.unitCostSnapshot > 0)
              ?.unitCostSnapshot
          : undefined;

      const step = applyInventoryMovementStep(currentState, {
        id: invoiceId,
        date: payload.date,
        kind: payload.invoiceType,
        productId: pid,
        warehouse: payload.warehouse || prod.warehouse,
        qty: info.qty,
        totalCostIrr:
          payload.invoiceType === 'purchase' || payload.invoiceType === 'purchase_return'
            ? info.netCostIrr
            : undefined,
        unitCostIrr:
          payload.invoiceType === 'sale_return'
            ? origSaleItem?.unitCostSnapshot ?? explicitItemUnitCost
            : undefined,
        sourceRefId: originalInvoice?.id ?? payload.sourceInvoiceId,
        originalConsumedLayers: origSaleItem?.consumedLayers,
        allowNegativeStock,
      });

      if (
        payload.invoiceType === 'sale' ||
        payload.invoiceType === 'sale_return' ||
        payload.invoiceType === 'waste'
      ) {
        cogsTotal += step.cogsOrCostIrr;
      }
      if (payload.invoiceType === 'purchase_return') {
        purchaseReturnVarianceIrr += step.purchaseReturnVarianceIrr;
      }

      liveUnitCostMap.set(pid, step.effectiveUnitCostIrr);
      liveTotalCostMap.set(pid, step.cogsOrCostIrr);
      if (step.consumedLayers) {
        liveConsumedLayersMap.set(pid, step.consumedLayers);
      }

      const prevVersion = prod._version ?? 1;
      productDeltas.set(pid, {
        stock: step.nextState.stockQty,
        buyPrice: step.nextState.weightedAvgUnitCostIrr,
        costLayers: step.nextState.layers,
        inventoryValueIrr: step.nextState.totalValueIrr,
        prevVersion,
      });
      updatedProducts.push({
        ...prod,
        stock: step.nextState.stockQty,
        buyPrice: step.nextState.weightedAvgUnitCostIrr,
        costingMethod: step.nextState.costingMethod,
        costLayers: step.nextState.layers,
        inventoryValueIrr: step.nextState.totalValueIrr,
        _version: prevVersion + 1,
        updatedByDevice: deviceId,
      });
    }
  }

  const reconciledItems = payload.items.map((it) => {
    const prod = productMap.get(it.productId);
    const agg = aggregated.get(it.productId);
    const aggTotalCost = liveTotalCostMap.get(it.productId);
    const itemTotalCost =
      agg && aggTotalCost !== undefined && agg.qty > 0
        ? Math.round((aggTotalCost * it.quantity) / agg.qty)
        : undefined;
    const unitCost =
      payload.invoiceType === 'purchase'
        ? it.quantity > 0
          ? Math.round((Math.round(it.quantity * it.unitPrice) - (Number(it.discount) || 0)) / it.quantity)
          : it.unitPrice
        : (liveUnitCostMap.get(it.productId) ?? prod?.buyPrice ?? it.unitCostSnapshot ?? 0);
    return {
      ...it,
      unitCostSnapshot: unitCost,
      ...(itemTotalCost !== undefined ? { totalCostIrr: itemTotalCost } : {}),
      ...(liveConsumedLayersMap.has(it.productId)
        ? { consumedLayers: liveConsumedLayersMap.get(it.productId) }
        : {}),
    };
  });

  // 4. Build and strictly verify balanced double-entry accounting voucher
  let voucher: Voucher | undefined;
  let cheque: Cheque | undefined;

  if (payload.invoiceType !== 'proforma') {
    const lines = buildInvoiceVoucherLines(payload, cogsTotal, purchaseReturnVarianceIrr);
    if (lines.length >= 2) {
      const totalDebit = lines.reduce((s, l) => s + Math.max(0, Math.round(Number(l.debit) || 0)), 0);
      const totalCredit = lines.reduce((s, l) => s + Math.max(0, Math.round(Number(l.credit) || 0)), 0);
      if (Math.abs(totalDebit - totalCredit) > 0) {
        throw new Error(
          `خطای تراز سند اتوماتیک فاکتور (بدهکار: ${totalDebit} / بستانکار: ${totalCredit}). عملیات به صورت کامل لغو شد.`
        );
      }
      const isFx = Boolean(payload.currencyCode && payload.currencyCode !== 'IRR' && Number(payload.exchangeRate) > 0);
      const vType: Voucher['voucherType'] =
        payload.invoiceType === 'purchase' || payload.invoiceType === 'purchase_return'
          ? 'purchase'
          : payload.invoiceType === 'waste'
            ? 'general'
            : 'sales';
      const fxSuffix =
        isFx && payload.currencyCode && payload.exchangeRate
          ? ` (ارزی ${payload.currencyCode} @ نرخ ${payload.exchangeRate.toLocaleString('en-US')})`
          : '';
      const baseVoucher: Voucher = {
        id: voucherId,
        ownerId,
        voucherNumber: nextVoucherNumber,
        date: payload.date,
        fiscalYear: invoiceFiscalYear,
        description: `سند اتوماتیک فاکتور ${payload.invoiceNumber} — ${payload.partyName}${fxSuffix}`,
        voucherType: vType,
        status: 'permanent',
        totalDebit,
        totalCredit,
        ...(isFx && payload.currencyCode && payload.exchangeRate
          ? {
              currencyCode: payload.currencyCode,
              exchangeRate: Number(payload.exchangeRate),
            }
          : {}),
        referenceId: invoiceId,
        lines,
        _version: 1,
        updatedByDevice: deviceId,
      };
      voucher = {
        ...baseVoucher,
        integrityHash: computeVoucherIntegrityHash(baseVoucher),
      };
    }

    // 5. Build Sayadi Cheque record atomically if paidCheque > 0 (all 4 invoice types supported!)
    if (
      payload.paidCheque > 0 &&
      (payload.invoiceType === 'sale' ||
        payload.invoiceType === 'purchase' ||
        payload.invoiceType === 'sale_return' ||
        payload.invoiceType === 'purchase_return')
    ) {
      const normalizeSayadiDigits = (value: string) =>
        String(value ?? '')
          .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
          .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));
      const sayadiId = normalizeSayadiDigits(payload.chequeSayadiId ?? '').replace(/\D/g, '');
      const chequeIssueDate = normalizeSayadiDigits(payload.chequeIssueDate ?? '').trim().replace(/-/g, '/');
      const chequeDueDate = normalizeSayadiDigits(payload.chequeDueDate ?? '').trim().replace(/-/g, '/');
      const chequeSerial = String(payload.chequeSerial ?? '').trim();
      const chequeBankName = String(payload.chequeBankName ?? '').trim();
      if (!/^\d{16}$/.test(sayadiId)) {
        throw new Error('برای تسویه با چک، شناسه صیادی واقعی و ۱۶ رقمی الزامی است.');
      }
      if (!chequeSerial || !chequeBankName) {
        throw new Error('شماره سریال و نام بانک چک برای ثبت فاکتور الزامی است.');
      }
      if (
        !isValidShamsiDate(chequeIssueDate) ||
        !isValidShamsiDate(chequeDueDate) ||
        chequeDueDate < chequeIssueDate
      ) {
        throw new Error('تاریخ صدور یا سررسید چک معتبر نیست؛ سررسید نباید قبل از تاریخ صدور باشد.');
      }
      const cId = chequeId || `chq_inv_${invoiceId}`;
      const direction: Cheque['direction'] =
        payload.invoiceType === 'sale' || payload.invoiceType === 'purchase_return'
          ? 'receivable'
          : 'payable';
      cheque = {
        id: cId,
        ownerId,
        sayadiId,
        serial: chequeSerial.slice(0, 48),
        direction,
        partyId: payload.partyId,
        partyName: payload.partyName,
        bankName: chequeBankName.slice(0, 100),
        branch: 'ثبت از فاکتور',
        amount: Math.round(payload.paidCheque),
        issueDate: chequeIssueDate,
        dueDate: chequeDueDate,
        status: 'in_box',
        notes: `ثبت اتمیک بابت فاکتور ${payload.invoiceNumber}`,
        _version: 1,
        updatedByDevice: deviceId,
      };
    }
  }

  const invoice: Invoice = {
    ...payload,
    ...(cheque
      ? {
          chequeSayadiId: cheque.sayadiId,
          chequeSerial: cheque.serial,
          chequeBankName: cheque.bankName,
          chequeIssueDate: cheque.issueDate,
          chequeDueDate: cheque.dueDate,
        }
      : {}),
    items: reconciledItems,
    id: invoiceId,
    ownerId,
    voucherId: voucher?.id,
    _version: 1,
    updatedByDevice: deviceId,
  };

  return {
    updatedProducts,
    productDeltas,
    voucher,
    cheque,
    invoice,
    cogsTotal,
    purchaseReturnVarianceIrr,
    creditLimitWarning,
  };
}

// ============================================================================
// STAGE 2: VOUCHER CORE VALIDATION, INTEGRITY HASH & DUPLICATE DETECTION
// ============================================================================

function isJalaliLeapYear(year: number): boolean {
  // Break-year algorithm (Jalaali calendar), valid for the supported 1300–1500 range.
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  let jp = breaks[0];
  let jump = 0;
  for (let i = 1; i < breaks.length; i++) {
    const jm = breaks[i];
    jump = jm - jp;
    if (year < jm) break;
    jp = jm;
  }
  let n = year - jp;
  if (jump - n < 6) n = n - jump + Math.floor((jump + 4) / 33) * 33;
  let leap = (((n + 1) % 33) - 1) % 4;
  if (leap === -1) leap = 4;
  return leap === 0;
}

export function isValidShamsiDate(date: string): boolean {
  if (typeof date !== 'string') return false;
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(date.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1300 || year > 1500) return false;
  if (month < 1 || month > 12) return false;
  const maxDay = month <= 6 ? 31 : month <= 11 ? 30 : isJalaliLeapYear(year) ? 30 : 29;
  return day >= 1 && day <= maxDay;
}

export function extractFiscalYearFromDate(date: string): string {
  const match = /^(\d{4})\//.exec(String(date || '').trim());
  return match ? match[1] : '';
}

export function getNextFiscalYearVoucherNumber(
  fiscalYear: string,
  counters: Record<string, number> | undefined,
  fallbackMax: number
): number {
  const persisted = Number(counters?.[fiscalYear]);
  const cached = Number(fallbackMax);
  const persistedMax = Number.isFinite(persisted) && persisted > 0 ? Math.floor(persisted) : 0;
  const cachedMax = Number.isFinite(cached) && cached > 0 ? Math.floor(cached) : 0;
  return Math.max(persistedMax, cachedMax) + 1;
}



export function accountRequiresParty(accountCode: string, account?: Account): boolean {
  if (account?.requiresParty === true) return true;
  if (account?.requiresParty === false) return false;
  const code = String(accountCode || '').trim();
  return (
    code.startsWith('104') ||
    code.startsWith('301') ||
    code.startsWith('103') ||
    code.startsWith('302')
  );
}

function fnv1aHex(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic offline integrity seal over a voucher's financial contents.
 * Any post-finalization tampering of lines, amounts, dates, or voucherNumber invalidates this hash.
 */
export function computeVoucherIntegrityHash(
  v: Pick<Voucher, 'voucherNumber' | 'date' | 'voucherType' | 'totalDebit' | 'totalCredit' | 'lines'>
): string {
  const canonicalLines = v.lines
    .map(
      (l) =>
        `${String(l.accountCode).trim()}|${String(l.partyId || '').trim()}|${String(l.costCenterId || '').trim()}|${Math.round(Number(l.debit) || 0)}|${Math.round(Number(l.credit) || 0)}`
    )
    .join(';');
  const payload = `${v.voucherNumber}|${String(v.date).trim()}|${v.voucherType}|${Math.round(v.totalDebit)}|${Math.round(v.totalCredit)}|${canonicalLines}`;
  return `vseal_${fnv1aHex(payload, 0x811c9dc5)}${fnv1aHex(payload.split('').reverse().join(''), 0x9e3779b9)}`;
}

/**
 * Order-insensitive canonical fingerprint used to detect accidental duplicate vouchers on the same day.
 */
export function computeVoucherFingerprint(input: {
  date: string;
  voucherType: Voucher['voucherType'];
  lines: VoucherLine[];
}): string {
  const sortedLines = [...input.lines]
    .map(
      (l) =>
        `${String(l.accountCode).trim()}|${String(l.partyId || '').trim()}|${Math.round(Number(l.debit) || 0)}|${Math.round(Number(l.credit) || 0)}`
    )
    .sort()
    .join(';');
  const raw = `${String(input.date).trim()}|${input.voucherType}|${sortedLines}`;
  return `vfp_${fnv1aHex(raw, 0x811c9dc5)}${fnv1aHex(raw, 0x243f6a88)}`;
}

export interface VoucherValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedLines: VoucherLine[];
  totalDebit: number;
  totalCredit: number;
  fiscalYear: string;
  fingerprint: string;
}

function parseVoucherAmount(value: unknown): { valid: boolean; amount: number } {
  if (value === null || value === undefined || value === '') return { valid: true, amount: 0 };
  if (typeof value !== 'number' && typeof value !== 'string') return { valid: false, amount: 0 };
  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
      .replace(/[,٬،\s]/g, '');
    if (normalized === '') return { valid: true, amount: 0 };
    if (!/^\+?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, amount: 0 };
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed >= 0
      ? { valid: true, amount: Math.round(parsed) }
      : { valid: false, amount: 0 };
  }
  return Number.isFinite(value) && value >= 0
    ? { valid: true, amount: Math.round(value) }
    : { valid: false, amount: 0 };
}

export function validateVoucherPayload(input: {
  payload: {
    date: string;
    description: string;
    voucherType: Voucher['voucherType'];
    referenceId?: string;
    reversalOfVoucherId?: string;
    lines: VoucherLine[];
  };
  accounts: Account[];
  parties?: Party[];
  existingVouchers?: Voucher[];
  closedFiscalYears?: string[];
  ignoreVoucherId?: string;
  allowDuplicate?: boolean;
  isReversal?: boolean;
}): VoucherValidationResult {
  const {
    payload,
    accounts,
    parties,
    existingVouchers = [],
    closedFiscalYears = [],
    ignoreVoucherId,
    allowDuplicate = false,
    isReversal = false,
  } = input;

  const errors: string[] = [];
  const accountMap = new Map(accounts.map((a) => [a.code, a]));
  const partySet = parties ? new Set(parties.map((p) => p.id)) : null;

  if (!isValidShamsiDate(payload.date)) {
    errors.push(`تاریخ سند («${payload.date}») فرمت شمسی معتبر (YYYY/MM/DD) ندارد.`);
  }
  const fiscalYear = extractFiscalYearFromDate(payload.date);
  if (fiscalYear && closedFiscalYears.includes(fiscalYear)) {
    errors.push(`سال مالی ${fiscalYear} بسته شده است و ثبت یا ویرایش سند در آن مجاز نیست.`);
  }

  if (!Array.isArray(payload.lines) || payload.lines.length < 2) {
    errors.push('سند حسابداری باید حداقل دارای ۲ آرتیکل (یک بدهکار و یک بستانکار) باشد.');
  }

  const sanitizedLines: VoucherLine[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  (payload.lines || []).forEach((line, idx) => {
    const rowNum = idx + 1;
    const code = String(line.accountCode || '').trim();
    const acc = accountMap.get(code);
    if (!acc) {
      errors.push(`ردیف ${rowNum}: کد حساب «${code || 'خالی'}» در کدینگ حساب‌ها وجود ندارد.`);
    } else {
      if (acc.active === false) {
        errors.push(`ردیف ${rowNum}: حساب «${code} — ${acc.title}» غیرفعال است.`);
      }
      if (acc.level === 'group' || acc.level === 'kol') {
        errors.push(
          `ردیف ${rowNum}: ثبت سند روی حساب سطح ${acc.level === 'group' ? 'گروه' : 'کل'} («${code}») مجاز نیست؛ از حساب معین استفاده کنید.`
        );
      }
    }

    const parsedDebit = parseVoucherAmount(line.debit);
    const parsedCredit = parseVoucherAmount(line.credit);
    if (!parsedDebit.valid || !parsedCredit.valid) {
      errors.push(`ردیف ${rowNum}: مبلغ بدهکار یا بستانکار نامعتبر است؛ فقط عدد غیرمنفی مجاز است.`);
    }
    const d = parsedDebit.valid ? parsedDebit.amount : 0;
    const c = parsedCredit.valid ? parsedCredit.amount : 0;
    if (d === 0 && c === 0) {
      errors.push(`ردیف ${rowNum}: آرتیکل بدون مبلغ (بدهکار = ۰ و بستانکار = ۰) مجاز نیست.`);
    }
    if (d > 0 && c > 0) {
      errors.push(`ردیف ${rowNum}: یک آرتیکل نمی‌تواند هم‌زمان بدهکار و بستانکار باشد.`);
    }

    if (acc && accountRequiresParty(code, acc)) {
      if (!line.partyId || !String(line.partyId).trim()) {
        errors.push(`ردیف ${rowNum}: انتخاب طرف‌حساب (تفصیلی شخص) برای حساب «${code} — ${acc.title}» الزامی است.`);
      } else if (partySet && !partySet.has(line.partyId)) {
        errors.push(`ردیف ${rowNum}: طرف‌حساب انتخاب‌شده (${line.partyId}) در لیست اشخاص یافت نشد.`);
      }
    }

    totalDebit += d;
    totalCredit += c;
    sanitizedLines.push({
      ...line,
      accountCode: code,
      accountTitle: acc?.title || line.accountTitle,
      debit: d,
      credit: c,
    });
  });

  if (totalDebit <= 0 || totalCredit <= 0) {
    errors.push('جمع مبالغ سند حسابداری باید بزرگ‌تر از صفر ریال باشد.');
  } else if (totalDebit !== totalCredit) {
    errors.push(
      `سند تراز نیست! جمع بدهکار (${totalDebit.toLocaleString('en-US')}) با جمع بستانکار (${totalCredit.toLocaleString('en-US')}) اختلاف ${Math.abs(totalDebit - totalCredit).toLocaleString('en-US')} ریالی دارد.`
    );
  }

  // Duplicate referenceId check (e.g. two vouchers for one invoice)
  if (payload.referenceId && !isReversal && !payload.reversalOfVoucherId) {
    const dupRef = existingVouchers.find(
      (v) =>
        v.id !== ignoreVoucherId &&
        v.referenceId === payload.referenceId &&
        !v.reversalOfVoucherId
    );
    if (dupRef) {
      errors.push(
        `برای مرجع «${payload.referenceId}» قبلاً سند شماره #${dupRef.voucherNumber} ثبت شده است (جلوگیری از ثبت تکراری).`
      );
    }
  }

  const fingerprint = computeVoucherFingerprint({
    date: payload.date,
    voucherType: payload.voucherType,
    lines: sanitizedLines,
  });

  if (
    !allowDuplicate &&
    !isReversal &&
    !payload.reversalOfVoucherId &&
    payload.voucherType !== 'opening' &&
    payload.voucherType !== 'closing'
  ) {
    const dupSame = existingVouchers.find(
      (v) =>
        v.id !== ignoreVoucherId &&
        !v.reversalOfVoucherId &&
        computeVoucherFingerprint({
          date: v.date,
          voucherType: v.voucherType,
          lines: v.lines,
        }) === fingerprint
    );
    if (dupSame) {
      errors.push(
        `سند مشابهی دقیقاً با همین تاریخ و آرتیکل‌ها قبلاً با شماره #${dupSame.voucherNumber} ثبت شده است (جلوگیری از سند تکراری).`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedLines,
    totalDebit,
    totalCredit,
    fiscalYear,
    fingerprint,
  };
}

// ============================================================================
// STAGE 5: CHEQUE LIFECYCLE STATE MACHINE (RECEIVABLE & PAYABLE)
// ============================================================================

export interface ChequeTransitionPlan {
  ok: boolean;
  error?: string;
  description: string;
  lines: VoucherLine[];
  targetPartyId?: string;
}

export function planChequeStatusTransition(input: {
  cheque: Cheque;
  newStatus: Cheque['status'];
  accounts: Account[];
  parties: Party[];
  bankAccountCode?: string;
  endorsePartyId?: string;
}): ChequeTransitionPlan {
  const { cheque, newStatus, accounts, parties, bankAccountCode = '10201', endorsePartyId } = input;
  if (cheque.status === newStatus) {
    return { ok: false, error: 'وضعیت جدید چک با وضعیت فعلی آن یکسان است.', description: '', lines: [] };
  }

  const bankAcc = accounts.find((a) => a.code === bankAccountCode);
  const bankTitle = bankAcc?.title || 'بانک ملت — حساب جاری شرکتی';
  const amount = Math.round(Number(cheque.amount) || 0);
  if (amount <= 0) {
    return { ok: false, error: 'مبلغ چک برای تغییر وضعیت نامعتبر است.', description: '', lines: [] };
  }

  if (cheque.direction === 'receivable') {
    if (cheque.status === 'cleared' || cheque.status === 'cancelled') {
      return {
        ok: false,
        error: `چک دریافتنی با وضعیت نهایی «${cheque.status === 'cleared' ? 'پاس‌شده' : 'ابطال‌شده'}» قابل تغییر وضعیت نیست.`,
        description: '',
        lines: [],
      };
    }

    if (newStatus === 'deposited') {
      if (cheque.status !== 'in_box') {
        return {
          ok: false,
          error: 'فقط چک دریافتنی «در صندوق» می‌تواند به حساب بانکی واگذار شود.',
          description: '',
          lines: [],
        };
      }
      return {
        ok: true,
        description: `واگذاری چک صیادی ${cheque.sayadiId} به بانک جهت وصول`,
        lines: [
          {
            accountCode: '10302',
            accountTitle: 'اسناد دریافتنی در جریان وصول',
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `واگذاری چک ${cheque.serial} به ${bankTitle}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: '10301',
            accountTitle: 'اسناد دریافتنی نزد صندوق',
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `خروج چک ${cheque.serial} از صندوق`,
            debit: 0,
            credit: amount,
          },
        ],
      };
    }

    if (newStatus === 'in_box') {
      if (cheque.status === 'deposited') {
        return {
          ok: true,
          description: `استرداد چک صیادی ${cheque.sayadiId} از جریان وصول به صندوق`,
          lines: [
            {
              accountCode: '10301',
              accountTitle: 'اسناد دریافتنی نزد صندوق',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `بازگشت چک ${cheque.serial} از بانک به صندوق`,
              debit: amount,
              credit: 0,
            },
            {
              accountCode: '10302',
              accountTitle: 'اسناد دریافتنی در جریان وصول',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `خروج از جریان وصول چک ${cheque.serial}`,
              debit: 0,
              credit: amount,
            },
          ],
        };
      }
      if (cheque.status === 'bounced') {
        return {
          ok: true,
          description: `عودت چک برگشتی ${cheque.sayadiId} به صندوق جهت پیگیری مجدد`,
          lines: [
            {
              accountCode: '10301',
              accountTitle: 'اسناد دریافتنی نزد صندوق',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `دریافت مجدد چک ${cheque.serial}`,
              debit: amount,
              credit: 0,
            },
            {
              accountCode: '10401',
              accountTitle: 'بدهکاران تجاری و مشتریان',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `تعدیل بدهکاری مشتری بابت چک ${cheque.serial}`,
              debit: 0,
              credit: amount,
            },
          ],
        };
      }
      return {
        ok: false,
        error: 'بازگردانی این چک دریافتنی به صندوق از وضعیت فعلی مجاز نیست.',
        description: '',
        lines: [],
      };
    }

    if (newStatus === 'cleared') {
      if (cheque.status === 'endorsed') {
        // Endorsed cheque cleared directly at third party's bank: no cash enters our bank
        return {
          ok: true,
          description: `تأیید پاس شدن چک خرج‌شده ${cheque.sayadiId} نزد دارنده ثالث`,
          lines: [],
        };
      }
      if (cheque.status === 'bounced') {
        return {
          ok: true,
          description: `وصول نقدی/بانکی چک برگشتی ${cheque.sayadiId} — ${cheque.partyName}`,
          lines: [
            {
              accountCode: bankAccountCode,
              accountTitle: bankTitle,
              description: `واریز وجه چک برگشتی ${cheque.serial}`,
              debit: amount,
              credit: 0,
            },
            {
              accountCode: '10401',
              accountTitle: 'بدهکاران تجاری و مشتریان',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `تسویه بدهی چک برگشتی ${cheque.serial}`,
              debit: 0,
              credit: amount,
            },
          ],
        };
      }
      const creditAcc = cheque.status === 'deposited' ? '10302' : '10301';
      const creditTitle =
        cheque.status === 'deposited' ? 'اسناد دریافتنی در جریان وصول' : 'اسناد دریافتنی نزد صندوق';
      return {
        ok: true,
        description: `وصول (پاس شدن) چک دریافتنی ${cheque.sayadiId} — ${cheque.partyName}`,
        lines: [
          {
            accountCode: bankAccountCode,
            accountTitle: bankTitle,
            description: `واریز وجه چک ${cheque.serial}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: creditAcc,
            accountTitle: creditTitle,
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `بستن سند دریافتنی چک ${cheque.serial}`,
            debit: 0,
            credit: amount,
          },
        ],
      };
    }

    if (newStatus === 'endorsed') {
      if (cheque.status !== 'in_box') {
        return {
          ok: false,
          error: 'فقط چک دریافتنی «در صندوق» می‌تواند به تأمین‌کننده خرج (واگذار) شود.',
          description: '',
          lines: [],
        };
      }
      const targetParty =
        parties.find((p) => p.id === endorsePartyId) ||
        parties.find((p) => p.partyType === 'vendor' || p.partyType === 'both');
      if (!targetParty) {
        return {
          ok: false,
          error: 'برای خرج کردن چک، انتخاب طرف‌حساب مقصد (تأمین‌کننده) الزامی است.',
          description: '',
          lines: [],
        };
      }
      return {
        ok: true,
        targetPartyId: targetParty.id,
        description: `خرج کردن چک ${cheque.sayadiId} در وجه ${targetParty.name}`,
        lines: [
          {
            accountCode: '30101',
            accountTitle: 'بستانکاران و تأمین‌کنندگان',
            partyId: targetParty.id,
            partyName: targetParty.name,
            description: `تسویه بدهی با خرج چک ${cheque.serial}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: '10301',
            accountTitle: 'اسناد دریافتنی نزد صندوق',
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `خروج چک خرج‌شده ${cheque.serial} از صندوق`,
            debit: 0,
            credit: amount,
          },
        ],
      };
    }

    if (newStatus === 'bounced' || newStatus === 'cancelled') {
      if (cheque.status === 'endorsed') {
        if (newStatus === 'cancelled') {
          return {
            ok: false,
            error: 'چک خرج‌شده را نمی‌توان مستقیم ابطال کرد؛ ابتدا وضعیت برگشت آن را ثبت کنید.',
            description: '',
            lines: [],
          };
        }
        const endorsedTarget =
          parties.find((p) => p.id === endorsePartyId) ||
          parties.find((p) => p.partyType === 'vendor' || p.partyType === 'both');
        if (!endorsedTarget) {
          return {
            ok: false,
            error: 'برای برگشت چک خرج‌شده، تعیین تأمین‌کننده دارنده چک الزامی است.',
            description: '',
            lines: [],
          };
        }
        return {
          ok: true,
          description: `برگشت چک خرج‌شده ${cheque.sayadiId} (رجوع به صادرکننده ${cheque.partyName})`,
          lines: [
            {
              accountCode: '10401',
              accountTitle: 'بدهکاران تجاری و مشتریان',
              partyId: cheque.partyId,
              partyName: cheque.partyName,
              description: `بدهکارسازی صادرکننده بابت برگشت چک خرج‌شده ${cheque.serial}`,
              debit: amount,
              credit: 0,
            },
            {
              accountCode: '30101',
              accountTitle: 'بستانکاران و تأمین‌کنندگان',
              partyId: endorsedTarget.id,
              partyName: endorsedTarget.name,
              description: `بستانکارسازی دارنده چک بابت برگشت چک ${cheque.serial}`,
              debit: 0,
              credit: amount,
            },
          ],
        };
      }
      const creditAcc = cheque.status === 'deposited' ? '10302' : '10301';
      const creditTitle =
        cheque.status === 'deposited' ? 'اسناد دریافتنی در جریان وصول' : 'اسناد دریافتنی نزد صندوق';
      return {
        ok: true,
        description: `${newStatus === 'bounced' ? 'برگشت (واخواست)' : 'ابطال'} چک دریافتنی ${cheque.sayadiId} — ${cheque.partyName}`,
        lines: [
          {
            accountCode: '10401',
            accountTitle: 'بدهکاران تجاری و مشتریان',
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `بازگشت بدهی مشتری بابت چک ${cheque.serial}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: creditAcc,
            accountTitle: creditTitle,
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `خروج چک ${cheque.serial}`,
            debit: 0,
            credit: amount,
          },
        ],
      };
    }

    return { ok: false, error: 'تغییر وضعیت درخواستی برای چک دریافتنی مجاز نیست.', description: '', lines: [] };
  }

  // ---- PAYABLE CHEQUES ----
  if (cheque.status === 'cleared' || cheque.status === 'cancelled') {
    return {
      ok: false,
      error: `چک پرداختنی با وضعیت نهایی «${cheque.status === 'cleared' ? 'پاس‌شده' : 'ابطال‌شده'}» قابل تغییر وضعیت نیست.`,
      description: '',
      lines: [],
    };
  }
  if (newStatus === 'deposited' || newStatus === 'endorsed') {
    return {
      ok: false,
      error: 'چک پرداختنی صادره شرکت قابل واگذاری به وصول یا خرج کردن نیست.',
      description: '',
      lines: [],
    };
  }
  if (newStatus === 'cleared') {
    if (cheque.status === 'bounced') {
      // Already moved from 30201 back to 30101 on bounce — debit 30101 now so 30201 is NEVER double-debited!
      return {
        ok: true,
        description: `پرداخت و رفع سوءاثر چک پرداختنی برگشتی ${cheque.sayadiId} — ${cheque.partyName}`,
        lines: [
          {
            accountCode: '30101',
            accountTitle: 'بستانکاران و تأمین‌کنندگان',
            partyId: cheque.partyId,
            partyName: cheque.partyName,
            description: `تسویه بدهی چک برگشتی ${cheque.serial}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: bankAccountCode,
            accountTitle: bankTitle,
            description: `برداشت بانکی رفع سوءاثر چک ${cheque.serial}`,
            debit: 0,
            credit: amount,
          },
        ],
      };
    }
    return {
      ok: true,
      description: `پاس شدن چک پرداختنی ${cheque.sayadiId} در وجه ${cheque.partyName}`,
      lines: [
        {
          accountCode: '30201',
          accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
          partyId: cheque.partyId,
          partyName: cheque.partyName,
          description: `تسویه چک صادره ${cheque.serial}`,
          debit: amount,
          credit: 0,
        },
        {
          accountCode: bankAccountCode,
          accountTitle: bankTitle,
          description: `برداشت از حساب بابت چک ${cheque.serial}`,
          debit: 0,
          credit: amount,
        },
      ],
    };
  }
  if (newStatus === 'bounced' || newStatus === 'cancelled') {
    if (cheque.status !== 'in_box') {
      return {
        ok: false,
        error: 'فقط چک پرداختنی جاری (در جریان) می‌تواند برگشت یا ابطال شود.',
        description: '',
        lines: [],
      };
    }
    return {
      ok: true,
      description: `${newStatus === 'bounced' ? 'برگشت خوردن' : 'ابطال'} چک پرداختنی ${cheque.sayadiId} — ${cheque.partyName}`,
      lines: [
        {
          accountCode: '30201',
          accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
          partyId: cheque.partyId,
          partyName: cheque.partyName,
          description: `حذف سند پرداختنی چک ${cheque.serial}`,
          debit: amount,
          credit: 0,
        },
        {
          accountCode: '30101',
          accountTitle: 'بستانکاران و تأمین‌کنندگان',
          partyId: cheque.partyId,
          partyName: cheque.partyName,
          description: `بازگشت بدهی به ${cheque.partyName} بابت چک ${cheque.serial}`,
          debit: 0,
          credit: amount,
        },
      ],
    };
  }

  return { ok: false, error: 'تغییر وضعیت درخواستی برای چک پرداختنی مجاز نیست.', description: '', lines: [] };
}

// ============================================================================
// STAGE 6: GENERAL JOURNAL, CASH FLOW STATEMENT, VAT & COGS REPORTS
// ============================================================================

export interface GeneralJournalRow {
  voucherId: string;
  voucherNumber: number;
  date: string;
  voucherType: Voucher['voucherType'];
  accountCode: string;
  accountTitle: string;
  partyName?: string;
  description: string;
  debit: number;
  credit: number;
}

export function computeGeneralJournal(
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): GeneralJournalRow[] {
  const scoped = filterVouchersForReport(vouchers, options);
  const sorted = [...scoped].sort((a, b) => {
    const dc = a.date.localeCompare(b.date);
    return dc !== 0 ? dc : a.voucherNumber - b.voucherNumber;
  });
  const rows: GeneralJournalRow[] = [];
  for (const v of sorted) {
    for (const l of v.lines) {
      rows.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        voucherType: v.voucherType,
        accountCode: l.accountCode,
        accountTitle: l.accountTitle,
        partyName: l.partyName,
        description: l.description || v.description,
        debit: Math.round(Number(l.debit) || 0),
        credit: Math.round(Number(l.credit) || 0),
      });
    }
  }
  return rows;
}

export type CashFlowActivity = 'operating' | 'investing' | 'financing';

export interface CashFlowLine {
  voucherId: string;
  voucherNumber: number;
  date: string;
  activity: CashFlowActivity;
  counterpartCode: string;
  counterpartTitle: string;
  description: string;
  amount: number; // + inflow, - outflow
}

export interface CashFlowStatementSummary {
  openingCash: number;
  operatingInflows: number;
  operatingOutflows: number;
  netOperating: number;
  investingInflows: number;
  investingOutflows: number;
  netInvesting: number;
  financingInflows: number;
  financingOutflows: number;
  netFinancing: number;
  netCashChange: number;
  closingCash: number;
  glClosingCash: number;
  isReconciled: boolean;
  lines: CashFlowLine[];
}

function isCashOrBankAccount(code: string): boolean {
  return code.startsWith('101') || code.startsWith('102');
}

function classifyCashCounterpartActivity(code: string): CashFlowActivity {
  if (code.startsWith('2')) return 'investing'; // Fixed / non-current assets
  if (code.startsWith('4') || code.startsWith('5')) return 'financing'; // Long-term debt & equity
  return 'operating';
}

/**
 * Direct-Method Cash Flow Statement (Iranian Accounting Standard 2 / IAS 7).
 * Strictly guarantees: openingCash + netOperating + netInvesting + netFinancing === closingCash === GL(101*+102*).
 * Internal cash↔bank transfers net to 0 and do not distort operating cash flows.
 */
export function computeCashFlowStatement(
  accounts: Account[],
  vouchers: Voucher[],
  options?: LedgerFilterOptions
): CashFlowStatementSummary {
  const accountMap = new Map(accounts.map((a) => [a.code, a]));
  const scoped = filterVouchersForReport(vouchers, options);

  let openingCash = 0;
  let glClosingCash = 0;
  let operatingInflows = 0;
  let operatingOutflows = 0;
  let investingInflows = 0;
  let investingOutflows = 0;
  let financingInflows = 0;
  let financingOutflows = 0;
  const lines: CashFlowLine[] = [];

  for (const v of scoped) {
    let voucherCashNet = 0;
    for (const l of v.lines) {
      if (isCashOrBankAccount(l.accountCode)) {
        const net = (Number(l.debit) || 0) - (Number(l.credit) || 0);
        voucherCashNet += net;
        glClosingCash += net;
      }
    }

    if (v.voucherType === 'opening') {
      openingCash += voucherCashNet;
      continue;
    }

    // Skip vouchers with 0 net cash impact (including pure cash↔bank transfers!)
    if (voucherCashNet === 0) continue;

    // Identify non-cash counterpart lines on the opposite side of cash movement
    const isInflow = voucherCashNet > 0;
    const counterparts = v.lines
      .filter((l) => !isCashOrBankAccount(l.accountCode))
      .map((l) => {
        const weight = isInflow ? Number(l.credit) || 0 : Number(l.debit) || 0;
        return { line: l, weight };
      })
      .filter((c) => c.weight > 0);

    const totalWeight = counterparts.reduce((s, c) => s + c.weight, 0);

    if (counterparts.length === 0 || totalWeight <= 0) {
      // Fallback: assign directly to operating
      if (isInflow) operatingInflows += voucherCashNet;
      else operatingOutflows += Math.abs(voucherCashNet);
      lines.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        activity: 'operating',
        counterpartCode: '10101',
        counterpartTitle: 'جریان نقدی عملیاتی',
        description: v.description,
        amount: voucherCashNet,
      });
      continue;
    }

    // Allocate exact integer Rial cash flow across counterparts (exact residual on last line)
    let remainingCash = Math.abs(voucherCashNet);
    for (let i = 0; i < counterparts.length; i++) {
      const { line, weight } = counterparts[i];
      const isLast = i === counterparts.length - 1;
      const portion = isLast
        ? remainingCash
        : Math.min(remainingCash, Math.round((Math.abs(voucherCashNet) * weight) / totalWeight));
      remainingCash -= portion;
      if (portion === 0) continue;

      const signedAmount = isInflow ? portion : -portion;
      const activity = classifyCashCounterpartActivity(line.accountCode);
      if (activity === 'operating') {
        if (isInflow) operatingInflows += portion;
        else operatingOutflows += portion;
      } else if (activity === 'investing') {
        if (isInflow) investingInflows += portion;
        else investingOutflows += portion;
      } else {
        if (isInflow) financingInflows += portion;
        else financingOutflows += portion;
      }

      lines.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        activity,
        counterpartCode: line.accountCode,
        counterpartTitle: accountMap.get(line.accountCode)?.title || line.accountTitle,
        description: line.description || v.description,
        amount: signedAmount,
      });
    }
  }

  const netOperating = operatingInflows - operatingOutflows;
  const netInvesting = investingInflows - investingOutflows;
  const netFinancing = financingInflows - financingOutflows;
  const netCashChange = netOperating + netInvesting + netFinancing;
  const closingCash = openingCash + netCashChange;

  return {
    openingCash,
    operatingInflows,
    operatingOutflows,
    netOperating,
    investingInflows,
    investingOutflows,
    netInvesting,
    financingInflows,
    financingOutflows,
    netFinancing,
    netCashChange,
    closingCash,
    glClosingCash,
    isReconciled: closingCash === glClosingCash,
    lines,
  };
}

export interface VatSummaryReport {
  fiscalYear?: string;
  salesNet: number;
  salesReturnsNet: number;
  salesVat: number;
  purchasesNet: number;
  purchaseReturnsNet: number;
  purchasesVat: number;
  netVatPayable: number; // + payable to tax org, - refundable credit
  glSalesVat: number;
  glPurchasesVat: number;
  isReconciled: boolean;
}

export function computeVatSummaryReport(
  invoices: Invoice[],
  trialBalance: TrialBalanceRow[],
  fiscalYear?: string
): VatSummaryReport {
  const fyPrefix = fiscalYear ? `${String(fiscalYear).trim()}/` : '';
  const active = invoices.filter(
    (i) =>
      i.status !== 'cancelled' &&
      i.invoiceType !== 'proforma' &&
      (!fyPrefix || (typeof i.date === 'string' && i.date.startsWith(fyPrefix)))
  );

  let salesNet = 0;
  let salesReturnsNet = 0;
  let salesVat = 0;
  let purchasesNet = 0;
  let purchaseReturnsNet = 0;
  let purchasesVat = 0;

  for (const inv of active) {
    const net = Math.max(0, Math.round(inv.subtotal - inv.discount));
    if (inv.invoiceType === 'sale') {
      salesNet += net;
      salesVat += Math.round(inv.vatAmount);
    } else if (inv.invoiceType === 'sale_return') {
      salesReturnsNet += net;
      salesVat -= Math.round(inv.vatAmount);
    } else if (inv.invoiceType === 'purchase') {
      purchasesNet += net;
      purchasesVat += Math.round(inv.vatAmount);
    } else if (inv.invoiceType === 'purchase_return') {
      purchaseReturnsNet += net;
      purchasesVat -= Math.round(inv.vatAmount);
    }
  }

  const gl30301 = trialBalance.find((r) => r.accountCode === '30301');
  const gl30302 = trialBalance.find((r) => r.accountCode === '30302');
  const glSalesVat = gl30301 ? gl30301.balanceCredit - gl30301.balanceDebit : 0;
  const glPurchasesVat = gl30302 ? gl30302.balanceDebit - gl30302.balanceCredit : 0;

  return {
    fiscalYear,
    salesNet,
    salesReturnsNet,
    salesVat,
    purchasesNet,
    purchaseReturnsNet,
    purchasesVat,
    netVatPayable: salesVat - purchasesVat,
    glSalesVat,
    glPurchasesVat,
    isReconciled: Math.abs(salesVat - glSalesVat) < 10 && Math.abs(purchasesVat - glPurchasesVat) < 10,
  };
}

// ============================================================================
// STAGE 7: FISCAL YEAR CLOSING & NEXT-YEAR OPENING BALANCE CARRY-FORWARD
// ============================================================================

export interface YearEndClosingPlan {
  closingVoucher: Voucher;
  nextYearOpeningVoucher: Voucher;
  netProfit: number;
  closedFiscalYear: string;
  nextFiscalYear: string;
}

export function planYearEndClosing(input: {
  accounts: Account[];
  vouchers: Voucher[];
  fiscalYear: string;
  nextVoucherNumber: number;
  ownerId: string;
  deviceId: string;
  closedFiscalYears?: string[];
  allowWithDrafts?: boolean;
}): YearEndClosingPlan {
  const {
    accounts,
    vouchers,
    fiscalYear,
    nextVoucherNumber,
    ownerId,
    deviceId,
    closedFiscalYears = [],
    allowWithDrafts = false,
  } = input;

  const fy = String(fiscalYear || '').trim();
  if (!/^\d{4}$/.test(fy)) {
    throw new Error('سال مالی انتخاب‌شده جهت بستن حساب‌ها نامعتبر است.');
  }
  if (closedFiscalYears.includes(fy)) {
    throw new Error(`سال مالی ${fy} قبلاً بسته و قفل شده است.`);
  }

  const fyVouchers = vouchers.filter((v) => v.date.startsWith(`${fy}/`));
  if (fyVouchers.some((v) => v.voucherType === 'closing' && v.status === 'permanent')) {
    throw new Error(`سند اختتامیه سال مالی ${fy} قبلاً صادر شده است.`);
  }
  if (!allowWithDrafts) {
    const draftCount = fyVouchers.filter((v) => v.status === 'draft').length;
    if (draftCount > 0) {
      throw new Error(
        `امکان بستن سال مالی ${fy} وجود ندارد: ${draftCount} سند موقت (Draft) هنوز دائم نشده است.`
      );
    }
  }

  const tb = computeTrialBalance(accounts, vouchers, {
    includeDrafts: false,
    fiscalYear: fy,
    excludeClosing: true,
  });

  const closingLines: VoucherLine[] = [];
  let totalClosingDebit = 0;
  let totalClosingCredit = 0;

  for (const row of tb) {
    if (row.category === 'revenue' || row.category === 'cogs' || row.category === 'expense') {
      if (row.balanceCredit > 0) {
        closingLines.push({
          accountCode: row.accountCode,
          accountTitle: row.accountTitle,
          description: `بستن حساب موقت سال مالی ${fy}`,
          debit: row.balanceCredit,
          credit: 0,
        });
        totalClosingDebit += row.balanceCredit;
      } else if (row.balanceDebit > 0) {
        closingLines.push({
          accountCode: row.accountCode,
          accountTitle: row.accountTitle,
          description: `بستن حساب موقت سال مالی ${fy}`,
          debit: 0,
          credit: row.balanceDebit,
        });
        totalClosingCredit += row.balanceDebit;
      }
    }
  }

  const netProfit = totalClosingDebit - totalClosingCredit;
  if (closingLines.length === 0) {
    throw new Error(`هیچ حساب موقت (درآمد/هزینه) با مانده باز در سال مالی ${fy} یافت نشد.`);
  }

  if (netProfit > 0) {
    closingLines.push({
      accountCode: '50201',
      accountTitle: 'سود (زیان) انباشته',
      description: `انتقال سود خالص سال مالی ${fy} به سود انباشته`,
      debit: 0,
      credit: netProfit,
    });
  } else if (netProfit < 0) {
    closingLines.push({
      accountCode: '50201',
      accountTitle: 'سود (زیان) انباشته',
      description: `انتقال زیان خالص سال مالی ${fy} به سود (زیان) انباشته`,
      debit: Math.abs(netProfit),
      credit: 0,
    });
  }

  const closeTotalD = closingLines.reduce((s, l) => s + l.debit, 0);
  const closeTotalC = closingLines.reduce((s, l) => s + l.credit, 0);
  if (closeTotalD !== closeTotalC) {
    throw new Error('خطای داخلی در تراز سند اختتامیه.');
  }

  const baseClosingVoucher: Voucher = {
    id: `vch_close_${fy}_${Date.now()}`,
    ownerId,
    voucherNumber: nextVoucherNumber,
    date: `${fy}/12/29`,
    fiscalYear: fy,
    description: `سند اختتامیه و بستن حساب‌های موقت سال مالی ${fy}`,
    voucherType: 'closing',
    status: 'permanent',
    totalDebit: closeTotalD,
    totalCredit: closeTotalC,
    lines: closingLines,
    _version: 1,
    updatedByDevice: deviceId,
  };
  const closingVoucher: Voucher = {
    ...baseClosingVoucher,
    integrityHash: computeVoucherIntegrityHash(baseClosingVoucher),
  };

  // Build balanced Next-Year Opening Balance Voucher preserving per-party AR/AP/Cheque subledgers!
  const nextFiscalYear = String(Number(fy) + 1);
  const postClosingVouchers = [...vouchers, closingVoucher];
  const postClosingTb = computeTrialBalance(accounts, postClosingVouchers, {
    includeDrafts: false,
    fiscalYear: fy,
  });

  // Compute per-party balances for party-required permanent accounts (104*, 301*, 103*, 302*)
  const partySubBuckets = new Map<
    string,
    Map<string, { partyName: string; net: number }>
  >();
  const officialClosedVouchers = filterVouchersForReport(postClosingVouchers, {
    includeDrafts: false,
    fiscalYear: fy,
  });
  for (const v of officialClosedVouchers) {
    for (const l of v.lines) {
      if (!accountRequiresParty(l.accountCode)) continue;
      const partyKey = l.partyId || '__unassigned__';
      const byParty = partySubBuckets.get(l.accountCode) || new Map();
      const prev = byParty.get(partyKey) || { partyName: l.partyName || '', net: 0 };
      prev.net += (Number(l.debit) || 0) - (Number(l.credit) || 0);
      if (l.partyName && !prev.partyName) prev.partyName = l.partyName;
      byParty.set(partyKey, prev);
      partySubBuckets.set(l.accountCode, byParty);
    }
  }

  const openingLines: VoucherLine[] = [];
  for (const row of postClosingTb) {
    if (row.category !== 'asset' && row.category !== 'liability' && row.category !== 'equity') continue;
    if (row.balanceDebit === 0 && row.balanceCredit === 0) continue;

    if (accountRequiresParty(row.accountCode) && partySubBuckets.has(row.accountCode)) {
      const byParty = partySubBuckets.get(row.accountCode)!;
      for (const [partyKey, info] of byParty.entries()) {
        if (info.net === 0) continue;
        openingLines.push({
          accountCode: row.accountCode,
          accountTitle: row.accountTitle,
          ...(partyKey !== '__unassigned__' ? { partyId: partyKey, partyName: info.partyName } : {}),
          description: `نقل مانده افتتاحیه از سال مالی ${fy}`,
          debit: info.net > 0 ? info.net : 0,
          credit: info.net < 0 ? Math.abs(info.net) : 0,
        });
      }
    } else {
      openingLines.push({
        accountCode: row.accountCode,
        accountTitle: row.accountTitle,
        description: `نقل مانده افتتاحیه از سال مالی ${fy}`,
        debit: row.balanceDebit,
        credit: row.balanceCredit,
      });
    }
  }

  const openTotalD = openingLines.reduce((s, l) => s + l.debit, 0);
  const openTotalC = openingLines.reduce((s, l) => s + l.credit, 0);
  if (openTotalD !== openTotalC) {
    throw new Error(
      `خطای تراز سند افتتاحیه سال ${nextFiscalYear} (بدهکار: ${openTotalD} / بستانکار: ${openTotalC}).`
    );
  }

  const baseOpeningVoucher: Voucher = {
    id: `vch_open_${nextFiscalYear}_${Date.now()}`,
    ownerId,
    voucherNumber: 1,
    date: `${nextFiscalYear}/01/01`,
    fiscalYear: nextFiscalYear,
    description: `سند افتتاحیه سال مالی ${nextFiscalYear} (نقل مانده از سال ${fy})`,
    voucherType: 'opening',
    status: 'permanent',
    totalDebit: openTotalD,
    totalCredit: openTotalC,
    lines: openingLines,
    _version: 1,
    updatedByDevice: deviceId,
  };
  const nextYearOpeningVoucher: Voucher = {
    ...baseOpeningVoucher,
    integrityHash: computeVoucherIntegrityHash(baseOpeningVoucher),
  };

  return {
    closingVoucher,
    nextYearOpeningVoucher,
    netProfit,
    closedFiscalYear: fy,
    nextFiscalYear,
  };
}

// ============================================================================
// STAGE 8: COMPLETE DOCUMENT LIFECYCLE PLANNERS (PROFORMA -> SALE, CANCELLATION, STOCKTAKE)
// ============================================================================

export interface ProformaConversionInput {
  proforma: Invoice;
  conversionDate: string;
  products: Product[];
  parties: Party[];
  existingInvoices: Invoice[];
  existingVouchers: Voucher[];
  costingMethod?: InventoryCostingMethod;
  allowNegativeStock?: boolean;
  closedFiscalYears?: string[];
  ownerId: string;
  voucherId: string;
  nextVoucherNumber: number;
  chequeId?: string;
  deviceId?: string;
  partyBalances?: Map<string, number>;
}

/**
 * Atomically plans converting a Proforma invoice into a finalized Sale invoice.
 * Reuses `planAtomicInvoiceCommit` so FIFO/MWA `costLayers`, `inventoryValueIrr`,
 * Sayadi receivable cheques (`paidCheque > 0`), fiscal-year locks, and sealed
 * double-entry vouchers stay 100% synchronized with GL 10501 / 70101 / 10301.
 */
export function planProformaToSaleConversion(input: ProformaConversionInput): AtomicInvoicePlanResult {
  const {
    proforma,
    conversionDate,
    products,
    parties,
    existingInvoices,
    existingVouchers,
    costingMethod = 'fifo',
    allowNegativeStock = false,
    closedFiscalYears = [],
    ownerId,
    voucherId,
    nextVoucherNumber,
    chequeId,
    deviceId = 'local_device',
    partyBalances,
  } = input;

  if (proforma.invoiceType !== 'proforma') {
    throw new Error('فقط اسناد از نوع «پیش‌فاکتور» قابل تبدیل به فاکتور فروش قطعی هستند.');
  }
  if (proforma.status === 'cancelled') {
    throw new Error('پیش‌فاکتور ابطال‌شده قابل تبدیل به فاکتور فروش نیست.');
  }
  if (!isValidShamsiDate(conversionDate)) {
    throw new Error(`تاریخ تبدیل پیش‌فاکتور («${conversionDate}») فرمت شمسی معتبر (YYYY/MM/DD) ندارد.`);
  }

  const baseSaleNumber = proforma.invoiceNumber.startsWith('PF-')
    ? proforma.invoiceNumber.replace(/^PF-/, 'F-')
    : `F-${proforma.invoiceNumber}`;
  const otherInvoices = existingInvoices.filter((i) => i.id !== proforma.id);

  let finalSaleNumber = baseSaleNumber;
  let suffix = 2;
  while (
    otherInvoices.some(
      (i) => i.status !== 'cancelled' && i.invoiceNumber.trim() === finalSaleNumber.trim()
    )
  ) {
    finalSaleNumber = `${baseSaleNumber}-${suffix++}`;
  }

  const normalizedStatus: Invoice['status'] = proforma.creditAmount <= 0 ? 'settled' : 'issued';
  const matchedParty = parties.find((p) => p.id === proforma.partyId);
  const currentPartyBalance = partyBalances?.get(proforma.partyId) ?? 0;

  const { id: _oldId, ownerId: _oldOwner, voucherId: _oldVId, ...restProforma } = proforma;

  const plan = planAtomicInvoiceCommit({
    payload: {
      ...restProforma,
      invoiceNumber: finalSaleNumber,
      invoiceType: 'sale',
      date: conversionDate,
      status: normalizedStatus,
    },
    products,
    party: matchedParty,
    currentPartyBalance,
    existingInvoices: otherInvoices,
    existingVouchers,
    defaultCostingMethod: costingMethod,
    allowNegativeStock,
    closedFiscalYears,
    ownerId,
    invoiceId: proforma.id,
    voucherId,
    nextVoucherNumber,
    chequeId,
    deviceId,
  });

  const prevVersion = proforma._version ?? 1;
  plan.invoice = {
    ...plan.invoice,
    _version: prevVersion + 1,
  };

  return plan;
}

export interface InvoiceCancellationPlan {
  updatedProducts: Product[];
  productDeltas: Map<
    string,
    {
      stock: number;
      buyPrice: number;
      costLayers: InventoryCostLayer[];
      inventoryValueIrr: number;
      prevVersion: number;
    }
  >;
  reversalVoucher?: Voucher;
  chequeIdsToCancel: string[];
}

/**
 * Atomically plans cancelling an invoice with full accounting & inventory integrity:
 * 1. Enforces closed fiscal year boundaries.
 * 2. Blocks cancellation if any linked Sayadi cheque is already deposited, endorsed, or cleared.
 * 3. Reverts `stock`, `buyPrice`, `costLayers`, and `inventoryValueIrr` to match GL 10501 reversal to 0 Rial.
 * 4. Builds a sealed reversing voucher with `reversalOfVoucherId` set so audit never flags duplicate `referenceId`.
 */
export function planInvoiceCancellation(input: {
  invoice: Invoice;
  cancellationDate: string;
  products: Product[];
  vouchers: Voucher[];
  cheques: Cheque[];
  costingMethod?: InventoryCostingMethod;
  closedFiscalYears?: string[];
  ownerId: string;
  reversalVoucherId: string;
  nextVoucherNumber: number;
  deviceId?: string;
}): InvoiceCancellationPlan {
  const {
    invoice,
    cancellationDate,
    products,
    vouchers,
    cheques,
    costingMethod = 'fifo',
    closedFiscalYears = [],
    ownerId,
    reversalVoucherId,
    nextVoucherNumber,
    deviceId = 'local_device',
  } = input;

  if (invoice.status === 'cancelled') {
    throw new Error('این فاکتور قبلاً ابطال شده است.');
  }
  if (!isValidShamsiDate(cancellationDate)) {
    throw new Error(`تاریخ ابطال فاکتور («${cancellationDate}») فرمت شمسی معتبر ندارد.`);
  }

  const invFy = extractFiscalYearFromDate(invoice.date);
  const cancelFy = extractFiscalYearFromDate(cancellationDate);
  if (invFy && closedFiscalYears.includes(invFy)) {
    throw new Error(
      `فاکتور ${invoice.invoiceNumber} متعلق به سال مالی بسته‌شده ${invFy} است و قابل ابطال نیست؛ از فاکتور برگشت استفاده کنید.`
    );
  }
  if (cancelFy && closedFiscalYears.includes(cancelFy)) {
    throw new Error(`سال مالی ${cancelFy} بسته شده است و ثبت سند ابطال در آن مجاز نیست.`);
  }

  const linkedCheques = cheques.filter(
    (c) =>
      c.status !== 'cancelled' &&
      (c.id === `chq_inv_${invoice.id}` ||
        (Boolean(c.notes) && c.notes!.includes(invoice.invoiceNumber)))
  );
  const progressedCheque = linkedCheques.find(
    (c) => c.status === 'deposited' || c.status === 'endorsed' || c.status === 'cleared'
  );
  if (progressedCheque) {
    const statusLabel =
      progressedCheque.status === 'cleared'
        ? 'پاس‌شده'
        : progressedCheque.status === 'deposited'
          ? 'واگذارشده به بانک'
          : 'خرج‌شده';
    throw new Error(
      `چک صیادی مرتبط (${progressedCheque.sayadiId}) در وضعیت «${statusLabel}» است. ابتدا وضعیت چک را در خزانه‌داری اصلاح یا از فاکتور برگشت استفاده کنید.`
    );
  }
  const chequeIdsToCancel = linkedCheques
    .filter((c) => c.status === 'in_box')
    .map((c) => c.id);

  if (invoice.invoiceType === 'proforma') {
    return {
      updatedProducts: [],
      productDeltas: new Map(),
      reversalVoucher: undefined,
      chequeIdsToCancel,
    };
  }

  const origVoucher = vouchers.find(
    (v) =>
      v.id === invoice.voucherId ||
      (v.referenceId === invoice.id && !v.reversalOfVoucherId)
  );

  const productMap = new Map(products.map((p) => [p.id, p]));
  const aggByProd = new Map<
    string,
    {
      qty: number;
      netPurchaseCostIrr: number;
      recordedCostIrr: number;
      hasRecordedCost: boolean;
      weightedUnitCostIrr: number;
      consumedLayers: ConsumedCostLayerAllocation[];
    }
  >();

  for (const it of invoice.items) {
    const netPurchase = Math.max(
      0,
      Math.round(it.quantity * it.unitPrice) - Math.round(it.discount || 0)
    );
    const prev = aggByProd.get(it.productId) ?? {
      qty: 0,
      netPurchaseCostIrr: 0,
      recordedCostIrr: 0,
      hasRecordedCost: false,
      weightedUnitCostIrr: it.unitCostSnapshot ?? 0,
      consumedLayers: [],
    };
    const nextQty = roundQty(prev.qty + it.quantity);
    const hasCost = typeof it.totalCostIrr === 'number' && Number.isFinite(it.totalCostIrr);
    const itemCost = hasCost
      ? Math.max(0, Math.round(it.totalCostIrr!))
      : Math.max(
          0,
          Math.round(it.quantity * (it.unitCostSnapshot ?? productMap.get(it.productId)?.buyPrice ?? 0))
        );
    prev.qty = nextQty;
    prev.netPurchaseCostIrr += netPurchase;
    prev.recordedCostIrr += itemCost;
    prev.hasRecordedCost = prev.hasRecordedCost || hasCost;
    prev.weightedUnitCostIrr =
      nextQty > 0 ? Math.round(prev.recordedCostIrr / nextQty) : prev.weightedUnitCostIrr;
    if (Array.isArray(it.consumedLayers) && it.consumedLayers.length > 0) {
      prev.consumedLayers.push(...it.consumedLayers);
    }
    aggByProd.set(it.productId, prev);
  }

  const updatedProducts: Product[] = [];
  const productDeltas = new Map<
    string,
    {
      stock: number;
      buyPrice: number;
      costLayers: InventoryCostLayer[];
      inventoryValueIrr: number;
      prevVersion: number;
    }
  >();

  for (const [pid, agg] of aggByProd.entries()) {
    const prod = productMap.get(pid);
    if (!prod || agg.qty <= 0) continue;

    const currentState = normalizeProductCostState(prod, costingMethod, cancellationDate);
    let nextQty = currentState.stockQty;
    let nextLayers: InventoryCostLayer[] = currentState.layers.map((l) => ({ ...l }));
    let nextTotalValueIrr = currentState.totalValueIrr;
    let nextWeightedAvg = currentState.weightedAvgUnitCostIrr;

    if (invoice.invoiceType === 'sale' || invoice.invoiceType === 'waste') {
      const step = applyInventoryMovementStep(currentState, {
        id: `cancel_${invoice.id}_${pid}`,
        date: cancellationDate,
        kind: 'sale_return',
        productId: prod.id,
        warehouse: prod.warehouse,
        qty: agg.qty,
        totalCostIrr: agg.recordedCostIrr,
        unitCostIrr: agg.weightedUnitCostIrr || prod.buyPrice,
        sourceRefId: invoice.id,
        originalConsumedLayers: agg.consumedLayers.length > 0 ? agg.consumedLayers : undefined,
        allowNegativeStock: true,
      });
      nextQty = step.nextState.stockQty;
      nextLayers = step.nextState.layers;
      nextTotalValueIrr = step.nextState.totalValueIrr;
      nextWeightedAvg = step.nextState.weightedAvgUnitCostIrr;
    } else if (invoice.invoiceType === 'purchase' || invoice.invoiceType === 'sale_return') {
      if (currentState.stockQty + 0.001 < agg.qty) {
        throw new Error(
          `امکان ابطال فاکتور ${invoice.invoiceNumber} وجود ندارد؛ بخشی از موجودی «${prod.name}» قبلاً فروخته یا مصرف شده است (موجودی فعلی: ${currentState.stockQty}، مقدار فاکتور: ${agg.qty}).`
        );
      }

      const targetRemovalCostIrr =
        invoice.invoiceType === 'purchase' ? agg.netPurchaseCostIrr : agg.recordedCostIrr;

      const matchingLayers = nextLayers.filter((l) => l.sourceRef === invoice.id);
      const matchingQty = roundQty(matchingLayers.reduce((s, l) => s + l.remainingQty, 0));

      if (matchingQty + 0.001 >= agg.qty) {
        let toRemove = agg.qty;
        const rebuilt: InventoryCostLayer[] = [];
        for (const layer of nextLayers) {
          if (layer.sourceRef === invoice.id && toRemove > 0.0001) {
            const take = Math.min(layer.remainingQty, toRemove);
            const rem = roundQty(layer.remainingQty - take);
            toRemove = roundQty(toRemove - take);
            if (rem > 0.0001) {
              const remVal = Math.max(
                0,
                layer.totalCostIrr - Math.round((layer.totalCostIrr * take) / layer.remainingQty)
              );
              rebuilt.push({
                ...layer,
                remainingQty: rem,
                totalCostIrr: remVal,
                unitCostIrr: Math.round(remVal / rem),
              });
            }
          } else {
            rebuilt.push(layer);
          }
        }
        nextLayers = rebuilt;
        nextQty = roundQty(currentState.stockQty - agg.qty);
        nextTotalValueIrr = Math.max(0, currentState.totalValueIrr - targetRemovalCostIrr);
        if (nextLayers.length > 0) {
          const layersSum = nextLayers.reduce((s, l) => s + l.totalCostIrr, 0);
          const drift = nextTotalValueIrr - layersSum;
          if (drift !== 0) {
            const last = nextLayers[nextLayers.length - 1];
            last.totalCostIrr = Math.max(0, last.totalCostIrr + drift);
            last.unitCostIrr =
              last.remainingQty > 0
                ? Math.round(last.totalCostIrr / last.remainingQty)
                : last.unitCostIrr;
          }
        }
        nextWeightedAvg =
          nextQty > 0 ? Math.round(nextTotalValueIrr / nextQty) : currentState.weightedAvgUnitCostIrr;
      } else {
        nextQty = roundQty(currentState.stockQty - agg.qty);
        nextTotalValueIrr = Math.max(0, currentState.totalValueIrr - targetRemovalCostIrr);
        nextWeightedAvg =
          nextQty > 0 ? Math.round(nextTotalValueIrr / nextQty) : currentState.weightedAvgUnitCostIrr;
        nextLayers =
          nextQty > 0
            ? [
                {
                  layerId: `lyr_cancel_${invoice.id}_${pid}`,
                  date: cancellationDate,
                  sourceRef: `cancel_${invoice.id}`,
                  warehouse: prod.warehouse,
                  originalQty: nextQty,
                  remainingQty: nextQty,
                  unitCostIrr: nextWeightedAvg,
                  totalCostIrr: nextTotalValueIrr,
                },
              ]
            : [];
      }
    } else if (invoice.invoiceType === 'purchase_return') {
      const restoreCost = agg.hasRecordedCost ? agg.recordedCostIrr : agg.netPurchaseCostIrr;
      const step = applyInventoryMovementStep(currentState, {
        id: `cancel_${invoice.id}_${pid}`,
        date: cancellationDate,
        kind: 'surplus',
        productId: prod.id,
        warehouse: prod.warehouse,
        qty: agg.qty,
        totalCostIrr: restoreCost,
        unitCostIrr: agg.qty > 0 ? Math.round(restoreCost / agg.qty) : prod.buyPrice,
        sourceRefId: `cancel_${invoice.id}`,
        allowNegativeStock: true,
      });
      nextQty = step.nextState.stockQty;
      nextLayers = step.nextState.layers;
      nextTotalValueIrr = step.nextState.totalValueIrr;
      nextWeightedAvg = step.nextState.weightedAvgUnitCostIrr;
    }

    const prevVersion = prod._version ?? 1;
    productDeltas.set(pid, {
      stock: nextQty,
      buyPrice: nextWeightedAvg,
      costLayers: nextLayers,
      inventoryValueIrr: nextTotalValueIrr,
      prevVersion,
    });
    updatedProducts.push({
      ...prod,
      stock: nextQty,
      buyPrice: nextWeightedAvg,
      costingMethod: currentState.costingMethod,
      costLayers: nextLayers,
      inventoryValueIrr: nextTotalValueIrr,
      _version: prevVersion + 1,
      updatedByDevice: deviceId,
    });
  }

  let reversalVoucher: Voucher | undefined;
  if (origVoucher && origVoucher.lines.length >= 2) {
    const revLines: VoucherLine[] = origVoucher.lines.map((l) => ({
      ...l,
      description: `ابطال و معکوس: ${l.description || origVoucher.description}`,
      debit: Math.max(0, Math.round(Number(l.credit) || 0)),
      credit: Math.max(0, Math.round(Number(l.debit) || 0)),
    }));
    const totalDebit = revLines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = revLines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit || totalDebit <= 0) {
      throw new Error('خطا در تراز سند معکوس ابطال فاکتور.');
    }
    const baseRev: Voucher = {
      id: reversalVoucherId,
      ownerId,
      voucherNumber: nextVoucherNumber,
      date: cancellationDate,
      fiscalYear: cancelFy,
      description: `سند ابطال و معکوس فاکتور ${invoice.invoiceNumber} — ${invoice.partyName} (عطف به سند #${origVoucher.voucherNumber})`,
      voucherType: origVoucher.voucherType,
      status: 'permanent',
      totalDebit,
      totalCredit,
      ...(origVoucher.currencyCode && origVoucher.currencyCode !== 'IRR' && origVoucher.exchangeRate
        ? {
            currencyCode: origVoucher.currencyCode,
            exchangeRate: origVoucher.exchangeRate,
          }
        : {}),
      referenceId: invoice.id,
      reversalOfVoucherId: origVoucher.id,
      lines: revLines,
      _version: 1,
      updatedByDevice: deviceId,
    };
    reversalVoucher = {
      ...baseRev,
      integrityHash: computeVoucherIntegrityHash(baseRev),
    };
  }

  return {
    updatedProducts,
    productDeltas,
    reversalVoucher,
    chequeIdsToCancel,
  };
}

export interface StockAdjustmentPlan {
  updatedProduct: Product;
  productDelta: {
    stock: number;
    buyPrice: number;
    costLayers: InventoryCostLayer[];
    inventoryValueIrr: number;
    prevVersion: number;
  };
  voucher?: Voucher;
  diffQty: number;
  adjustmentCostIrr: number;
}

/**
 * Atomically plans an inventory stocktaking / physical count adjustment using
 * the active costing method (FIFO / MWA / PWA) so `costLayers`, `inventoryValueIrr`,
 * and GL 10501 stay reconciled to 0 Rial with zero duplicate `referenceId` risk.
 */
export function planStockAdjustmentWithCostLayers(input: {
  product: Product;
  newStock: number;
  date: string;
  reason?: string;
  costingMethod?: InventoryCostingMethod;
  allowNegativeStock?: boolean;
  closedFiscalYears?: string[];
  accounts: Account[];
  ownerId: string;
  referenceId: string;
  voucherId: string;
  nextVoucherNumber: number;
  deviceId?: string;
}): StockAdjustmentPlan {
  const {
    product,
    newStock,
    date,
    reason,
    costingMethod = 'fifo',
    allowNegativeStock = false,
    closedFiscalYears = [],
    accounts,
    ownerId,
    referenceId,
    voucherId,
    nextVoucherNumber,
    deviceId = 'local_device',
  } = input;

  if (!isValidShamsiDate(date)) {
    throw new Error(`تاریخ تعدیل انبارگردانی («${date}») فرمت شمسی معتبر ندارد.`);
  }
  const fy = extractFiscalYearFromDate(date);
  if (fy && closedFiscalYears.includes(fy)) {
    throw new Error(`سال مالی ${fy} بسته شده است و ثبت سند تعدیل انبارگردانی مجاز نیست.`);
  }

  const sanitizedStock = roundQty(Math.max(0, Number(newStock) || 0));
  const diffQty = roundQty(sanitizedStock - product.stock);
  const prevVersion = product._version ?? 1;
  const currentState = normalizeProductCostState(product, costingMethod, date);

  if (Math.abs(diffQty) < 0.001) {
    return {
      updatedProduct: product,
      productDelta: {
        stock: currentState.stockQty,
        buyPrice: currentState.weightedAvgUnitCostIrr,
        costLayers: currentState.layers,
        inventoryValueIrr: currentState.totalValueIrr,
        prevVersion,
      },
      voucher: undefined,
      diffQty: 0,
      adjustmentCostIrr: 0,
    };
  }

  const step = applyInventoryMovementStep(currentState, {
    id: referenceId,
    date,
    kind: diffQty > 0 ? 'surplus' : 'shortage',
    productId: product.id,
    warehouse: product.warehouse,
    qty: Math.abs(diffQty),
    unitCostIrr: product.buyPrice,
    sourceRefId: referenceId,
    allowNegativeStock,
  });

  const adjustmentCostIrr = Math.max(0, Math.round(step.cogsOrCostIrr));
  const updatedProduct: Product = {
    ...product,
    stock: step.nextState.stockQty,
    buyPrice: step.nextState.weightedAvgUnitCostIrr,
    costingMethod: step.nextState.costingMethod,
    costLayers: step.nextState.layers,
    inventoryValueIrr: step.nextState.totalValueIrr,
    _version: prevVersion + 1,
    updatedByDevice: deviceId,
  };

  let voucher: Voucher | undefined;
  if (adjustmentCostIrr > 0) {
    const accMap = new Map(accounts.map((a) => [a.code, a]));
    const invTitle = accMap.get('10501')?.title || 'موجودی کالا و نخ در انبار';
    const gainTitle = accMap.get('60301')?.title || 'سایر درآمدها و سود اضافی انبار';
    const lossTitle = accMap.get('80401')?.title || 'هزینه ضایعات و کسری انبار';

    const lines: VoucherLine[] =
      diffQty > 0
        ? [
            {
              accountCode: '10501',
              accountTitle: invTitle,
              description: `اضافی انبارگردانی ${product.name} (+${diffQty} ${product.unit})`,
              debit: adjustmentCostIrr,
              credit: 0,
            },
            {
              accountCode: '60301',
              accountTitle: gainTitle,
              description: reason || `سود تعدیل اضافی انبارگردانی — کد ${product.sku}`,
              debit: 0,
              credit: adjustmentCostIrr,
            },
          ]
        : [
            {
              accountCode: '80401',
              accountTitle: lossTitle,
              description: reason || `کسری انبارگردانی — ${product.name} (${diffQty} ${product.unit})`,
              debit: adjustmentCostIrr,
              credit: 0,
            },
            {
              accountCode: '10501',
              accountTitle: invTitle,
              description: `کاهش موجودی انبار بابت کسری/انبارگردانی ${product.name}`,
              debit: 0,
              credit: adjustmentCostIrr,
            },
          ];

    const baseV: Voucher = {
      id: voucherId,
      ownerId,
      voucherNumber: nextVoucherNumber,
      date,
      fiscalYear: fy,
      description: `سند تعدیل انبارگردانی «${product.name}» (${diffQty > 0 ? `+${diffQty}` : diffQty} ${product.unit})`,
      voucherType: 'general',
      status: 'permanent',
      totalDebit: adjustmentCostIrr,
      totalCredit: adjustmentCostIrr,
      referenceId,
      lines,
      _version: 1,
      updatedByDevice: deviceId,
    };
    voucher = {
      ...baseV,
      integrityHash: computeVoucherIntegrityHash(baseV),
    };
  }

  return {
    updatedProduct,
    productDelta: {
      stock: step.nextState.stockQty,
      buyPrice: step.nextState.weightedAvgUnitCostIrr,
      costLayers: step.nextState.layers,
      inventoryValueIrr: step.nextState.totalValueIrr,
      prevVersion,
    },
    voucher,
    diffQty,
    adjustmentCostIrr,
  };
}





