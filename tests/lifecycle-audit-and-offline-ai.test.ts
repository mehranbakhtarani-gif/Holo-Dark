import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  computeAuditReport,
  computeBalanceSheet,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
  planAtomicInvoiceCommit,
  planInvoiceCancellation,
  planProformaToSaleConversion,
  planStockAdjustmentWithCostLayers,
  validateVoucherPayload,
} from '../src/lib/accountingEngine';
import {
  buildCopilotFinancialSnapshot,
  computeInventoryIntelligence,
  detectVoucherAnomalies,
} from '../src/lib/smartIntelligence';
import { localCopilotRespond, localParseVoucher } from '../src/lib/localSmallLlm';
import { Cheque, Invoice, Product, Voucher } from '../src/types/accounting';

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

function getGl10501Balance(accounts: ReturnType<typeof createHolooSeedData>['accounts'], vouchers: Voucher[]): number {
  const tb = computeTrialBalance(accounts, vouchers);
  const row = tb.find((r) => r.accountCode === '10501');
  return row ? row.balanceDebit - row.balanceCredit : 0;
}

function getSubledgerInventoryTotal(products: Product[]): number {
  return products.reduce(
    (s, p) =>
      s +
      (typeof p.inventoryValueIrr === 'number' && Number.isFinite(p.inventoryValueIrr)
        ? Math.round(p.inventoryValueIrr)
        : Math.round(p.stock * p.buyPrice)),
    0
  );
}

test('1. Proforma -> Final Sale conversion syncs FIFO costLayers, Sayadi cheque, and GL 10501 to 0 Rial', () => {
  const seed = createHolooSeedData('test_owner');
  const product = seed.products[0];
  const customer = seed.parties.find((p) => p.partyType === 'customer' || p.partyType === 'both')!;
  const initialGlDiff = getGl10501Balance(seed.accounts, seed.vouchers) - getSubledgerInventoryTotal(seed.products);

  const qty = 50;
  const unitPrice = product.sellPrice;
  const subtotal = Math.round(qty * unitPrice);
  const vatAmount = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + vatAmount;
  const paidCheque = Math.round(grandTotal * 0.5);
  const creditAmount = grandTotal - paidCheque;

  const proforma: Invoice = {
    id: 'inv_pf_audit_001',
    ownerId: 'test_owner',
    invoiceNumber: 'PF-1405-9001',
    invoiceType: 'proforma',
    date: '1405/04/10',
    partyId: customer.id,
    partyName: customer.name,
    warehouse: product.warehouse,
    status: 'issued',
    items: [
      {
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        quantity: qty,
        unit: product.unit,
        unitPrice,
        discount: 0,
        vatAmount,
        lineTotal: grandTotal,
      },
    ],
    subtotal,
    discount: 0,
    vatAmount,
    grandTotal,
    paidCash: 0,
    paidBank: 0,
    paidCheque,
    chequeSayadiId: '1234567890123470',
    chequeSerial: 'PF-CHK-001',
    chequeBankName: 'بانک تست',
    chequeIssueDate: '1405/04/10',
    chequeDueDate: '1405/05/10',
    creditAmount,
  };

  // Closed fiscal year guard must block conversion
  assert.throws(
    () =>
      planProformaToSaleConversion({
        proforma,
        conversionDate: '1404/12/20',
        products: seed.products,
        parties: seed.parties,
        existingInvoices: [...seed.invoices, proforma],
        existingVouchers: seed.vouchers,
        costingMethod: 'fifo',
        closedFiscalYears: ['1404'],
        ownerId: 'test_owner',
        voucherId: 'vch_pf_blocked',
        nextVoucherNumber: 999,
      }),
    /بسته شده/
  );

  // Convert in open fiscal year 1405
  const plan = planProformaToSaleConversion({
    proforma,
    conversionDate: '1405/04/15',
    products: seed.products,
    parties: seed.parties,
    existingInvoices: [...seed.invoices, proforma],
    existingVouchers: seed.vouchers,
    costingMethod: 'fifo',
    closedFiscalYears: ['1404'],
    ownerId: 'test_owner',
    voucherId: 'vch_pf_conv_001',
    nextVoucherNumber: seed.vouchers.length + 10,
    chequeId: 'chq_inv_pf_audit_001',
  });

  assert.equal(plan.invoice.invoiceType, 'sale');
  assert.equal(plan.invoice.invoiceNumber, 'F-1405-9001');
  assert.equal(plan.invoice.date, '1405/04/15');
  assert.ok(plan.voucher, 'Sealed voucher must be created on proforma conversion');
  assert.equal(plan.voucher!.totalDebit, plan.voucher!.totalCredit);
  assert.ok(plan.voucher!.integrityHash?.startsWith('vseal_'));
  assert.ok(plan.cheque, 'Sayadi receivable cheque must be created when paidCheque > 0');
  assert.equal(plan.cheque!.direction, 'receivable');
  assert.equal(plan.cheque!.amount, paidCheque);
  assert.ok(
    typeof plan.invoice.items[0].totalCostIrr === 'number' && plan.invoice.items[0].totalCostIrr > 0,
    'Converted sale items must capture exact FIFO totalCostIrr'
  );

  const nextProducts = seed.products.map((p) => {
    const u = plan.updatedProducts.find((x: Product) => x.id === p.id);
    return u ?? p;
  });
  const nextVouchers = [...seed.vouchers, plan.voucher!];
  const afterGlDiff = getGl10501Balance(seed.accounts, nextVouchers) - getSubledgerInventoryTotal(nextProducts);
  assert.equal(
    afterGlDiff,
    initialGlDiff,
    'GL 10501 delta must match FIFO costLayers/inventoryValueIrr delta to exact 0 Rial'
  );
});

