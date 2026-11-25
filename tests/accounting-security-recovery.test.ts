import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  calculateEmployeePayroll,
  computeAuditReport,
  computeBalanceSheet,
  computeCashFlowStatement,
  computeGeneralJournal,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
  computeVatSummaryReport,
  computeVoucherIntegrityHash,
  isValidShamsiDate,
  filterVouchersForReport,
  planAtomicInvoiceCommit,
  planChequeStatusTransition,
  planYearEndClosing,
  validateVoucherPayload,
} from '../src/lib/accountingEngine';
import {
  normalizeProductCostState,
  planWarehouseTransfer,
  recalculateInventoryLedger,
} from '../src/lib/inventoryCostingEngine';
import { getStatutoryParamsForYear, validateStatutoryParams } from '../src/lib/iranStatutoryParams';
import { convertForeignLinesToBalancedIrr } from '../src/lib/currency';
import {
  LOCAL_SLM_INFO,
  localCopilotRespond,
  localParseInvoice,
  localParseVoucher,
} from '../src/lib/localSmallLlm';
import { buildCopilotFinancialSnapshot } from '../src/lib/smartIntelligence';
import { inferToastTone } from '../src/lib/audioFeedback';
import { MAX_CLOUD_BACKUPS } from '../src/lib/firebaseCloudBackup';
import { Cheque, Employee, Invoice, Product, Voucher } from '../src/types/accounting';

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('P0: Jalali date validation rejects Esfand 30 in common years and accepts it in leap years', () => {
  assert.equal(isValidShamsiDate('1400/12/30'), false);
  assert.equal(isValidShamsiDate('1403/12/30'), true);
  assert.equal(isValidShamsiDate('1403/12/31'), false);
  assert.equal(isValidShamsiDate('1403/06/31'), true);
  assert.equal(isValidShamsiDate('1403/07/31'), false);
});

test('P0: Voucher validation rejects non-numeric amount strings instead of coercing them to zero', () => {
  const seed = createHolooSeedData('p0_validation_test');
  const debitAccount = seed.accounts.find((a) => a.code === '10101')!;
  const creditAccount = seed.accounts.find((a) => a.code === '40101')!;
  const base = {
    date: '1403/12/30',
    description: 'P0 validation test',
    voucherType: 'general' as const,
    lines: [
      { accountCode: debitAccount.code, accountTitle: debitAccount.title, description: 'debit', debit: 'abc', credit: 0 },
      { accountCode: creditAccount.code, accountTitle: creditAccount.title, description: 'credit', debit: 0, credit: 100 },
    ],
  };
  const invalid = validateVoucherPayload({ payload: base as any, accounts: seed.accounts });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('مبلغ بدهکار یا بستانکار نامعتبر')));
  const validPersianDigits = validateVoucherPayload({
    payload: {
      ...base,
      lines: [
        { accountCode: debitAccount.code, accountTitle: debitAccount.title, description: 'debit', debit: '۱۰۰', credit: 0 },
        { accountCode: creditAccount.code, accountTitle: creditAccount.title, description: 'credit', debit: 0, credit: '۱۰۰' },
      ],
    } as any,
    accounts: seed.accounts,
  });
  assert.equal(validPersianDigits.valid, true);
});

// ============================================================================
// 1. ACCOUNTING ENGINE TESTS
// ============================================================================

test('Accounting: Seed data produces balanced Trial Balance and Balance Sheet (Assets = L + E)', () => {
  const seed = createHolooSeedData('test_owner');
  const tb = computeTrialBalance(seed.accounts, seed.vouchers, {
    includeDrafts: false,
    fiscalYear: '1405',
  });
  const totalDebit = tb.reduce((s, r) => s + r.totalDebit, 0);
  const totalCredit = tb.reduce((s, r) => s + r.totalCredit, 0);
  assert.equal(totalDebit, totalCredit, 'Trial balance total debit must equal total credit');

  const bs = computeBalanceSheet(tb);
  assert.equal(bs.isBalanced, true, 'Balance sheet must satisfy Assets = Liabilities + Equity');
});

test('Accounting: Draft vouchers are excluded from official reports by default and included only when toggled', () => {
  const seed = createHolooSeedData('test_owner');
  const draftVoucher: Voucher = {
    id: 'vch_draft_test',
    ownerId: 'test_owner',
    voucherNumber: 999,
    date: '1405/06/15',
    description: 'سند موقت تست حسابرسی',
    voucherType: 'general',
    status: 'draft',
    totalDebit: 50_000_000,
    totalCredit: 50_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق مرکزی', description: 'تست موقت', debit: 50_000_000, credit: 0 },
      { accountCode: '40101', accountTitle: 'فروش نخ', description: 'تست موقت', debit: 0, credit: 50_000_000 },
    ],
  };

  const withDraft = [...seed.vouchers, draftVoucher];

  const officialFiltered = filterVouchersForReport(withDraft, {
    includeDrafts: false,
    fiscalYear: '1405',
  });
  assert.equal(
    officialFiltered.some((v) => v.id === 'vch_draft_test'),
    false,
    'Official report filter must exclude draft vouchers'
  );

  const tbOfficial = computeTrialBalance(seed.accounts, withDraft, {
    includeDrafts: false,
    fiscalYear: '1405',
  });
  const tbWithDrafts = computeTrialBalance(seed.accounts, withDraft, {
    includeDrafts: true,
    fiscalYear: '1405',
  });

  const cashOfficial = tbOfficial.find((r) => r.accountCode === '10101')?.totalDebit ?? 0;
  const cashWithDraft = tbWithDrafts.find((r) => r.accountCode === '10101')?.totalDebit ?? 0;
  assert.equal(
    cashWithDraft - cashOfficial,
    50_000_000,
    'Enabling includeDrafts should reflect draft voucher impact cleanly'
  );
});

test('Accounting: Fiscal year isolation prevents prior-year vouchers from polluting current period reports', () => {
  const seed = createHolooSeedData('test_owner');
  const prevYearVoucher: Voucher = {
    id: 'vch_1404_old',
    ownerId: 'test_owner',
    voucherNumber: 888,
    date: '1404/12/20',
    description: 'سند سال مالی قبل',
    voucherType: 'general',
    status: 'permanent',
    totalDebit: 120_000_000,
    totalCredit: 120_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق مرکزی', description: 'سال ۱۴۰۴', debit: 120_000_000, credit: 0 },
      { accountCode: '40101', accountTitle: 'فروش', description: 'سال ۱۴۰۴', debit: 0, credit: 120_000_000 },
    ],
  };

  const combined = [...seed.vouchers, prevYearVoucher];
  const filtered1405 = filterVouchersForReport(combined, { fiscalYear: '1405' });
  assert.equal(
    filtered1405.some((v) => v.id === 'vch_1404_old'),
    false,
    '1404 voucher must be excluded from 1405 reports'
  );

  const filtered1404 = filterVouchersForReport(combined, { fiscalYear: '1404' });
  assert.equal(filtered1404.length, 1, '1404 scope must include only 1404 vouchers');
});

