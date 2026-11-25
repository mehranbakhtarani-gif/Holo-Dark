/**
 * Strictly Isolated Financial Forecasting Engine (پیش‌بینی مالی غیرقطعی)
 *
 * CRITICAL ACCOUNTING SEPARATION RULE:
 * - Forecasts are purely read-only projections computed from historical ledger/invoice/cheque data.
 * - Forecasts NEVER create vouchers, NEVER alter account balances, and are always explicitly
 *   tagged `isForecastOnly: true` & `mutatesLedger: false`.
 */

import { Cheque, Invoice, Product, TrialBalanceRow, Voucher } from '../types/accounting';
import { addIrr, mulQtyByIrr, roundQtyFixed, subIrr, sumIrr, toExactIrr } from './moneyMath';
import { diffShamsiDays } from './chequeAlerts';
import { getTodayShamsi } from './format';

export interface HorizonForecastBucket {
  horizonDays: 30 | 60 | 90;
  label: string;
  projectedSalesIrr: number;
  projectedPurchasesIrr: number;
  scheduledChequeInflowIrr: number;
  scheduledChequeOutflowIrr: number;
  expectedArCollectionIrr: number;
  expectedApPaymentIrr: number;
  projectedNetCashDeltaIrr: number;
  projectedEndingCashIrr: number;
  liquidityWarning: boolean;
}

export interface InventoryReorderForecastRow {
  productId: string;
  sku: string;
  productName: string;
  currentStock: number;
  reorderPoint: number;
  avgDailySalesQty: number;
  daysOfCover: number | null; // null = no sales velocity (stagnant)
  isStagnant: boolean; // کالای راکد
  isLowStock: boolean; // کالای کم‌موجودی
  recommendedOrderQty: number;
  estimatedOrderCostIrr: number;
}

export interface FinancialForecastReport {
  readonly isForecastOnly: true;
  readonly mutatesLedger: false;
  readonly disclaimer: string;
  asOfDate: string;
  historicalWindowDays: number;
  currentCashAndBankIrr: number;
  currentReceivablesIrr: number;
  currentPayablesIrr: number;
  avgMonthlySalesIrr: number;
  avgMonthlyPurchasesIrr: number;
  horizons: HorizonForecastBucket[];
  inventoryForecast: InventoryReorderForecastRow[];
  stagnantProducts: InventoryReorderForecastRow[];
  lowStockProducts: InventoryReorderForecastRow[];
}