test('2. Invoice cancellation sets reversalOfVoucherId, restores costLayers to 0 Rial, and guards progressed cheques', () => {
  const seed = createHolooSeedData('test_owner');
  const product = seed.products[0];
  const customer = seed.parties.find((p) => p.partyType === 'customer' || p.partyType === 'both')!;
  const initialGlDiff = getGl10501Balance(seed.accounts, seed.vouchers) - getSubledgerInventoryTotal(seed.products);

  const qty = 40;
  const subtotal = Math.round(qty * product.sellPrice);
  const vatAmount = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + vatAmount;

  const salePlan = planAtomicInvoiceCommit({
    payload: {
      invoiceNumber: 'F-1405-9100',
      invoiceType: 'sale',
      date: '1405/04/18',
      partyId: customer.id,
      partyName: customer.name,
      warehouse: product.warehouse,
      status: 'settled',
      items: [
        {
          productId: product.id,
          sku: product.sku,
          productName: product.name,
          quantity: qty,
          unit: product.unit,
          unitPrice: product.sellPrice,
          discount: 0,
          vatAmount,
          lineTotal: grandTotal,
        },
      ],
      subtotal,
      discount: 0,
      vatAmount,
      grandTotal,
      paidCash: 0,
      paidBank: 0,
      paidCheque: grandTotal,
      creditAmount: 0,
    },
    products: seed.products,
    party: customer,
    existingInvoices: seed.invoices,
    existingVouchers: seed.vouchers,
    defaultCostingMethod: 'fifo',
    ownerId: 'test_owner',
    deviceId: 'test_dev',
    invoiceId: 'inv_sale_cancel_01',
    voucherId: 'vch_sale_cancel_01',
    nextVoucherNumber: seed.vouchers.length + 20,
    chequeId: 'chq_inv_inv_sale_cancel_01',
  });

  const midProducts = seed.products.map((p) => salePlan.updatedProducts.find((x: Product) => x.id === p.id) ?? p);
  const midVouchers = [...seed.vouchers, salePlan.voucher!];
  const midCheques: Cheque[] = [...seed.cheques, salePlan.cheque!];

  // Guard: If linked cheque was already deposited/cleared, cancellation MUST be blocked!
  const depositedCheques = midCheques.map((c) =>
    c.id === salePlan.cheque!.id ? { ...c, status: 'deposited' as const } : c
  );
  assert.throws(
    () =>
      planInvoiceCancellation({
        invoice: salePlan.invoice,
        cancellationDate: '1405/04/19',
        products: midProducts,
        vouchers: midVouchers,
        cheques: depositedCheques,
        costingMethod: 'fifo',
        ownerId: 'test_owner',
        reversalVoucherId: 'vch_rev_blocked',
        nextVoucherNumber: midVouchers.length + 21,
      }),
    /واگذارشده به بانک/
  );

  // When linked cheque is still in_box, cancellation succeeds atomically
  const cancelPlan = planInvoiceCancellation({
    invoice: salePlan.invoice,
    cancellationDate: '1405/04/19',
    products: midProducts,
    vouchers: midVouchers,
    cheques: midCheques,
    costingMethod: 'fifo',
    ownerId: 'test_owner',
    reversalVoucherId: 'vch_rev_sale_01',
    nextVoucherNumber: midVouchers.length + 21,
  });

  assert.ok(cancelPlan.reversalVoucher, 'Reversal voucher must be created');
  assert.equal(cancelPlan.reversalVoucher!.reversalOfVoucherId, salePlan.voucher!.id);
  assert.deepEqual(cancelPlan.chequeIdsToCancel, [salePlan.cheque!.id]);

  // Reversal voucher MUST pass strict validateVoucherPayload without triggering duplicate referenceId error!
  const validation = validateVoucherPayload({
    payload: {
      date: cancelPlan.reversalVoucher!.date,
      description: cancelPlan.reversalVoucher!.description,
      voucherType: cancelPlan.reversalVoucher!.voucherType,
      referenceId: cancelPlan.reversalVoucher!.referenceId,
      reversalOfVoucherId: cancelPlan.reversalVoucher!.reversalOfVoucherId,
      lines: cancelPlan.reversalVoucher!.lines,
    },
    accounts: seed.accounts,
    parties: seed.parties,
    existingVouchers: midVouchers,
  });
  assert.equal(validation.valid, true, `Reversal validation failed: ${validation.errors.join(' | ')}`);

  const finalProducts = midProducts.map((p) => cancelPlan.updatedProducts.find((x: Product) => x.id === p.id) ?? p);
  const finalVouchers = [...midVouchers, cancelPlan.reversalVoucher!];
  const finalGlDiff = getGl10501Balance(seed.accounts, finalVouchers) - getSubledgerInventoryTotal(finalProducts);
  assert.equal(finalGlDiff, initialGlDiff, 'Cancellation must restore GL 10501 & costLayers to exact 0 Rial drift');
  assert.equal(
    finalProducts.find((p) => p.id === product.id)!.stock,
    product.stock,
    'Product stock must revert to exact pre-sale quantity'
  );
});