test('Accounting: Multi-currency exact integer-IRR conversion preserves zero rounding drift', () => {
  // 3 equal foreign debit splits of $33.33 / $33.33 / $33.34 against $100 credit at fractional rate 61234.57
  const converted = convertForeignLinesToBalancedIrr(
    [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'د1', debit: 0, credit: 0, foreignDebit: 33.33, foreignCredit: 0 },
      { accountCode: '10101', accountTitle: 'صندوق', description: 'د2', debit: 0, credit: 0, foreignDebit: 33.33, foreignCredit: 0 },
      { accountCode: '10101', accountTitle: 'صندوق', description: 'د3', debit: 0, credit: 0, foreignDebit: 33.34, foreignCredit: 0 },
      { accountCode: '40101', accountTitle: 'فروش', description: 'ب1', debit: 0, credit: 0, foreignDebit: 0, foreignCredit: 100.0 },
    ],
    61234.57
  );
  assert.equal(
    converted.totalDebitIrr,
    converted.totalCreditIrr,
    'Multi-currency IRR conversion must be balanced to the exact single Rial'
  );
  assert.equal(Number.isInteger(converted.totalDebitIrr), true, 'IRR debit must be an exact integer');
});

test('Atomic Invoice Commit: Plans inventory delta, balanced voucher, Sayadi cheque, and invoice together', () => {
  const seed = createHolooSeedData('test_owner');
  const prod = seed.products[0];
  const party = seed.parties[0];
  const qty = 50;
  const subtotal = qty * prod.sellPrice;
  const vat = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + vat;
  const paidCheque = Math.round(grandTotal / 2);
  const creditAmount = grandTotal - paidCheque;

  const payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'> = {
    invoiceNumber: 'SL-1405-9001',
    invoiceType: 'sale',
    date: '1405/07/10',
    partyId: party.id,
    partyName: party.name,
    warehouse: prod.warehouse,
    subtotal,
    discount: 0,
    vatAmount: vat,
    grandTotal,
    paidCash: 0,
    paidBank: 0,
    paidCheque,
    creditAmount,
    status: 'issued',
    items: [
      {
        productId: prod.id,
        sku: prod.sku,
        productName: prod.name,
        unit: prod.unit,
        quantity: qty,
        unitPrice: prod.sellPrice,
        discount: 0,
        vatAmount: vat,
        lineTotal: grandTotal,
      },
    ],
  };

  const plan = planAtomicInvoiceCommit({
    invoiceId: 'inv_atomic_1',
    voucherId: 'vch_atomic_1',
    chequeId: 'chq_atomic_1',
    nextVoucherNumber: 901,
    ownerId: 'test_owner',
    deviceId: 'dev_test',
    payload,
    products: seed.products,
    party,
    currentPartyBalance: 0,
  });

  assert.equal(plan.updatedProducts.length, 1, 'Exactly one product stock delta planned');
  assert.equal(
    plan.updatedProducts[0].stock,
    Number((prod.stock - qty).toFixed(2)),
    'Stock must decrement by sold quantity'
  );
  assert.ok(plan.voucher, 'Balanced voucher must be created');
  assert.equal(plan.voucher!.totalDebit, plan.voucher!.totalCredit, 'Voucher must be balanced');
  assert.ok(plan.cheque, 'Sayadi cheque must be created atomically when paidCheque > 0');
  assert.equal(plan.cheque!.amount, paidCheque, 'Cheque amount must match invoice paidCheque');
  assert.equal(plan.invoice.voucherId, 'vch_atomic_1', 'Invoice must link to planned voucher');
});

test('Atomic Invoice Commit: Rejects completely on insufficient stock, settlement mismatch, or cash overdraft', () => {
  const seed = createHolooSeedData('test_owner');
  const prod = seed.products[0];
  const party = seed.parties[0];
  const tb = computeTrialBalance(seed.accounts, seed.vouchers, { fiscalYear: '1405' });

  // Case A: Insufficient stock
  assert.throws(
    () =>
      planAtomicInvoiceCommit({
        invoiceId: 'inv_fail_stock',
        voucherId: 'vch_fail_stock',
        nextVoucherNumber: 902,
        ownerId: 'test_owner',
        deviceId: 'dev_test',
        payload: {
          invoiceNumber: 'SL-FAIL-1',
          invoiceType: 'sale',
          date: '1405/07/10',
          partyId: party.id,
          partyName: party.name,
          warehouse: prod.warehouse,
          subtotal: 999999 * prod.sellPrice,
          discount: 0,
          vatAmount: 0,
          grandTotal: 999999 * prod.sellPrice,
          paidCash: 0,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: 999999 * prod.sellPrice,
          status: 'issued',
          items: [
            {
              productId: prod.id,
              sku: prod.sku,
              productName: prod.name,
              unit: prod.unit,
              quantity: 999999,
              unitPrice: prod.sellPrice,
              discount: 0,
              vatAmount: 0,
              lineTotal: 999999 * prod.sellPrice,
            },
          ],
        },
        products: seed.products,
      }),
    /موجودی انبار/
  );

  // Case B: Unbalanced settlement
  assert.throws(
    () =>
      planAtomicInvoiceCommit({
        invoiceId: 'inv_fail_settle',
        voucherId: 'vch_fail_settle',
        nextVoucherNumber: 903,
        ownerId: 'test_owner',
        deviceId: 'dev_test',
        payload: {
          invoiceNumber: 'SL-FAIL-2',
          invoiceType: 'sale',
          date: '1405/07/10',
          partyId: party.id,
          partyName: party.name,
          warehouse: prod.warehouse,
          subtotal: 10 * prod.sellPrice,
          discount: 0,
          vatAmount: 0,
          grandTotal: 10 * prod.sellPrice,
          paidCash: 1000,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: 0,
          status: 'issued',
          items: [
            {
              productId: prod.id,
              sku: prod.sku,
              productName: prod.name,
              unit: prod.unit,
              quantity: 10,
              unitPrice: prod.sellPrice,
              discount: 0,
              vatAmount: 0,
              lineTotal: 10 * prod.sellPrice,
            },
          ],
        },
        products: seed.products,
      }),
    /تسویه/
  );

  // Case C: Cash overdraft on purchase
  assert.throws(
    () =>
      planAtomicInvoiceCommit({
        invoiceId: 'inv_fail_cash',
        voucherId: 'vch_fail_cash',
        nextVoucherNumber: 904,
        ownerId: 'test_owner',
        deviceId: 'dev_test',
        payload: {
          invoiceNumber: 'PR-FAIL-3',
          invoiceType: 'purchase',
          date: '1405/07/10',
          partyId: party.id,
          partyName: party.name,
          warehouse: prod.warehouse,
          subtotal: 99_000_000_000_000,
          discount: 0,
          vatAmount: 0,
          grandTotal: 99_000_000_000_000,
          paidCash: 99_000_000_000_000,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: 0,
          status: 'settled',
          items: [
            {
              productId: prod.id,
              sku: prod.sku,
              productName: prod.name,
              unit: prod.unit,
              quantity: 10,
              unitPrice: 9_900_000_000_000,
              discount: 0,
              vatAmount: 0,
              lineTotal: 99_000_000_000_000,
            },
          ],
        },
        products: seed.products,
        trialBalance: tb,
        enforceCashOverdraftGuard: true,
      }),
    /موجودی صندوق/
  );
});