export function computeFinancialForecast(params: {
  trialBalance: TrialBalanceRow[];
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
  products: Product[];
  asOfDate?: string;
  historicalWindowDays?: number;
}): FinancialForecastReport {
  const {
    trialBalance,
    invoices,
    cheques,
    products,
    asOfDate = getTodayShamsi(),
    historicalWindowDays = 90,
  } = params;

  const currentCashAndBankIrr = sumIrr(
    trialBalance
      .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
      .map((r) => subIrr(r.balanceDebit, r.balanceCredit))
  );
  const currentReceivablesIrr = Math.max(
    0,
    sumIrr(
      trialBalance
        .filter((r) => r.accountCode.startsWith('104'))
        .map((r) => subIrr(r.balanceDebit, r.balanceCredit))
    )
  );
  const currentPayablesIrr = Math.max(
    0,
    sumIrr(
      trialBalance
        .filter((r) => r.accountCode.startsWith('301'))
        .map((r) => subIrr(r.balanceCredit, r.balanceDebit))
    )
  );

  // Historical active invoices
  const validInvoices = invoices.filter(
    (inv) => inv.status !== 'cancelled' && inv.invoiceType !== 'proforma'
  );

  // Count distinct active Shamsi months present in invoices (fallback to windowDays / 30)
  const activeMonths = new Set(validInvoices.map((i) => i.date.slice(0, 7)));
  const monthDivisor = Math.max(1, activeMonths.size);

  const totalHistoricalSales = sumIrr(
    validInvoices.map((i) =>
      i.invoiceType === 'sale'
        ? toExactIrr(i.grandTotal)
        : i.invoiceType === 'sale_return'
          ? -toExactIrr(i.grandTotal)
          : 0
    )
  );
  const totalHistoricalPurchases = sumIrr(
    validInvoices.map((i) =>
      i.invoiceType === 'purchase'
        ? toExactIrr(i.grandTotal)
        : i.invoiceType === 'purchase_return'
          ? -toExactIrr(i.grandTotal)
          : 0
    )
  );

  const avgMonthlySalesIrr = Math.max(0, Math.round(totalHistoricalSales / monthDivisor));
  const avgMonthlyPurchasesIrr = Math.max(0, Math.round(totalHistoricalPurchases / monthDivisor));

  // Open pending cheques scheduled within each horizon
  const openCheques = cheques.filter(
    (c) => c.status === 'in_box' || c.status === 'deposited'
  );

  const horizons: HorizonForecastBucket[] = ([30, 60, 90] as const).map((days) => {
    const monthsFactor = days / 30;
    const projectedSalesIrr = Math.round(avgMonthlySalesIrr * monthsFactor);
    const projectedPurchasesIrr = Math.round(avgMonthlyPurchasesIrr * monthsFactor);

    let scheduledChequeInflowIrr = 0;
    let scheduledChequeOutflowIrr = 0;
    for (const c of openCheques) {
      const diff = diffShamsiDays(asOfDate, c.dueDate);
      if (diff !== null && diff >= 0 && diff <= days) {
        if (c.direction === 'receivable') {
          scheduledChequeInflowIrr = addIrr(scheduledChequeInflowIrr, c.amount);
        } else {
          scheduledChequeOutflowIrr = addIrr(scheduledChequeOutflowIrr, c.amount);
        }
      }
    }

    // Conservative AR collection & AP settlement assumptions (explicitly heuristic, isolated from books)
    const arCollectRatio = days === 30 ? 0.45 : days === 60 ? 0.72 : 0.88;
    const apPayRatio = days === 30 ? 0.5 : days === 60 ? 0.75 : 0.9;
    const expectedArCollectionIrr = Math.round(currentReceivablesIrr * arCollectRatio);
    const expectedApPaymentIrr = Math.round(currentPayablesIrr * apPayRatio);

    // Cash portion of projected new sales/purchases (assume 35% immediate cash/bank turnover)
    const cashSalesInflow = Math.round(projectedSalesIrr * 0.35);
    const cashPurchaseOutflow = Math.round(projectedPurchasesIrr * 0.35);

    const totalIn = addIrr(scheduledChequeInflowIrr, expectedArCollectionIrr, cashSalesInflow);
    const totalOut = addIrr(scheduledChequeOutflowIrr, expectedApPaymentIrr, cashPurchaseOutflow);
    const projectedNetCashDeltaIrr = subIrr(totalIn, totalOut);
    const projectedEndingCashIrr = addIrr(currentCashAndBankIrr, projectedNetCashDeltaIrr);

    return {
      horizonDays: days,
      label: `افق ${days} روزه`,
      projectedSalesIrr,
      projectedPurchasesIrr,
      scheduledChequeInflowIrr,
      scheduledChequeOutflowIrr,
      expectedArCollectionIrr,
      expectedApPaymentIrr,
      projectedNetCashDeltaIrr,
      projectedEndingCashIrr,
      liquidityWarning: projectedEndingCashIrr < 0,
    };
  });

  // Inventory velocity, stagnant items & reorder projections
  const soldQtyByProduct = new Map<string, number>();
  for (const inv of validInvoices) {
    if (inv.invoiceType !== 'sale' && inv.invoiceType !== 'sale_return') continue;
    const sign = inv.invoiceType === 'sale' ? 1 : -1;
    for (const it of inv.items) {
      soldQtyByProduct.set(
        it.productId,
        roundQtyFixed((soldQtyByProduct.get(it.productId) || 0) + sign * (it.quantity || 0), 4)
      );
    }
  }

  const effectiveDays = Math.max(30, historicalWindowDays);
  const inventoryForecast: InventoryReorderForecastRow[] = products.map((p) => {
    const netSold = Math.max(0, soldQtyByProduct.get(p.id) || 0);
    const avgDailySalesQty = roundQtyFixed(netSold / effectiveDays, 4);
    const daysOfCover =
      avgDailySalesQty > 0 ? Math.round((p.stock / avgDailySalesQty) * 10) / 10 : null;
    const isStagnant = p.stock > 0 && netSold === 0;
    const isLowStock = p.stock <= p.reorderPoint || (daysOfCover !== null && daysOfCover <= 14);
    const target45DayStock = Math.max(p.reorderPoint * 1.5, avgDailySalesQty * 45);
    const recommendedOrderQty = isLowStock
      ? roundQtyFixed(Math.max(0, target45DayStock - p.stock), 2)
      : 0;
    const estimatedOrderCostIrr = mulQtyByIrr(recommendedOrderQty, p.buyPrice);

    return {
      productId: p.id,
      sku: p.sku,
      productName: p.name,
      currentStock: roundQtyFixed(p.stock, 2),
      reorderPoint: p.reorderPoint,
      avgDailySalesQty,
      daysOfCover,
      isStagnant,
      isLowStock,
      recommendedOrderQty,
      estimatedOrderCostIrr,
    };
  });

  return {
    isForecastOnly: true,
    mutatesLedger: false,
    disclaimer:
      'این ارقام صرفاً برآورد تحلیلی بر پایه روند تاریخی و سررسید چک‌ها هستند، کاملاً از دفاتر رسمی جدا نگه‌داری می‌شوند و هیچ سندی در حسابداری ثبت نمی‌کنند.',
    asOfDate,
    historicalWindowDays: effectiveDays,
    currentCashAndBankIrr,
    currentReceivablesIrr,
    currentPayablesIrr,
    avgMonthlySalesIrr,
    avgMonthlyPurchasesIrr,
    horizons,
    inventoryForecast,
    stagnantProducts: inventoryForecast.filter((x) => x.isStagnant),
    lowStockProducts: inventoryForecast.filter((x) => x.isLowStock),
  };
}