test('3. Repeated stocktaking adjustments (shortage + surplus) keep costLayers & GL 10501 synced with unique referenceIds', () => {
  const seed = createHolooSeedData('test_owner');
  const product = seed.products[0];
  const initialGlDiff = getGl10501Balance(seed.accounts, seed.vouchers) - getSubledgerInventoryTotal(seed.products);

  // Shortage (-10 kg)
  const plan1 = planStockAdjustmentWithCostLayers({
    product,
    newStock: product.stock - 10,
    date: '1405/04/20',
    reason: 'کسری باسکول انبارگردانی نوبت اول',
    costingMethod: 'fifo',
    accounts: seed.accounts,
    ownerId: 'test_owner',
    referenceId: 'stk_round_1',
    voucherId: 'vch_stk_1',
    nextVoucherNumber: seed.vouchers.length + 30,
  });
  assert.ok(plan1.voucher);
  assert.equal(plan1.diffQty, -10);

  const productsAfter1 = seed.products.map((p) => (p.id === product.id ? plan1.updatedProduct : p));
  const vouchersAfter1 = [...seed.vouchers, plan1.voucher!];
  assert.equal(
    getGl10501Balance(seed.accounts, vouchersAfter1) - getSubledgerInventoryTotal(productsAfter1),
    initialGlDiff
  );

  // Surplus (+6 kg) on the SAME product must not collide on referenceId!
  const plan2 = planStockAdjustmentWithCostLayers({
    product: plan1.updatedProduct,
    newStock: plan1.updatedProduct.stock + 6,
    date: '1405/04/21',
    reason: 'اضافی شمارش مجدد انبار',
    costingMethod: 'fifo',
    accounts: seed.accounts,
    ownerId: 'test_owner',
    referenceId: 'stk_round_2',
    voucherId: 'vch_stk_2',
    nextVoucherNumber: vouchersAfter1.length + 31,
  });
  assert.ok(plan2.voucher);

  const v2Check = validateVoucherPayload({
    payload: {
      date: plan2.voucher!.date,
      description: plan2.voucher!.description,
      voucherType: plan2.voucher!.voucherType,
      referenceId: plan2.voucher!.referenceId,
      lines: plan2.voucher!.lines,
    },
    accounts: seed.accounts,
    parties: seed.parties,
    existingVouchers: vouchersAfter1,
  });
  assert.equal(v2Check.valid, true, `Second stocktaking validation failed: ${v2Check.errors.join(' | ')}`);

  const productsAfter2 = productsAfter1.map((p) => (p.id === product.id ? plan2.updatedProduct : p));
  const vouchersAfter2 = [...vouchersAfter1, plan2.voucher!];
  assert.equal(
    getGl10501Balance(seed.accounts, vouchersAfter2) - getSubledgerInventoryTotal(productsAfter2),
    initialGlDiff
  );
});