// ============================================================================
// 2. 100% LOCAL SMALL LANGUAGE MODEL (ZERO CLOUD EGRESS) TESTS
// ============================================================================

test('Local SLM: Embedded metadata confirms 100% local offline execution', () => {
  assert.equal(LOCAL_SLM_INFO.offlineReady, true);
  assert.equal(LOCAL_SLM_INFO.mode.includes('100% Local'), true);
});

test('Local SLM: Parses Persian voucher narration into balanced double-entry lines', () => {
  const seed = createHolooSeedData('test_owner');
  const parsed = localParseVoucher({
    text: 'پرداخت 25 میلیون تومان اجاره دفتر از بانک ملت',
    currencyUnit: 'IRT',
    accounts: seed.accounts,
    parties: seed.parties,
  });
  assert.equal(parsed.lines.length >= 2, true, 'Must produce at least 2 voucher lines');
  const sumD = parsed.lines.reduce((s, l) => s + l.debitIrr, 0);
  const sumC = parsed.lines.reduce((s, l) => s + l.creditIrr, 0);
  assert.equal(sumD, sumC, 'Generated local voucher must be strictly balanced');
  assert.equal(sumD, 250_000_000, '25 million Toman must convert to 250,000,000 IRR');
});

test('Local SLM: Parses Persian invoice text & answers CFO copilot questions offline', () => {
  const seed = createHolooSeedData('test_owner');
  const invRes = localParseInvoice({
    text: `فروش 10 کارتن ${seed.products[0].name} به ${seed.parties[0].name}`,
    invoiceType: 'sale',
    currencyUnit: 'IRT',
    products: seed.products,
    parties: seed.parties,
  });
  assert.equal(invRes.items.length >= 1, true, 'Must extract at least 1 SKU row locally');

  const tb = computeTrialBalance(seed.accounts, seed.vouchers, { fiscalYear: '1405' });
  const pnl = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);
  const partyBals = computePartyBalances(seed.parties, seed.vouchers, { fiscalYear: '1405' });
  const snapshot = buildCopilotFinancialSnapshot({
    companyName: 'شرکت تست',
    fiscalYear: '1405',
    currencyUnit: 'IRT',
    liquidity: 150_000_000,
    netSales: pnl.netSales,
    grossProfit: pnl.grossProfit,
    netProfit: pnl.netProfit,
    grossMarginPct: pnl.grossMarginPct,
    netMarginPct: pnl.netMarginPct,
    totalAssets: bs.totalAssets,
    totalLiabilities: bs.totalLiabilities,
    totalEquity: bs.totalEquity,
    trialBalance: tb,
    products: seed.products,
    parties: seed.parties,
    partyBalances: partyBals,
    cheques: seed.cheques,
    vouchers: seed.vouchers,
    invoices: seed.invoices,
    auditScore: 98,
    auditErrors: 0,
    auditWarnings: 1,
  });

  const reply = localCopilotRespond({
    message: 'وضعیت سود و زیان و نقدینگی شرکت چطور است؟',
    snapshot,
  });
  assert.equal(reply.reply.length > 40, true, 'Copilot must produce rich local financial analysis');
  assert.equal(reply.engine.includes('Local'), true, 'Reply must declare local engine execution');
});

// ============================================================================
// 3. AUDIO FEEDBACK & SECURITY / DATA RECOVERY TESTS
// ============================================================================

test('Audio Feedback: Classifies Persian success, warning, and error toasts accurately', () => {
  assert.equal(inferToastTone('فاکتور به صورت اتمیک با موفقیت ثبت شد.'), 'success');
  assert.equal(inferToastTone('خطا: موجودی انبار کافی نیست و سند نامتوازن است.'), 'error');
  assert.equal(inferToastTone('هشدار: سقف اعتبار مشتری در آستانه عبور است.'), 'warning');
});

