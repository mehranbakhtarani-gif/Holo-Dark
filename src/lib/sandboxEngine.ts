/**
 * Independent Accounting Sandbox Engine (محیط آزمایشی ایزوله حسابداری)
 *
 * Guarantees:
 * - Deep-clones live workspace data into an isolated in-memory SandboxSession.
 * - NEVER mutates live React state, IndexedDB, Firebase Firestore, or Supabase.
 * - Allows accountants/auditors to test vouchers, invoices (FIFO/MWA), returns,
 *   and Balance Sheet scenarios and view an exact before-vs-after diff report.
 */

import {
  Account,
  Cheque,
  CompanyProfile,
  Invoice,
  Party,
  Product,
  Voucher,
} from '../types/accounting';
import {
  AtomicInvoicePlanInput,
  BalanceSheetSummary,
  computeBalanceSheet,
  computeIncomeStatement,
  computeTrialBalance,
  computeVoucherIntegrityHash,
  IncomeStatementSummary,
  planAtomicInvoiceCommit,
  validateVoucherPayload,
} from './accountingEngine';
import { runIndependentAuditMode, IndependentAuditReport } from './accountingIntegrityEngine';
import { subIrr, sumIrr } from './moneyMath';

export interface SandboxWorkspaceSnapshot {
  profile: CompanyProfile;
  accounts: Account[];
  parties: Party[];
  products: Product[];
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
}

export interface SandboxDiffReport {
  readonly isLiveDataUntouched: true;
  baselineTotalAssetsIrr: number;
  sandboxTotalAssetsIrr: number;
  deltaAssetsIrr: number;
  baselineNetProfitIrr: number;
  sandboxNetProfitIrr: number;
  deltaNetProfitIrr: number;
  baselineInventoryValueIrr: number;
  sandboxInventoryValueIrr: number;
  deltaInventoryValueIrr: number;
  voucherCountDelta: number;
  invoiceCountDelta: number;
  chequeCountDelta: number;
  sandboxBalanceSheetBalanced: boolean;
  sandboxAuditScore: number;
}

export interface SandboxSession {
  sessionId: string;
  createdAt: string;
  baseline: SandboxWorkspaceSnapshot;
  current: SandboxWorkspaceSnapshot;
  operationsLog: string[];
}

function deepClone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export function createSandboxSession(live: SandboxWorkspaceSnapshot): SandboxSession {
  const baseline = deepClone(live);
  const current = deepClone(live);
  return {
    sessionId: `sbx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    baseline,
    current,
    operationsLog: ['ایجاد کپی کاملاً ایزوله از دیتابیس بدون اثرگذاری بر اطلاعات واقعی'],
  };
}

export function postSandboxVoucher(
  session: SandboxSession,
  payload: Omit<Voucher, 'id' | 'ownerId' | 'voucherNumber' | 'totalDebit' | 'totalCredit'>
): { ok: true; session: SandboxSession; voucher: Voucher } | { ok: false; error: string } {
  const nextCurrent = deepClone(session.current);
  const validation = validateVoucherPayload({
    payload: {
      date: payload.date,
      description: payload.description,
      lines: payload.lines,
      voucherType: payload.voucherType,
      referenceId: payload.referenceId,
    },
    accounts: nextCurrent.accounts,
    parties: nextCurrent.parties,
    existingVouchers: nextCurrent.vouchers,
    closedFiscalYears: nextCurrent.profile.closedFiscalYears,
  });
  if (!validation.valid) {
    return { ok: false, error: validation.errors[0] || 'سند آزمایشی نامعتبر است.' };
  }

  const nextNum =
    nextCurrent.vouchers.reduce((m, v) => Math.max(m, v.voucherNumber), 0) + 1;
  const voucher: Voucher = {
    ...payload,
    id: `sbx_v_${nextNum}_${Date.now()}`,
    ownerId: 'sandbox',
    voucherNumber: nextNum,
    fiscalYear: validation.fiscalYear,
    totalDebit: validation.totalDebit,
    totalCredit: validation.totalCredit,
  };
  if (voucher.status === 'permanent') {
    voucher.integrityHash = computeVoucherIntegrityHash(voucher);
  }
  nextCurrent.vouchers.push(voucher);

  return {
    ok: true,
    voucher,
    session: {
      ...session,
      current: nextCurrent,
      operationsLog: [
        ...session.operationsLog,
        `ثبت سند آزمایشی #${nextNum} (${voucher.date}) به مبلغ ${voucher.totalDebit.toLocaleString('en-US')} ریال`,
      ],
    },
  };
}