test('4. detectVoucherAnomalies catches missing partyId on 10401/30201 & inventory velocity nets out sale returns', () => {
  const seed = createHolooSeedData('test_owner');
  const anomalies = detectVoucherAnomalies({
    date: '1405/04/22',
    lines: [
      { accountCode: '10401', accountTitle: 'بدهکاران تجاری', description: 'تست', debit: 10_000_000, credit: 0 },
      { accountCode: '30201', accountTitle: 'اسناد پرداختنی', description: 'تست', debit: 0, credit: 10_000_000 },
    ],
    totalDebit: 10_000_000,
    vouchers: seed.vouchers,
    accounts: seed.accounts,
    editingVoucherId: null,
  });
  assert.ok(
    anomalies.some((a) => a.message.includes('۱۰۴') && a.message.includes('۳۰۲')),
    'Anomaly detector must warn about missing partyId on 10401 and 30201'
  );

  const p = seed.products[0];
  const syntheticInvoices: Invoice[] = [
    {
      id: 'inv_v1',
      ownerId: 't',
      invoiceNumber: 'F-1',
      invoiceType: 'sale',
      date: '1405/04/01',
      partyId: 'p1',
      partyName: 'مشتری',
      warehouse: p.warehouse,
      status: 'issued',
      items: [{ productId: p.id, sku: p.sku, productName: p.name, quantity: 600, unit: 'کیلوگرم', unitPrice: 1000, discount: 0, vatAmount: 60000, lineTotal: 660000 }],
      subtotal: 600000,
      discount: 0,
      vatAmount: 60000,
      grandTotal: 660000,
      paidCash: 660000,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 0,
    },
    {
      id: 'inv_v2',
      ownerId: 't',
      invoiceNumber: 'SR-1',
      invoiceType: 'sale_return',
      date: '1405/04/05',
      partyId: 'p1',
      partyName: 'مشتری',
      warehouse: p.warehouse,
      status: 'issued',
      items: [{ productId: p.id, sku: p.sku, productName: p.name, quantity: 300, unit: 'کیلوگرم', unitPrice: 1000, discount: 0, vatAmount: 30000, lineTotal: 330000 }],
      subtotal: 300000,
      discount: 0,
      vatAmount: 30000,
      grandTotal: 330000,
      paidCash: 330000,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 0,
    },
  ];
  const forecasts = computeInventoryIntelligence([p], syntheticInvoices);
  const f = forecasts.get(p.id)!;
  assert.equal(f.soldKgTotal, 300, 'Inventory velocity must net out sale_return from gross sales');
});