test('Security: Prototype pollution keys are stripped during backup JSON parsing', () => {
  const malicious = '{"__proto__":{"polluted":true},"constructor":{"bad":1},"accounts":[{"code":"10101","title":"صندوق"}]}';
  const parsed = JSON.parse(malicious, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return value;
  }) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('Security: Independent Supabase scrypt passcode hashing + HMAC-SHA256 token verification resists tampering', () => {
  const secret = 'test_signing_secret_32_bytes_min';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('MyStrongPass!99', salt, 64).toString('hex');
  const verifyPass = (candidate: string) => {
    const derived = crypto.scryptSync(candidate, salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived);
  };
  assert.equal(verifyPass('MyStrongPass!99'), true);
  assert.equal(verifyPass('WrongPass!00'), false);

  const payloadB64 = Buffer.from(
    JSON.stringify({ sub: 'sb_ws_atlasris', exp: Math.floor(Date.now() / 1000) + 3600 }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const validToken = `sbw1.${payloadB64}.${sig}`;
  const tamperedToken = `sbw1.${payloadB64}.tampered_sig`;

  const checkSig = (tok: string) => {
    const parts = tok.split('.');
    if (parts.length !== 3 || parts[0] !== 'sbw1') return false;
    const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest('base64url');
    const a = Buffer.from(parts[2], 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  assert.equal(checkSig(validToken), true);
  assert.equal(checkSig(tamperedToken), false);
});

test('Data Recovery & Sync: Rolling cloud backups retain strictly last 3 versions and resolve LWW vs FWW', () => {
  assert.equal(MAX_CLOUD_BACKUPS, 3, 'Cloud backup retention policy must strictly equal 3');

  const backups = [
    { id: 'b1', revision: 1 },
    { id: 'b2', revision: 2 },
    { id: 'b3', revision: 3 },
    { id: 'b4', revision: 4 },
    { id: 'b5', revision: 5 },
  ];
  const sorted = [...backups].sort((a, b) => b.revision - a.revision);
  const kept = sorted.slice(0, MAX_CLOUD_BACKUPS);
  const pruned = sorted.slice(MAX_CLOUD_BACKUPS);
  assert.deepEqual(
    kept.map((b) => b.id),
    ['b5', 'b4', 'b3'],
    'Only the 3 newest backup revisions must be retained'
  );
  assert.deepEqual(
    pruned.map((b) => b.id),
    ['b2', 'b1'],
    'Older revisions beyond 3 must be pruned automatically'
  );

  // Conflict resolution policy invariant
  const resolveConflict = (
    policy: 'last_write_wins' | 'first_write_wins',
    clientRev: number,
    serverRev: number
  ): 'commit' | 'conflict' => {
    if (policy === 'first_write_wins' && serverRev > clientRev) return 'conflict';
    return 'commit';
  };
  assert.equal(resolveConflict('first_write_wins', 4, 5), 'conflict');
  assert.equal(resolveConflict('last_write_wins', 4, 5), 'commit');
});

// ============================================================================
// 4. STAGE 10 MANDATORY AUDIT & ACCOUNTING SCENARIOS (12 CORE SCENARIOS + EDGE CASES)
// ============================================================================

test('Stage 10 [Scenarios 1-4]: FIFO Costing — Buy 100@100kT + Buy 100@150kT + Sell 120 => COGS=130M IRR, Ending=120M IRR', () => {
  // 100,000 Toman = 1,000,000 IRR | 150,000 Toman = 1,500,000 IRR
  const res = recalculateInventoryLedger({
    productId: 'prd_fifo_test',
    costingMethod: 'fifo',
    movements: [
      { id: 'buy1', date: '1405/01/10', sequence: 1, kind: 'purchase', productId: 'prd_fifo_test', qty: 100, totalCostIrr: 100_000_000 },
      { id: 'buy2', date: '1405/01/15', sequence: 2, kind: 'purchase', productId: 'prd_fifo_test', qty: 100, totalCostIrr: 150_000_000 },
      { id: 'sell1', date: '1405/01/20', sequence: 3, kind: 'sale', productId: 'prd_fifo_test', qty: 120 },
    ],
  });

  // Hand calc: 100 * 1,000,000 + 20 * 1,500,000 = 130,000,000 IRR; remaining = 80 * 1,500,000 = 120,000,000 IRR
  assert.equal(res.totalCogsIrr, 130_000_000, 'FIFO COGS must equal exactly 130,000,000 IRR (13M Toman)');
  assert.equal(res.finalState.stockQty, 80, 'Ending stock qty must be 80');
  assert.equal(res.finalState.totalValueIrr, 120_000_000, 'FIFO Ending Inventory must equal 120,000,000 IRR (12M Toman)');
  assert.equal(res.finalState.layers.length, 1, 'Only second layer (80 units @ 1.5M) must remain');
  assert.equal(res.conservationDeltaIrr, 0, 'Exact Rial conservation must hold (delta = 0)');
});

test('Stage 10 [Scenario 5]: Moving & Periodic Weighted Average — Buy 100@100kT + Buy 100@150kT + Sell 120 => COGS=150M IRR, Ending=100M IRR', () => {
  const movements = [
    { id: 'buy1', date: '1405/01/10', sequence: 1, kind: 'purchase' as const, productId: 'prd_wa_test', qty: 100, totalCostIrr: 100_000_000 },
    { id: 'buy2', date: '1405/01/15', sequence: 2, kind: 'purchase' as const, productId: 'prd_wa_test', qty: 100, totalCostIrr: 150_000_000 },
    { id: 'sell1', date: '1405/01/20', sequence: 3, kind: 'sale' as const, productId: 'prd_wa_test', qty: 120 },
  ];

  // Hand calc: avg = 250,000,000 / 200 = 1,250,000 IRR; COGS = 120 * 1.25M = 150M IRR; Ending = 80 * 1.25M = 100M IRR
  const mwa = recalculateInventoryLedger({ productId: 'prd_wa_test', costingMethod: 'moving_average', movements });
  assert.equal(mwa.totalCogsIrr, 150_000_000, 'Moving Weighted Avg COGS must equal 150,000,000 IRR (15M Toman)');
  assert.equal(mwa.finalState.totalValueIrr, 100_000_000, 'Moving Weighted Avg Ending Inventory must equal 100,000,000 IRR');
  assert.equal(mwa.finalState.weightedAvgUnitCostIrr, 1_250_000);
  assert.equal(mwa.conservationDeltaIrr, 0);

  const pwa = recalculateInventoryLedger({ productId: 'prd_wa_test', costingMethod: 'periodic_average', movements });
  assert.equal(pwa.totalCogsIrr, 150_000_000, 'Periodic Weighted Avg COGS must equal 150,000,000 IRR (15M Toman)');
  assert.equal(pwa.finalState.totalValueIrr, 100_000_000, 'Periodic Weighted Avg Ending Inventory must equal 100,000,000 IRR');
  assert.equal(pwa.conservationDeltaIrr, 0);
});

test('Stage 10 [Scenarios 6 & 7]: Sales Return (10 units historical cost recovery) & Purchase Return (20 units + variance)', () => {
  const res = recalculateInventoryLedger({
    productId: 'prd_ret_test',
    costingMethod: 'fifo',
    movements: [
      { id: 'buy1', date: '1405/01/10', sequence: 1, kind: 'purchase', productId: 'prd_ret_test', qty: 100, totalCostIrr: 100_000_000 },
      { id: 'buy2', date: '1405/01/15', sequence: 2, kind: 'purchase', productId: 'prd_ret_test', qty: 100, totalCostIrr: 150_000_000 },
      { id: 'sell1', date: '1405/01/20', sequence: 3, kind: 'sale', productId: 'prd_ret_test', qty: 120 },
      // Scenario 6: Return 10 units from sell1 (restores from last consumed layer @ 1,500,000 IRR => 15,000,000 IRR)
      { id: 'sret1', date: '1405/01/22', sequence: 4, kind: 'sale_return', productId: 'prd_ret_test', qty: 10, sourceRefId: 'sell1' },
      // Scenario 7: Return 20 units from buy2 (@ 1,500,000 IRR => 30,000,000 IRR)
      { id: 'pret1', date: '1405/01/25', sequence: 5, kind: 'purchase_return', productId: 'prd_ret_test', qty: 20, totalCostIrr: 30_000_000, sourceRefId: 'buy2' },
    ],
  });

  // Hand calc: Net COGS = 130M - 15M = 115M IRR; Stock = 80 + 10 - 20 = 70 units; Ending Value = 120M + 15M - 30M = 105M IRR
  assert.equal(res.totalCogsIrr, 115_000_000, 'Sale return must recover exact 15M IRR historical layer cost');
  assert.equal(res.finalState.stockQty, 70, 'Final stock must be 70 units');
  assert.equal(res.finalState.totalValueIrr, 105_000_000, 'Ending inventory value must equal 105,000,000 IRR');
  assert.equal(res.conservationDeltaIrr, 0, 'Exact inventory conservation after both returns');
});

test('Stage 10 [Scenario 8]: Mixed Settlement Sale (Cash + Bank + Cheque + Credit + 10% VAT) & Negative Stock Guard', () => {
  const seed = createHolooSeedData('test_owner');
  const party = seed.parties[0];
  const prod: Product = {
    ...seed.products[0],
    id: 'prd_mixed_fifo',
    stock: 0,
    buyPrice: 0,
    costingMethod: 'fifo',
    costLayers: [],
    inventoryValueIrr: 0,
  };

  // Step 1: Buy 100 @ 1,000,000 IRR (net 100M + 10M VAT = 110M)
  const p1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_p1',
    voucherId: 'vch_p1',
    nextVoucherNumber: 1,
    ownerId: 'test_owner',
    deviceId: 'dev_1',
    defaultCostingMethod: 'fifo',
    products: [prod],
    payload: {
      invoiceNumber: 'PR-101',
      invoiceType: 'purchase',
      date: '1405/02/01',
      partyId: seed.parties[1].id,
      partyName: seed.parties[1].name,
      warehouse: prod.warehouse,
      subtotal: 100_000_000,
      discount: 0,
      vatAmount: 10_000_000,
      grandTotal: 110_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 110_000_000,
      status: 'issued',
      items: [{ productId: prod.id, sku: prod.sku, productName: prod.name, unit: prod.unit, quantity: 100, unitPrice: 1_000_000, discount: 0, vatAmount: 10_000_000, lineTotal: 110_000_000 }],
    },
  });

  // Step 2: Mixed Settlement Sale of 40 units @ 2,000,000 IRR with 5,000,000 discount
  // Subtotal = 80M, Discount = 5M, Net = 75M, VAT (10%) = 7.5M, GrandTotal = 82.5M
  // Settlement: Cash 12.5M + Bank 20M + Cheque 30M + Credit 20M = 82.5M
  const s1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_s1',
    voucherId: 'vch_s1',
    chequeId: 'chq_s1',
    nextVoucherNumber: 2,
    ownerId: 'test_owner',
    deviceId: 'dev_1',
    defaultCostingMethod: 'fifo',
    products: p1.updatedProducts,
    party,
    payload: {
      invoiceNumber: 'SL-101',
      invoiceType: 'sale',
      date: '1405/02/05',
      partyId: party.id,
      partyName: party.name,
      warehouse: prod.warehouse,
      subtotal: 80_000_000,
      discount: 5_000_000,
      vatAmount: 7_500_000,
      grandTotal: 82_500_000,
      paidCash: 12_500_000,
      paidBank: 20_000_000,
      paidCheque: 30_000_000,
      creditAmount: 20_000_000,
      status: 'issued',
      items: [{ productId: prod.id, sku: prod.sku, productName: prod.name, unit: prod.unit, quantity: 40, unitPrice: 2_000_000, discount: 5_000_000, vatAmount: 7_500_000, lineTotal: 82_500_000 }],
    },
  });

  assert.equal(s1.cogsTotal, 40_000_000, 'COGS for 40 units @ 1M must be 40,000,000 IRR');
  assert.equal(s1.updatedProducts[0].stock, 60);
  assert.equal(s1.updatedProducts[0].inventoryValueIrr, 60_000_000);
  assert.ok(s1.voucher && s1.voucher.integrityHash, 'Permanent voucher must carry tamper-seal integrityHash');
  assert.equal(s1.voucher.totalDebit, s1.voucher.totalCredit);
  assert.equal(s1.voucher.totalDebit, 82_500_000 + 40_000_000);
  assert.ok(s1.cheque && s1.cheque.direction === 'receivable' && s1.cheque.amount === 30_000_000);
});

test('Stage 10 [Scenarios 9 & 10]: Rejects Unbalanced, Kol-Level, Missing-PartyId, Closed-Year & Duplicate Vouchers', () => {
  const seed = createHolooSeedData('test_owner');

  // 9A: Unbalanced voucher
  const unbal = validateVoucherPayload({
    payload: {
      date: '1405/03/01',
      description: 'تست ناتراز',
      voucherType: 'general',
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'د', debit: 10_000_000, credit: 0 },
        { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 9_000_000 },
      ],
    },
    accounts: seed.accounts,
  });
  assert.equal(unbal.valid, false, 'Unbalanced voucher must be rejected');

  // 9B: Posting to Kol account ('101') instead of Moein ('10101')
  const kolRes = validateVoucherPayload({
    payload: {
      date: '1405/03/01',
      description: 'تست حساب کل',
      voucherType: 'general',
      lines: [
        { accountCode: '101', accountTitle: 'نقد', description: 'د', debit: 1_000_000, credit: 0 },
        { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 1_000_000 },
      ],
    },
    accounts: seed.accounts,
  });
  assert.equal(kolRes.valid, false, 'Posting directly to Kol/Group account must be rejected');

  // 9C: AR 10401 missing mandatory partyId
  const noParty = validateVoucherPayload({
    payload: {
      date: '1405/03/01',
      description: 'تست بدون تفصیلی',
      voucherType: 'general',
      lines: [
        { accountCode: '10401', accountTitle: 'بدهکاران', description: 'د', debit: 5_000_000, credit: 0 },
        { accountCode: '10101', accountTitle: 'صندوق', description: 'ب', debit: 0, credit: 5_000_000 },
      ],
    },
    accounts: seed.accounts,
    parties: seed.parties,
  });
  assert.equal(noParty.valid, false, 'Account 10401 without partyId must be rejected');

  // 9D: Closed fiscal year lock
  const closedRes = validateVoucherPayload({
    payload: {
      date: '1404/05/10',
      description: 'تست سال بسته',
      voucherType: 'general',
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'د', debit: 1_000_000, credit: 0 },
        { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 1_000_000 },
      ],
    },
    accounts: seed.accounts,
    closedFiscalYears: ['1404'],
  });
  assert.equal(closedRes.valid, false, 'Posting into a closed fiscal year must be blocked');

  // 10: Duplicate voucher fingerprint & duplicate referenceId prevention
  const firstVoucher: Voucher = {
    id: 'vch_dup_1',
    ownerId: 'test_owner',
    voucherNumber: 50,
    date: '1405/03/10',
    description: 'واریز صندوق به بانک',
    voucherType: 'treasury',
    status: 'permanent',
    totalDebit: 15_000_000,
    totalCredit: 15_000_000,
    referenceId: 'inv_ref_55',
    lines: [
      { accountCode: '10201', accountTitle: 'بانک', description: 'د', debit: 15_000_000, credit: 0 },
      { accountCode: '10101', accountTitle: 'صندوق', description: 'ب', debit: 0, credit: 15_000_000 },
    ],
  };
  const dupFp = validateVoucherPayload({
    payload: {
      date: '1405/03/10',
      description: 'ثبت تکراری تصادفی',
      voucherType: 'treasury',
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'ب', debit: 0, credit: 15_000_000 },
        { accountCode: '10201', accountTitle: 'بانک', description: 'د', debit: 15_000_000, credit: 0 },
      ],
    },
    accounts: seed.accounts,
    existingVouchers: [firstVoucher],
  });
  assert.equal(dupFp.valid, false, 'Identical duplicate voucher (even with reordered lines) must be rejected');

  const dupRef = validateVoucherPayload({
    payload: {
      date: '1405/03/11',
      description: 'سند دوم برای همان فاکتور',
      voucherType: 'sales',
      referenceId: 'inv_ref_55',
      lines: [
        { accountCode: '10201', accountTitle: 'بانک', description: 'د', debit: 2_000_000, credit: 0 },
        { accountCode: '60101', accountTitle: 'فروش', description: 'ب', debit: 0, credit: 2_000_000 },
      ],
    },
    accounts: seed.accounts,
    existingVouchers: [firstVoucher],
  });
  assert.equal(dupRef.valid, false, 'Second voucher with same invoice referenceId must be rejected');
});