export function postSandboxInvoice(
  session: SandboxSession,
  invoicePayload: AtomicInvoicePlanInput['payload'],
  options?: {
    originalInvoice?: Invoice;
  }
): { ok: true; session: SandboxSession; invoice: Invoice; voucher?: Voucher } | { ok: false; error: string } {
  const nextCurrent = deepClone(session.current);
  const nextVoucherNum =
    nextCurrent.vouchers.reduce((m, v) => Math.max(m, v.voucherNumber), 0) + 1;
  const uidSuffix = `${nextVoucherNum}_${Date.now()}`;
  const party = nextCurrent.parties.find((p) => p.id === invoicePayload.partyId);

  try {
    const plan = planAtomicInvoiceCommit({
      invoiceId: `sbx_inv_${uidSuffix}`,
      voucherId: `sbx_v_${uidSuffix}`,
      chequeId: invoicePayload.paidCheque > 0 ? `sbx_chq_${uidSuffix}` : undefined,
      nextVoucherNumber: nextVoucherNum,
      ownerId: 'sandbox',
      deviceId: 'sandbox-device',
      payload: invoicePayload,
      products: nextCurrent.products,
      party,
      existingInvoices: nextCurrent.invoices,
      existingVouchers: nextCurrent.vouchers,
      closedFiscalYears: nextCurrent.profile.closedFiscalYears,
      defaultCostingMethod: nextCurrent.profile.defaultCostingMethod || 'moving_average',
      originalInvoice: options?.originalInvoice,
    });

    const updatedMap = new Map(plan.updatedProducts.map((p) => [p.id, p]));
    nextCurrent.products = nextCurrent.products.map((p) => updatedMap.get(p.id) || p);
    if (plan.voucher) nextCurrent.vouchers.push(plan.voucher);
    if (plan.cheque) nextCurrent.cheques.push(plan.cheque);
    nextCurrent.invoices.push(plan.invoice);

    return {
      ok: true,
      invoice: plan.invoice,
      voucher: plan.voucher,
      session: {
        ...session,
        current: nextCurrent,
        operationsLog: [
          ...session.operationsLog,
          `صدور فاکتور آزمایشی ${plan.invoice.invoiceNumber} (${plan.invoice.invoiceType}) به مبلغ ${plan.invoice.grandTotal.toLocaleString('en-US')} ریال`,
        ],
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'خطا در صدور فاکتور آزمایشی',
    };
  }
}

export function computeSandboxDiff(session: SandboxSession): {
  diff: SandboxDiffReport;
  sandboxBalanceSheet: BalanceSheetSummary;
  sandboxIncomeStatement: IncomeStatementSummary;
  sandboxAudit: IndependentAuditReport;
} {
  const fy = session.current.profile.fiscalYear;
  const baseTb = computeTrialBalance(session.baseline.accounts, session.baseline.vouchers, {
    fiscalYear: fy,
  });
  const baseBs = computeBalanceSheet(baseTb);
  const baseInc = computeIncomeStatement(baseTb);

  const sbxTb = computeTrialBalance(session.current.accounts, session.current.vouchers, {
    fiscalYear: fy,
  });
  const sbxBs = computeBalanceSheet(sbxTb);
  const sbxInc = computeIncomeStatement(sbxTb);

  const baseInvVal = sumIrr(
    session.baseline.products.map((p) =>
      p.inventoryValueIrr !== undefined ? p.inventoryValueIrr : Math.round(p.stock * p.buyPrice)
    )
  );
  const sbxInvVal = sumIrr(
    session.current.products.map((p) =>
      p.inventoryValueIrr !== undefined ? p.inventoryValueIrr : Math.round(p.stock * p.buyPrice)
    )
  );

  const sbxAudit = runIndependentAuditMode({
    profile: session.current.profile,
    accounts: session.current.accounts,
    parties: session.current.parties,
    products: session.current.products,
    vouchers: session.current.vouchers,
    invoices: session.current.invoices,
    cheques: session.current.cheques,
    fiscalYear: fy,
  });

  return {
    sandboxBalanceSheet: sbxBs,
    sandboxIncomeStatement: sbxInc,
    sandboxAudit: sbxAudit,
    diff: {
      isLiveDataUntouched: true,
      baselineTotalAssetsIrr: baseBs.totalAssets,
      sandboxTotalAssetsIrr: sbxBs.totalAssets,
      deltaAssetsIrr: subIrr(sbxBs.totalAssets, baseBs.totalAssets),
      baselineNetProfitIrr: baseInc.netProfit,
      sandboxNetProfitIrr: sbxInc.netProfit,
      deltaNetProfitIrr: subIrr(sbxInc.netProfit, baseInc.netProfit),
      baselineInventoryValueIrr: baseInvVal,
      sandboxInventoryValueIrr: sbxInvVal,
      deltaInventoryValueIrr: subIrr(sbxInvVal, baseInvVal),
      voucherCountDelta: session.current.vouchers.length - session.baseline.vouchers.length,
      invoiceCountDelta: session.current.invoices.length - session.baseline.invoices.length,
      chequeCountDelta: session.current.cheques.length - session.baseline.cheques.length,
      sandboxBalanceSheetBalanced: sbxBs.isBalanced,
      sandboxAuditScore: sbxAudit.healthScore,
    },
  };
}