test('5. Offline Persian AI assistant natively parses returns/cheques and runs live audit + lifecycle diagnostics', () => {
  const seed = createHolooSeedData('test_owner');
  const customer = seed.parties.find((p) => p.partyType === 'customer' || p.partyType === 'both')!;

  // Sales return parsing must hit 60201 debit, never 60101 credit
  const parsedReturn = localParseVoucher({
    text: `برگشت از فروش ۲۵ میلیون تومان از ${customer.name}`,
    currencyUnit: 'IRT',
    accounts: seed.accounts,
    parties: seed.parties,
  });
  assert.equal(parsedReturn.lines[0].accountCode, '60201');
  assert.equal(parsedReturn.lines[0].debitIrr, 250_000_000);
  assert.equal(parsedReturn.lines[1].partyId, customer.id);

  // Cheque receipt parsing must assign debitPartyId on 10301
  const parsedCheque = localParseVoucher({
    text: `دریافت چک ۱۵ میلیون تومان از ${customer.name}`,
    currencyUnit: 'IRT',
    accounts: seed.accounts,
    parties: seed.parties,
  });
  assert.equal(parsedCheque.lines[0].accountCode, '10301');
  assert.equal(parsedCheque.lines[0].partyId, customer.id);

  // Continuous offline Persian auditing & lifecycle guidance
  const tb = computeTrialBalance(seed.accounts, seed.vouchers);
  const pnl = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);
  const partyBalances = computePartyBalances(seed.parties, seed.vouchers);
  const audit = computeAuditReport({
    accounts: seed.accounts,
    vouchers: seed.vouchers,
    invoices: seed.invoices,
    products: seed.products,
    cheques: seed.cheques,
    parties: seed.parties,
    trialBalance: tb,
    balanceSheet: bs,
    partyBalances,
  });
  const liquidity = tb
    .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
    .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0);

  const snapshot = buildCopilotFinancialSnapshot({
    companyName: 'شرکت بازرگانی نخ پارس (تست)',
    fiscalYear: '1405',
    currencyUnit: 'IRT',
    liquidity,
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
    partyBalances,
    cheques: seed.cheques,
    vouchers: seed.vouchers,
    invoices: seed.invoices,
    auditScore: audit.score,
    auditErrors: audit.errorCount,
    auditWarnings: audit.warningCount,
    auditFindings: audit.checks
      .filter((c) => c.status !== 'pass')
      .map((c) => ({
        id: c.id,
        title: c.title,
        severity: c.status === 'error' ? ('error' as const) : ('warning' as const),
        details: c.details.length > 0 ? c.details.join('؛ ') : c.summary,
      })),
    openSalesOrdersCount: 2,
    dispatchedUninvoicedOrdersCount: 1,
    openImportDossiersCount: 1,
    activeSubcontractJobsCount: 1,
  });

  const auditReply = localCopilotRespond({
    message: 'گزارش حسابرسی دفاتر و تطبیق موجودی انبار با ۱۰۵۰۱ را بررسی کن',
    snapshot,
  });
  assert.ok(auditReply.reply.includes('گزارش حسابرسی هوشمند آفلاین'));
  assert.ok(auditReply.reply.includes('۱۰۵۰۱'));
  assert.ok(auditReply.suggestedActions.some((a) => a.module === 'audit'));

  const lifecycleReply = localCopilotRespond({
    message: 'وضعیت چرخه عمر اسناد، پیش‌فاکتورها و حواله‌های فاکتورنشده چطور است؟',
    snapshot,
  });
  assert.ok(lifecycleReply.reply.includes('پایش چرخه عمر اسناد'));
  assert.ok(lifecycleReply.reply.includes('هشدار چرخه اسناد'));

  const optimizeReply = localCopilotRespond({
    message: 'پیشنهادهای بهینه‌سازی فرآیند مالی چیست؟',
    snapshot,
  });
  assert.ok(optimizeReply.reply.includes('پیشنهادهای هوشمند بهینه‌سازی'));
});

async function run() {
  let passed = 0;
  for (const t of tests) {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  }
  console.log(`\n[Lifecycle Audit & Offline AI] ${passed}/${tests.length} tests passed.`);
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