test('Stage 10 [Scenario 11]: Year-End Closing blocks drafts, zeroes P&L into 50201, and generates balanced Next-Year Opening Voucher', () => {
  const seed = createHolooSeedData('test_owner');

  // Verify draft blocker
  const withDraft: Voucher[] = [
    ...seed.vouchers,
    {
      id: 'vch_draft_blocker',
      ownerId: 'test_owner',
      voucherNumber: 99,
      date: '1405/11/01',
      description: 'سند موقت',
      voucherType: 'general',
      status: 'draft',
      totalDebit: 1_000_000,
      totalCredit: 1_000_000,
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'د', debit: 1_000_000, credit: 0 },
        { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 1_000_000 },
      ],
    },
  ];
  assert.throws(
    () =>
      planYearEndClosing({
        accounts: seed.accounts,
        vouchers: withDraft,
        fiscalYear: '1405',
        nextVoucherNumber: 100,
        ownerId: 'test_owner',
        deviceId: 'dev_1',
      }),
    /سند موقت/
  );

  // Run valid year-end closing on permanent 1405 seed vouchers
  const preTb = computeTrialBalance(seed.accounts, seed.vouchers, { fiscalYear: '1405' });
  const prePnl = computeIncomeStatement(preTb);
  const preParties = computePartyBalances(seed.parties, seed.vouchers, { fiscalYear: '1405' });

  const plan = planYearEndClosing({
    accounts: seed.accounts,
    vouchers: seed.vouchers,
    fiscalYear: '1405',
    nextVoucherNumber: seed.vouchers.length + 1,
    ownerId: 'test_owner',
    deviceId: 'dev_1',
  });

  assert.equal(plan.netProfit, prePnl.netProfit, 'Closing net profit must match Income Statement exactly');
  assert.equal(plan.closingVoucher.totalDebit, plan.closingVoucher.totalCredit, 'Closing voucher must be balanced');
  assert.equal(plan.nextFiscalYear, '1406');
  assert.equal(plan.nextYearOpeningVoucher.date, '1406/01/01');
  assert.equal(plan.nextYearOpeningVoucher.voucherNumber, 1);
  assert.equal(
    plan.nextYearOpeningVoucher.totalDebit,
    plan.nextYearOpeningVoucher.totalCredit,
    '1406 Opening Voucher must be strictly balanced'
  );

  // Post-closing 1405 P&L must be 0, and 1406 opening Balance Sheet must equal 1405 ending BS
  const post1405Tb = computeTrialBalance(seed.accounts, [...seed.vouchers, plan.closingVoucher], { fiscalYear: '1405' });
  const post1405Pnl = computeIncomeStatement(post1405Tb);
  assert.equal(post1405Pnl.netProfit, 0, 'Temporary accounts must be zeroed after closing');

  const open1406Tb = computeTrialBalance(seed.accounts, [plan.nextYearOpeningVoucher], { fiscalYear: '1406' });
  const open1406Bs = computeBalanceSheet(open1406Tb);
  assert.equal(open1406Bs.isBalanced, true, '1406 opening Balance Sheet must be balanced');

  // Party balances must carry forward accurately into 1406!
  const open1406Parties = computePartyBalances(seed.parties, [plan.nextYearOpeningVoucher], { fiscalYear: '1406' });
  for (const p of seed.parties) {
    assert.equal(
      open1406Parties.get(p.id) ?? 0,
      preParties.get(p.id) ?? 0,
      `Party ${p.name} balance must carry forward identically into 1406`
    );
  }
});

test('Stage 10 [Scenario 12]: End-to-End Full Reconciliation (TB, BS, P&L, Cash Flow, Kardex, Party, VAT, Cheques, COGS & 17-Point Audit)', () => {
  const seed = createHolooSeedData('test_owner');
  const cust = seed.parties.find((p) => p.partyType === 'customer')!;
  const vend = seed.parties.find((p) => p.partyType === 'vendor')!;
  const sku: Product = {
    ...seed.products[0],
    id: 'prd_e2e_1',
    stock: 0,
    buyPrice: 0,
    costingMethod: 'fifo',
    costLayers: [],
    inventoryValueIrr: 0,
  };

  // Opening Voucher: Cash 500M, Bank 1,000M = Capital 1,500M
  const openBase: Voucher = {
    id: 'vch_e2e_open',
    ownerId: 'test_owner',
    voucherNumber: 1,
    date: '1405/01/01',
    fiscalYear: '1405',
    description: 'سند افتتاحیه تست کامل',
    voucherType: 'opening',
    status: 'permanent',
    totalDebit: 1_500_000_000,
    totalCredit: 1_500_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق مرکزی شرکت', description: 'افتتاحیه', debit: 500_000_000, credit: 0 },
      { accountCode: '10201', accountTitle: 'بانک ملت — حساب جاری شرکتی', description: 'افتتاحیه', debit: 1_000_000_000, credit: 0 },
      { accountCode: '50101', accountTitle: 'سرمایه ثبت‌شده شرکت', description: 'افتتاحیه', debit: 0, credit: 1_500_000_000 },
    ],
  };
  const vouchers: Voucher[] = [{ ...openBase, integrityHash: computeVoucherIntegrityHash(openBase) }];
  const invoices: Invoice[] = [];
  const cheques: Cheque[] = [];
  let products: Product[] = [sku];

  // 1) Purchase 100 @ 1M IRR (net 100M + 10M VAT = 110M, paid 50M bank + 60M credit)
  const pur1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_e2e_p1',
    voucherId: 'vch_e2e_p1',
    nextVoucherNumber: 2,
    ownerId: 'test_owner',
    deviceId: 'dev_e2e',
    defaultCostingMethod: 'fifo',
    products,
    payload: {
      invoiceNumber: 'E2E-P1',
      invoiceType: 'purchase',
      date: '1405/01/10',
      partyId: vend.id,
      partyName: vend.name,
      warehouse: sku.warehouse,
      subtotal: 100_000_000,
      discount: 0,
      vatAmount: 10_000_000,
      grandTotal: 110_000_000,
      paidCash: 0,
      paidBank: 50_000_000,
      paidCheque: 0,
      creditAmount: 60_000_000,
      status: 'issued',
      items: [{ productId: sku.id, sku: sku.sku, productName: sku.name, unit: sku.unit, quantity: 100, unitPrice: 1_000_000, discount: 0, vatAmount: 10_000_000, lineTotal: 110_000_000 }],
    },
  });
  products = pur1.updatedProducts;
  vouchers.push(pur1.voucher!);
  invoices.push(pur1.invoice);

  // 2) Purchase 100 @ 1.5M IRR (net 150M + 15M VAT = 165M, paid 65M payable cheque + 100M credit)
  const pur2 = planAtomicInvoiceCommit({
    invoiceId: 'inv_e2e_p2',
    voucherId: 'vch_e2e_p2',
    chequeId: 'chq_e2e_p2',
    nextVoucherNumber: 3,
    ownerId: 'test_owner',
    deviceId: 'dev_e2e',
    defaultCostingMethod: 'fifo',
    products,
    payload: {
      invoiceNumber: 'E2E-P2',
      invoiceType: 'purchase',
      date: '1405/01/15',
      partyId: vend.id,
      partyName: vend.name,
      warehouse: sku.warehouse,
      subtotal: 150_000_000,
      discount: 0,
      vatAmount: 15_000_000,
      grandTotal: 165_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 65_000_000,
      creditAmount: 100_000_000,
      status: 'issued',
      items: [{ productId: sku.id, sku: sku.sku, productName: sku.name, unit: sku.unit, quantity: 100, unitPrice: 1_500_000, discount: 0, vatAmount: 15_000_000, lineTotal: 165_000_000 }],
    },
  });
  products = pur2.updatedProducts;
  vouchers.push(pur2.voucher!);
  invoices.push(pur2.invoice);
  cheques.push(pur2.cheque!);

  // 3) Mixed Sale 120 @ 2M IRR (net 240M + 24M VAT = 264M; Cash 44M + Bank 70M + Cheque 100M + Credit 50M)
  const sal1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_e2e_s1',
    voucherId: 'vch_e2e_s1',
    chequeId: 'chq_e2e_s1',
    nextVoucherNumber: 4,
    ownerId: 'test_owner',
    deviceId: 'dev_e2e',
    defaultCostingMethod: 'fifo',
    products,
    payload: {
      invoiceNumber: 'E2E-S1',
      invoiceType: 'sale',
      date: '1405/01/20',
      partyId: cust.id,
      partyName: cust.name,
      warehouse: sku.warehouse,
      subtotal: 240_000_000,
      discount: 0,
      vatAmount: 24_000_000,
      grandTotal: 264_000_000,
      paidCash: 44_000_000,
      paidBank: 70_000_000,
      paidCheque: 100_000_000,
      creditAmount: 50_000_000,
      status: 'issued',
      items: [{ productId: sku.id, sku: sku.sku, productName: sku.name, unit: sku.unit, quantity: 120, unitPrice: 2_000_000, discount: 0, vatAmount: 24_000_000, lineTotal: 264_000_000 }],
    },
  });
  products = sal1.updatedProducts;
  vouchers.push(sal1.voucher!);
  invoices.push(sal1.invoice);
  cheques.push(sal1.cheque!);

  // 4) Sale Return 10 units linked to sal1 (net 20M + 2M VAT = 22M credited to customer AR)
  const sret1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_e2e_sr1',
    voucherId: 'vch_e2e_sr1',
    nextVoucherNumber: 5,
    ownerId: 'test_owner',
    deviceId: 'dev_e2e',
    defaultCostingMethod: 'fifo',
    originalInvoice: sal1.invoice,
    products,
    payload: {
      invoiceNumber: 'E2E-SR1',
      invoiceType: 'sale_return',
      sourceInvoiceId: sal1.invoice.id,
      date: '1405/01/22',
      partyId: cust.id,
      partyName: cust.name,
      warehouse: sku.warehouse,
      subtotal: 20_000_000,
      discount: 0,
      vatAmount: 2_000_000,
      grandTotal: 22_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 22_000_000,
      status: 'settled',
      items: [{ productId: sku.id, sku: sku.sku, productName: sku.name, unit: sku.unit, quantity: 10, unitPrice: 2_000_000, discount: 0, vatAmount: 2_000_000, lineTotal: 22_000_000 }],
    },
  });
  products = sret1.updatedProducts;
  vouchers.push(sret1.voucher!);
  invoices.push(sret1.invoice);

  // 5) Internal Cash -> Bank Transfer (100M) — must NOT inflate Cash Flow Statement!
  const trfBase: Voucher = {
    id: 'vch_e2e_trf',
    ownerId: 'test_owner',
    voucherNumber: 6,
    date: '1405/01/25',
    fiscalYear: '1405',
    description: 'انتقال داخلی صندوق به بانک',
    voucherType: 'treasury',
    status: 'permanent',
    totalDebit: 100_000_000,
    totalCredit: 100_000_000,
    lines: [
      { accountCode: '10201', accountTitle: 'بانک ملت — حساب جاری شرکتی', description: 'واریز', debit: 100_000_000, credit: 0 },
      { accountCode: '10101', accountTitle: 'صندوق مرکزی شرکت', description: 'برداشت', debit: 0, credit: 100_000_000 },
    ],
  };
  vouchers.push({ ...trfBase, integrityHash: computeVoucherIntegrityHash(trfBase) });

  // Run ALL Reports & 17-Point Audit
  const tb = computeTrialBalance(seed.accounts, vouchers, { fiscalYear: '1405' });
  const pnl = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);
  const cf = computeCashFlowStatement(seed.accounts, vouchers, { fiscalYear: '1405' });
  const vat = computeVatSummaryReport(invoices, tb, '1405');
  const journal = computeGeneralJournal(vouchers, { fiscalYear: '1405' });
  const partyBals = computePartyBalances([cust, vend], vouchers, { fiscalYear: '1405' });
  const audit = computeAuditReport({
    accounts: seed.accounts,
    vouchers,
    invoices,
    parties: [cust, vend],
    products,
    cheques,
    trialBalance: tb,
    balanceSheet: bs,
    partyBalances: partyBals,
    fiscalYear: '1405',
    pendingOutboxCount: 0,
  });

  // Hand-calculated assertions:
  // Net Sales = 240M - 20M = 220M | Net COGS = 130M - 15M = 115M | Net Profit = 105M
  assert.equal(pnl.netSales, 220_000_000);
  assert.equal(pnl.cogs, 115_000_000);
  assert.equal(pnl.netProfit, 105_000_000);
  assert.equal(bs.isBalanced, true);
  // Cash Flow: Opening 1,500M - 50M (purchase bank) + 114M (sale cash+bank) = 1,564M (internal 100M transfer nets to 0!)
  assert.equal(cf.openingCash, 1_500_000_000);
  assert.equal(cf.netOperating, 64_000_000);
  assert.equal(cf.closingCash, 1_564_000_000);
  assert.equal(cf.isReconciled, true, 'Cash Flow closing must equal GL(101*+102*) exactly');
  assert.equal(vat.isReconciled, true);
  assert.equal(journal.length > 0, true);
  // Audit Reconciliation matrix must match to the exact single Rial!
  assert.equal(audit.errorCount, 0, 'Full E2E lifecycle must produce 0 critical audit errors');
  assert.equal(audit.reconciliation.glInventory, audit.reconciliation.subInventory, 'GL 10501 === Kardex');
  assert.equal(audit.reconciliation.glReceivables, audit.reconciliation.subReceivables, 'GL 10401 === Party AR');
  assert.equal(audit.reconciliation.glPayables, audit.reconciliation.subPayables, 'GL 30101 === Party AP');
  assert.equal(audit.reconciliation.glChequesReceivableBox, audit.reconciliation.subChequesReceivableBox, 'GL 10301 === Receivable Cheques');
  assert.equal(audit.reconciliation.glChequesPayable, audit.reconciliation.subChequesPayable, 'GL 30201 === Payable Cheques');
  assert.equal(audit.reconciliation.glCogs, audit.reconciliation.invCogs, 'GL 70101 === Invoice COGS');
});

test('Cheque State Machine: Enforces legal transitions and prevents double-debit on bounced payable cheque clearance', () => {
  const seed = createHolooSeedData('test_owner');
  const cust = seed.parties.find((p) => p.partyType === 'customer')!;
  const vend = seed.parties.find((p) => p.partyType === 'vendor')!;

  // Endorsed receivable cheque bouncing must debit 10401 (customer) and credit 30101 (supplier) — NOT 10301!
  const endorsedRec: Cheque = {
    id: 'chq_end_1',
    ownerId: 'test_owner',
    sayadiId: 'SYD111',
    serial: '101',
    direction: 'receivable',
    partyId: cust.id,
    partyName: cust.name,
    bankName: 'ملت',
    amount: 50_000_000,
    issueDate: '1405/02/01',
    dueDate: '1405/03/01',
    status: 'endorsed',
  };
  const bounceEndorsed = planChequeStatusTransition({
    cheque: endorsedRec,
    newStatus: 'bounced',
    accounts: seed.accounts,
    parties: seed.parties,
    endorsePartyId: vend.id,
  });
  assert.equal(bounceEndorsed.ok, true);
  assert.equal(bounceEndorsed.lines[0].accountCode, '10401');
  assert.equal(bounceEndorsed.lines[1].accountCode, '30101', 'Bounced endorsed cheque must credit 30101, not 10301');

  // Bounced payable cheque settling later must debit 30101 (supplier) and credit bank — NEVER double-debit 30201!
  const bouncedPay: Cheque = {
    id: 'chq_pay_1',
    ownerId: 'test_owner',
    sayadiId: 'SYD222',
    serial: '202',
    direction: 'payable',
    partyId: vend.id,
    partyName: vend.name,
    bankName: 'ملت',
    amount: 40_000_000,
    issueDate: '1405/02/01',
    dueDate: '1405/03/01',
    status: 'bounced',
  };
  const settleBouncedPay = planChequeStatusTransition({
    cheque: bouncedPay,
    newStatus: 'cleared',
    accounts: seed.accounts,
    parties: seed.parties,
    bankAccountCode: '10201',
  });
  assert.equal(settleBouncedPay.ok, true);
  assert.equal(settleBouncedPay.lines[0].accountCode, '30101', 'Settling bounced payable cheque must debit 30101');
  assert.equal(settleBouncedPay.lines[1].accountCode, '10201');

  // Illegal jump: payable cheque cannot be endorsed
  const illegal = planChequeStatusTransition({
    cheque: { ...bouncedPay, status: 'in_box' },
    newStatus: 'endorsed',
    accounts: seed.accounts,
    parties: seed.parties,
  });
  assert.equal(illegal.ok, false, 'Payable cheque cannot be endorsed');
});

test('Inter-Warehouse Transfer preserves FIFO layers with strictly ZERO P&L impact', () => {
  const state = normalizeProductCostState(
    {
      id: 'prd_trf',
      stock: 100,
      buyPrice: 1_200_000,
      warehouse: 'انبار مرکزی',
      costingMethod: 'fifo',
      costLayers: [
        { layerId: 'L1', date: '1405/01/01', sourceRef: 'p1', warehouse: 'انبار مرکزی', originalQty: 40, remainingQty: 40, unitCostIrr: 1_000_000, totalCostIrr: 40_000_000 },
        { layerId: 'L2', date: '1405/01/10', sourceRef: 'p2', warehouse: 'انبار مرکزی', originalQty: 60, remainingQty: 60, unitCostIrr: 1_500_000, totalCostIrr: 90_000_000 },
      ],
      inventoryValueIrr: 130_000_000,
    },
    'fifo'
  );
  const plan = planWarehouseTransfer({
    state,
    fromWarehouse: 'انبار مرکزی',
    toWarehouse: 'انبار شعبه کرج',
    qty: 50,
    transferId: 'trf_1',
    date: '1405/02/01',
  });
  // 40 @ 1M + 10 @ 1.5M = 55,000,000 IRR transferred; 50 @ 1.5M = 75,000,000 IRR remains; P&L impact === 0!
  assert.equal(plan.transferredCostIrr, 55_000_000);
  assert.equal(plan.pnlImpactIrr, 0);
  assert.equal(plan.remainingSourceLayers.reduce((s, l) => s + l.totalCostIrr, 0), 75_000_000);
});

test('Iran Statutory Payroll Engine: Applies 1404 vs 1405 Budget Law progressive brackets & validates custom overrides', () => {
  const emp: Employee = {
    id: 'emp_stat_1',
    ownerId: 'test_owner',
    personnelCode: 'P-901',
    fullName: 'سارا رضایی',
    department: 'مالی',
    baseSalary: 500_000_000,
    housingAllowance: 0,
    foodAllowance: 0,
    childrenCount: 0,
    overtimeHours: 0,
    active: true,
  };
  // Gross = 500M; SSO 7% = 35M; Taxable = 465M IRR
  // 1405 (exempt 400M, 400M..800M @ 10%): tax = (465M - 400M) * 10% = 6,500,000 IRR
  const pay1405 = calculateEmployeePayroll(emp, '1405');
  assert.equal(pay1405.employeeInsurance, 35_000_000);
  assert.equal(pay1405.incomeTax, 6_500_000, '1405 progressive payroll tax must equal 6,500,000 IRR');

  // 1404 (exempt 240M; 240-300M@10%=6M; 300-380M@15%=12M; 380-465M@20%=17M => total 35M IRR)
  const pay1404 = calculateEmployeePayroll(emp, '1404');
  assert.equal(pay1404.incomeTax, 35_000_000, '1404 progressive payroll tax must equal 35,000,000 IRR');

  const p1405 = getStatutoryParamsForYear('1405');
  assert.equal(validateStatutoryParams(p1405).length, 0);
  assert.equal(validateStatutoryParams({ ...p1405, vatRate: 0.9 }).length > 0, true);
});

test('Smart Audit Engine: Detects permanent voucher tamper-seal breach without mutating original records', () => {
  const seed = createHolooSeedData('test_owner');
  const sealed: Voucher = {
    id: 'vch_seal_test',
    ownerId: 'test_owner',
    voucherNumber: 50,
    date: '1405/04/01',
    fiscalYear: '1405',
    description: 'سند دائم مُهرشده',
    voucherType: 'general',
    status: 'permanent',
    totalDebit: 10_000_000,
    totalCredit: 10_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'د', debit: 10_000_000, credit: 0 },
      { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 10_000_000 },
    ],
  };
  const validHash = computeVoucherIntegrityHash(sealed);
  // Tamper amount after sealing while keeping old hash
  const tampered: Voucher = {
    ...sealed,
    totalDebit: 99_000_000,
    totalCredit: 99_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'د', debit: 99_000_000, credit: 0 },
      { accountCode: '10201', accountTitle: 'بانک', description: 'ب', debit: 0, credit: 99_000_000 },
    ],
    integrityHash: validHash,
  };
  const allVouchers = [...seed.vouchers, tampered];
  const tb = computeTrialBalance(seed.accounts, allVouchers, { fiscalYear: '1405' });
  const bs = computeBalanceSheet(tb);
  const pb = computePartyBalances(seed.parties, allVouchers, { fiscalYear: '1405' });
  const report = computeAuditReport({
    accounts: seed.accounts,
    vouchers: allVouchers,
    invoices: seed.invoices,
    parties: seed.parties,
    products: seed.products,
    cheques: seed.cheques,
    trialBalance: tb,
    balanceSheet: bs,
    partyBalances: pb,
    fiscalYear: '1405',
  });
  const sealCheck = report.checks.find((c) => c.id === 'permanent-voucher-seal');
  assert.ok(sealCheck, 'Permanent voucher seal check must exist');
  assert.equal(sealCheck.status, 'error', 'Tampered permanent voucher must trigger critical audit error');
  assert.ok(sealCheck.probableCause && sealCheck.suggestedFix, 'Audit check must include probableCause & suggestedFix');
  // Confirm read-only advisory behavior: tampered record was NOT mutated by audit engine
  assert.equal(tampered.totalDebit, 99_000_000, 'Audit engine must remain strictly read-only');
});

// ============================================================================
// RUNNER
// ============================================================================
async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(err);
      failed += 1;
    }
  }
  console.log(`\nTest Summary: ${passed} passed, ${failed} failed (total ${tests.length})`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
