import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  computeBalanceSheet,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
  computeVoucherIntegrityHash,
  planAtomicInvoiceCommit,
  planYearEndClosing,
  validateVoucherPayload,
} from '../src/lib/accountingEngine';
import {
  evaluatePeriodClosingChecklist,
  planPeriodReopening,
  runIndependentAuditMode,
  traceAccountLineage,
} from '../src/lib/accountingIntegrityEngine';
import {
  applyReconciliationDecision,
  parseBankStatementInput,
  runBankReconciliation,
} from '../src/lib/bankReconciliationEngine';
import {
  canRoleAccessSensitivity,
  retrieveVerifiedAttachment,
  saveDocumentAttachment,
} from '../src/lib/documentVault';
import { evaluateMultiDeviceSyncState } from '../src/lib/dualCloudSync';
import { computeFinancialForecast } from '../src/lib/financialForecastEngine';
import { parseHolo203Json, runHolo203Migration } from '../src/lib/holoMigrationEngine';
import {
  LocalBackupSnapshot,
  verifyLocalBackupIntegrity,
} from '../src/lib/localBackup';
import {
  addIrr,
  allocateProportionalIrr,
  computeDeterministicHash256,
  isExactIrrBalanced,
  mulQtyByIrr,
  percentOfIrr,
  subIrr,
  sumIrr,
  toExactIrr,
} from '../src/lib/moneyMath';
import {
  computeMultiWarehouseMatrix,
  computeWarehouseProductKardex,
  evaluateWarehouseShortageSurplus,
  executeTrackedWarehouseTransfer,
  receiveTrackedWarehouseTransfer,
  reconcileWarehouseKardex,
} from '../src/lib/multiWarehouseEngine';
import {
  computeSandboxDiff,
  createSandboxSession,
  postSandboxInvoice,
  postSandboxVoucher,
} from '../src/lib/sandboxEngine';
import { CompanyProfile, Invoice, Party, Product, Voucher } from '../src/types/accounting';

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

function makeFreshCleanWorkspace() {
  const seed = createHolooSeedData('owner_test');
  const profile: CompanyProfile = {
    uid: 'owner_test',
    displayName: 'مدیر مالی آزمایشی',
    companyName: 'شرکت آزمایشی هلو اپکس',
    economicCode: '14001234567',
    nationalId: '14001234567',
    fiscalYear: '1405',
    currencyUnit: 'IRR',
    role: 'accountant',
    defaultCostingMethod: 'fifo',
    closedFiscalYears: [],
  };
  const customer: Party = {
    id: 'party_cust_1',
    ownerId: 'owner_test',
    code: '2001',
    name: 'شرکت نساجی بهارستان',
    partyType: 'customer',
    accountCode: '10401',
    nationalId: '10101234567',
    phone: '02144001122',
    creditLimit: 5_000_000_000,
    openingBalance: 0,
  };
  const supplier: Party = {
    id: 'party_sup_1',
    ownerId: 'owner_test',
    code: '3001',
    name: 'بازرگانی تأمین نخ اطلس',
    partyType: 'vendor',
    accountCode: '30101',
    nationalId: '10107654321',
    phone: '02155003344',
    creditLimit: 5_000_000_000,
    openingBalance: 0,
  };
  const product: Product = {
    id: 'prod_yarn_1',
    ownerId: 'owner_test',
    sku: 'YRN-100',
    name: 'نخ پلی‌استر DTY 150/48',
    category: 'نخ پلی‌استر',
    unit: 'کیلوگرم',
    warehouse: 'انبار مرکزی',
    buyPrice: 5_000_000,
    sellPrice: 8_000_000,
    stock: 0,
    reorderPoint: 20,
    vatExempt: false,
    inventoryValueIrr: 0,
    costingMethod: 'fifo',
    costLayers: [],
  };
  return {
    profile,
    accounts: seed.accounts,
    parties: [customer, supplier],
    products: [product],
    vouchers: [] as Voucher[],
    invoices: [] as Invoice[],
    cheques: [] as ReturnType<typeof createHolooSeedData>['cheques'],
    customer,
    supplier,
    product,
  };
}

function makeItem(product: Product, quantity: number, unitPrice: number, vatRate = 10) {
  const lineSub = Math.round(quantity * unitPrice);
  const vatAmount = Math.round((lineSub * vatRate) / 100);
  return {
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    unit: product.unit,
    quantity,
    unitPrice,
    discount: 0,
    vatAmount,
    lineTotal: lineSub + vatAmount,
  };
}

// ============================================================================
// TEST 1: EXPLICIT BALANCE SHEET MANUAL-VS-SYSTEM SCENARIO (END-TO-END)
// ============================================================================
test('1. Balance Sheet Manual-vs-System Full Verification (Vouchers + Purchase + Sales Invoice + Inventory Deduction + Lineage)', () => {
  const ws = makeFreshCleanWorkspace();

  // Step A: Opening Capital Voucher
  // Cash (10101) Dr 200,000,000 | Bank (10201) Dr 800,000,000 | Capital (50101) Cr 1,000,000,000
  const openingVoucher: Voucher = {
    id: 'v_open_1',
    ownerId: 'owner_test',
    voucherNumber: 1,
    date: '1405/01/05',
    fiscalYear: '1405',
    description: 'سند افتتاحیه سرمایه اولیه شرکت',
    voucherType: 'opening',
    status: 'permanent',
    totalDebit: 1_000_000_000,
    totalCredit: 1_000_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق مرکزی شرکت', description: 'موجودی نقد اولیه', debit: 200_000_000, credit: 0 },
      { accountCode: '10201', accountTitle: 'بانک ملت — حساب جاری شرکتی', description: 'موجودی بانک اولیه', debit: 800_000_000, credit: 0 },
      { accountCode: '50101', accountTitle: 'سرمایه اولیه شرکت', description: 'سرمایه ثبت‌شده', debit: 0, credit: 1_000_000_000 },
    ],
  };
  openingVoucher.integrityHash = computeVoucherIntegrityHash(openingVoucher);
  ws.vouchers.push(openingVoucher);

  // Step B: Purchase Invoice — 100 kg @ 5,000,000 IRR = 500,000,000 + 10% VAT 50,000,000 = 550,000,000 (Paid via Bank 10201)
  const purPlan = planAtomicInvoiceCommit({
    invoiceId: 'inv_pur_1',
    voucherId: 'v_pur_1',
    nextVoucherNumber: 2,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PUR-1405-001',
      invoiceType: 'purchase',
      date: '1405/02/10',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 100, 5_000_000, 10)],
      subtotal: 500_000_000,
      discount: 0,
      vatAmount: 50_000_000,
      grandTotal: 550_000_000,
      paidCash: 0,
      paidBank: 550_000_000,
      paidCheque: 0,
      creditAmount: 0,
      status: 'settled',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => purPlan.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(purPlan.invoice);
  if (purPlan.voucher) ws.vouchers.push(purPlan.voucher);

  assert.equal(ws.products[0].stock, 100, 'Stock after purchase must be 100 kg');
  assert.equal(ws.products[0].inventoryValueIrr, 500_000_000, 'Inventory value after purchase must be 500,000,000 IRR');

  // Step C: Sales Invoice — 40 kg @ 8,000,000 IRR = 320,000,000 + 10% VAT 32,000,000 = 352,000,000
  // Settlement: 100,000,000 Cash + 152,000,000 Bank + 100,000,000 Credit (AR)
  // Expected COGS = 40 * 5,000,000 = 200,000,000; Remaining Stock = 60 kg = 300,000,000 IRR
  const salePlan = planAtomicInvoiceCommit({
    invoiceId: 'inv_sale_1',
    voucherId: 'v_sale_1',
    nextVoucherNumber: 3,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'INV-1405-001',
      invoiceType: 'sale',
      date: '1405/03/15',
      partyId: ws.customer.id,
      partyName: ws.customer.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 40, 8_000_000, 10)],
      subtotal: 320_000_000,
      discount: 0,
      vatAmount: 32_000_000,
      grandTotal: 352_000_000,
      paidCash: 100_000_000,
      paidBank: 152_000_000,
      paidCheque: 0,
      creditAmount: 100_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.customer,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => salePlan.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(salePlan.invoice);
  if (salePlan.voucher) ws.vouchers.push(salePlan.voucher);

  // Verify inventory stock properly deducted from 100 -> 60
  assert.equal(ws.products[0].stock, 60, 'Remaining inventory stock must be exactly 60 kg');
  assert.equal(ws.products[0].inventoryValueIrr, 300_000_000, 'Remaining inventory value must be exactly 300,000,000 IRR');

  // Compute Trial Balance, Income Statement, and Balance Sheet
  const tb = computeTrialBalance(ws.accounts, ws.vouchers, { fiscalYear: '1405' });
  const inc = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);

  // Exact Hand-Calculated Expected vs System Actual Assertions
  const assetByCode = new Map(bs.assets.map((a) => [a.code, a.amount]));
  const liabByCode = new Map(bs.liabilities.map((l) => [l.code, l.amount]));
  const eqByCode = new Map(bs.equity.map((e) => [e.code, e.amount]));

  assert.equal(assetByCode.get('10101'), 300_000_000, 'Cash (10101): 200M + 100M = 300M');
  assert.equal(assetByCode.get('10201'), 402_000_000, 'Bank (10201): 800M - 550M + 152M = 402M');
  assert.equal(assetByCode.get('10401'), 100_000_000, 'Accounts Receivable (10401): 100M');
  assert.equal(assetByCode.get('10501'), 300_000_000, 'Inventory (10501): 500M - 200M = 300M');
  assert.equal(assetByCode.get('30302'), 50_000_000, 'Recoverable Purchase VAT (30302): 50M');

  assert.equal(bs.totalAssets, 1_152_000_000, 'Total Assets: 300M + 402M + 100M + 300M + 50M = 1,152,000,000');

  assert.equal(liabByCode.get('30301'), 32_000_000, 'Sales VAT Payable (30301): 32M');
  assert.equal(bs.totalLiabilities, 32_000_000, 'Total Liabilities = 32,000,000');

  assert.equal(inc.netSales, 320_000_000, 'Net Sales = 320,000,000');
  assert.equal(inc.cogs, 200_000_000, 'COGS = 200,000,000');
  assert.equal(inc.netProfit, 120_000_000, 'Net Profit = 320M - 200M = 120,000,000');

  assert.equal(eqByCode.get('50101'), 1_000_000_000, 'Capital (50101) = 1,000,000,000');
  assert.equal(eqByCode.get('90101'), 120_000_000, 'Current Period Profit (90101) = 120,000,000');
  assert.equal(bs.totalEquity, 1_120_000_000, 'Total Equity = 1,120,000,000');

  assert.equal(bs.isBalanced, true, 'Balance Sheet must be balanced');
  assert.equal(bs.difference, 0, 'Assets - (Liabilities + Equity) must equal 0 IRR');

  // Verify Subsidiary Party Balance matches GL 10401
  const partyBalances = computePartyBalances(ws.parties, ws.vouchers, { fiscalYear: '1405' });
  assert.equal(partyBalances.get(ws.customer.id), 100_000_000, 'Customer subsidiary AR must equal 100M');
  assert.equal(partyBalances.get(ws.supplier.id), 0, 'Supplier AP must equal 0');

  // Verify Report -> Voucher -> Invoice Lineage Drill-Down
  const invLineage = traceAccountLineage({
    accountCode: '10501',
    accounts: ws.accounts,
    vouchers: ws.vouchers,
    invoices: ws.invoices,
    cheques: ws.cheques,
    fiscalYear: '1405',
  });
  assert.equal(invLineage.netBalanceIrr, 300_000_000);
  assert.equal(invLineage.entries.length, 2);
  assert.equal(invLineage.entries[0].linkedInvoice?.invoiceNumber, 'PUR-1405-001');
  assert.equal(invLineage.entries[1].linkedInvoice?.invoiceNumber, 'INV-1405-001');
});

// ============================================================================
// TEST 2: EXACT MONEY ARITHMETIC (NO IEEE-754 FLOAT DRIFT)
// ============================================================================
test('2. Exact BigInt/Fixed-Point Money Math & Zero-Drift Apportionment', () => {
  assert.equal(toExactIrr(1000.5), 1001);
  assert.equal(toExactIrr(-1000.5), -1001);
  assert.equal(addIrr(999_999_999_999, 1), 1_000_000_000_000);
  assert.equal(subIrr(1_000_000_000_000, 1), 999_999_999_999);
  assert.equal(mulQtyByIrr(0.3, 1_000_000), 300_000);
  assert.equal(mulQtyByIrr(0.1 + 0.2, 10_000_000), 3_000_000, 'Avoids 3000000.0000000005 float error');
  assert.equal(percentOfIrr(333_333_333, 10), 33_333_333);
  assert.equal(isExactIrrBalanced(123_456_789_012, 123_456_789_012), true);
  assert.equal(isExactIrrBalanced(123_456_789_012, 123_456_789_013), false);

  // Proportional Hamilton Apportionment must preserve exact target total with 0 residual
  const shares = allocateProportionalIrr(1_000_000, [1, 1, 1]);
  assert.equal(sumIrr(shares), 1_000_000);
  assert.deepEqual(shares, [333_334, 333_333, 333_333]);
});

// ============================================================================
// TEST 3: MIXED SETTLEMENT (CASH + BANK + SAYADI CHEQUE) & CREDIT PURCHASE
// ============================================================================
test('3. Credit Purchase + Mixed Sale Settlement with Sayadi Cheque & Treasury Linkage', () => {
  const ws = makeFreshCleanWorkspace();

  const pur = planAtomicInvoiceCommit({
    invoiceId: 'inv_mix_p1',
    voucherId: 'v_mix_p1',
    nextVoucherNumber: 1,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PUR-MIX-01',
      invoiceType: 'purchase',
      date: '1405/04/01',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 50, 4_000_000, 10)],
      subtotal: 200_000_000,
      discount: 0,
      vatAmount: 20_000_000,
      grandTotal: 220_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 220_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => pur.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(pur.invoice);
  if (pur.voucher) ws.vouchers.push(pur.voucher);

  const sale = planAtomicInvoiceCommit({
    invoiceId: 'inv_mix_s1',
    voucherId: 'v_mix_s1',
    chequeId: 'chq_mix_s1',
    nextVoucherNumber: 2,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'INV-MIX-01',
      invoiceType: 'sale',
      date: '1405/04/10',
      partyId: ws.customer.id,
      partyName: ws.customer.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 20, 6_000_000, 10)],
      subtotal: 120_000_000,
      discount: 0,
      vatAmount: 12_000_000,
      grandTotal: 132_000_000,
      paidCash: 12_000_000,
      paidBank: 20_000_000,
      paidCheque: 60_000_000,
      creditAmount: 40_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.customer,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => sale.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(sale.invoice);
  if (sale.voucher) ws.vouchers.push(sale.voucher);
  if (sale.cheque) ws.cheques.push(sale.cheque);

  assert.equal(ws.cheques.length, 1, 'Sayadi cheque must be auto-created in treasury');
  assert.equal(ws.cheques[0].amount, 60_000_000);
  assert.equal(ws.cheques[0].direction, 'receivable');

  const tb = computeTrialBalance(ws.accounts, ws.vouchers, { fiscalYear: '1405' });
  const bs = computeBalanceSheet(tb);
  assert.equal(bs.isBalanced, true);
  assert.equal(bs.difference, 0);

  const partyBal = computePartyBalances(ws.parties, ws.vouchers, { fiscalYear: '1405' });
  assert.equal(partyBal.get(ws.customer.id), 40_000_000, 'Cheque 10301 excluded from open AR; only 40M credit remains');
  assert.equal(partyBal.get(ws.supplier.id), -220_000_000, 'Supplier AP = 220M credit');
});

// ============================================================================
// TEST 4: SALES RETURN & PURCHASE RETURN INTEGRITY
// ============================================================================
test('4. Sales Return & Purchase Return Restore Stock, Reverse COGS/VAT & Preserve Balance Sheet', () => {
  const ws = makeFreshCleanWorkspace();
  const pur = planAtomicInvoiceCommit({
    invoiceId: 'inv_ret_p1',
    voucherId: 'v_ret_p1',
    nextVoucherNumber: 1,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PUR-RET-1',
      invoiceType: 'purchase',
      date: '1405/05/01',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 100, 2_000_000, 10)],
      subtotal: 200_000_000,
      discount: 0,
      vatAmount: 20_000_000,
      grandTotal: 220_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 220_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => pur.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(pur.invoice);
  if (pur.voucher) ws.vouchers.push(pur.voucher);

  const sale = planAtomicInvoiceCommit({
    invoiceId: 'inv_ret_s1',
    voucherId: 'v_ret_s1',
    nextVoucherNumber: 2,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'INV-RET-1',
      invoiceType: 'sale',
      date: '1405/05/05',
      partyId: ws.customer.id,
      partyName: ws.customer.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 30, 3_000_000, 10)],
      subtotal: 90_000_000,
      discount: 0,
      vatAmount: 9_000_000,
      grandTotal: 99_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 99_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.customer,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => sale.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(sale.invoice);
  if (sale.voucher) ws.vouchers.push(sale.voucher);
  assert.equal(ws.products[0].stock, 70);

  // Sales Return of 10 kg
  const saleRet = planAtomicInvoiceCommit({
    invoiceId: 'inv_ret_sr1',
    voucherId: 'v_ret_sr1',
    nextVoucherNumber: 3,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'SRET-1',
      invoiceType: 'sale_return',
      date: '1405/05/08',
      partyId: ws.customer.id,
      partyName: ws.customer.name,
      warehouse: 'انبار مرکزی',
      sourceInvoiceId: sale.invoice.id,
      items: [makeItem(ws.product, 10, 3_000_000, 10)],
      subtotal: 30_000_000,
      discount: 0,
      vatAmount: 3_000_000,
      grandTotal: 33_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 33_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.customer,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
    originalInvoice: sale.invoice,
  });
  ws.products = ws.products.map((p) => saleRet.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(saleRet.invoice);
  if (saleRet.voucher) ws.vouchers.push(saleRet.voucher);
  assert.equal(ws.products[0].stock, 80, 'Sales return of 10 kg restores stock 70 -> 80');

  // Purchase Return of 20 kg
  const purRet = planAtomicInvoiceCommit({
    invoiceId: 'inv_ret_pr1',
    voucherId: 'v_ret_pr1',
    nextVoucherNumber: 4,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PRET-1',
      invoiceType: 'purchase_return',
      date: '1405/05/12',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      sourceInvoiceId: pur.invoice.id,
      items: [makeItem(ws.product, 20, 2_000_000, 10)],
      subtotal: 40_000_000,
      discount: 0,
      vatAmount: 4_000_000,
      grandTotal: 44_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 44_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
    originalInvoice: pur.invoice,
  });
  ws.products = ws.products.map((p) => purRet.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(purRet.invoice);
  if (purRet.voucher) ws.vouchers.push(purRet.voucher);
  assert.equal(ws.products[0].stock, 60, 'Purchase return of 20 kg reduces stock 80 -> 60');
  assert.equal(ws.products[0].inventoryValueIrr, 120_000_000, '60 kg * 2M = 120M');

  const tb = computeTrialBalance(ws.accounts, ws.vouchers, { fiscalYear: '1405' });
  const inc = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);
  assert.equal(inc.netSales, 60_000_000, 'Net Sales = 90M - 30M = 60M');
  assert.equal(inc.cogs, 40_000_000, 'Net COGS = 20 kg * 2M = 40M');
  assert.equal(inc.netProfit, 20_000_000, 'Net Profit = 60M - 40M = 20M');
  assert.equal(bs.isBalanced, true);
  assert.equal(bs.difference, 0);
});

// ============================================================================
// TEST 5: MULTI-LAYER FIFO COSTING
// ============================================================================
test('5. Multi-Layer FIFO Spanning 2 Purchase Layers Produces Exact COGS & Valuation', () => {
  const ws = makeFreshCleanWorkspace();
  // Layer 1: 10 kg @ 1,000,000 = 10,000,000
  const p1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_f_p1',
    voucherId: 'v_f_p1',
    nextVoucherNumber: 1,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PUR-F1',
      invoiceType: 'purchase',
      date: '1405/01/10',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 10, 1_000_000, 0)],
      subtotal: 10_000_000,
      discount: 0,
      vatAmount: 0,
      grandTotal: 10_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 10_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => p1.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(p1.invoice);
  if (p1.voucher) ws.vouchers.push(p1.voucher);

  // Layer 2: 20 kg @ 1,500,000 = 30,000,000
  const p2 = planAtomicInvoiceCommit({
    invoiceId: 'inv_f_p2',
    voucherId: 'v_f_p2',
    nextVoucherNumber: 2,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'PUR-F2',
      invoiceType: 'purchase',
      date: '1405/01/20',
      partyId: ws.supplier.id,
      partyName: ws.supplier.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 20, 1_500_000, 0)],
      subtotal: 30_000_000,
      discount: 0,
      vatAmount: 0,
      grandTotal: 30_000_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 30_000_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.supplier,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => p2.updatedProducts.find((u) => u.id === p.id) || p);
  ws.invoices.push(p2.invoice);
  if (p2.voucher) ws.vouchers.push(p2.voucher);

  // Sale 15 kg -> FIFO consumes 10 @ 1M (10M) + 5 @ 1.5M (7.5M) = 17,500,000 COGS; Remaining = 15 @ 1.5M = 22,500,000
  const s1 = planAtomicInvoiceCommit({
    invoiceId: 'inv_f_s1',
    voucherId: 'v_f_s1',
    nextVoucherNumber: 3,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    payload: {
      invoiceNumber: 'INV-F1',
      invoiceType: 'sale',
      date: '1405/02/01',
      partyId: ws.customer.id,
      partyName: ws.customer.name,
      warehouse: 'انبار مرکزی',
      items: [makeItem(ws.product, 15, 2_500_000, 0)],
      subtotal: 37_500_000,
      discount: 0,
      vatAmount: 0,
      grandTotal: 37_500_000,
      paidCash: 0,
      paidBank: 0,
      paidCheque: 0,
      creditAmount: 37_500_000,
      status: 'issued',
    },
    products: ws.products,
    party: ws.customer,
    existingInvoices: ws.invoices,
    existingVouchers: ws.vouchers,
    closedFiscalYears: [],
    defaultCostingMethod: 'fifo',
  });
  ws.products = ws.products.map((p) => s1.updatedProducts.find((u) => u.id === p.id) || p);
  if (s1.voucher) ws.vouchers.push(s1.voucher);

  const tb = computeTrialBalance(ws.accounts, ws.vouchers, { fiscalYear: '1405' });
  const inc = computeIncomeStatement(tb);
  assert.equal(inc.cogs, 17_500_000, 'FIFO COGS must equal 10*1M + 5*1.5M = 17.5M');
  assert.equal(ws.products[0].stock, 15);
  assert.equal(ws.products[0].inventoryValueIrr, 22_500_000, 'Remaining 15 kg * 1.5M = 22.5M');
});

// ============================================================================
// TEST 6: MULTI-WAREHOUSE MATRIX, TRACKED TRANSFER (0 P&L), KARDEX, SHORTAGE/SURPLUS
// ============================================================================
test('6. Multi-Warehouse Physical/Reserved/Available/In-Transit, Tracked Transfer (0 P&L) & Shortage Control', () => {
  const prod: Product = {
    id: 'p_mw_1',
    ownerId: 'owner_test',
    sku: 'MW-01',
    name: 'نخ ویسکوز ۳۰/۱',
    category: 'نخ ویسکوز',
    unit: 'کیلوگرم',
    warehouse: 'انبار مرکزی',
    buyPrice: 4_000_000,
    sellPrice: 5_500_000,
    stock: 100,
    reorderPoint: 15,
    vatExempt: false,
    inventoryValueIrr: 400_000_000,
    costingMethod: 'fifo',
    costLayers: [
      {
        layerId: 'lay_1',
        date: '1405/01/10',
        sourceRef: 'OPENING-1405',
        warehouse: 'انبار مرکزی',
        originalQty: 100,
        remainingQty: 100,
        unitCostIrr: 4_000_000,
        totalCostIrr: 400_000_000,
      },
    ],
  };

  // Transfer 30 kg immediately to 'انبار شادآباد'
  const trf1 = executeTrackedWarehouseTransfer({
    product: prod,
    fromWarehouse: 'انبار مرکزی',
    toWarehouse: 'انبار شادآباد',
    qty: 30,
    date: '1405/02/05',
    transferNumber: 'TRF-101',
    mode: 'immediate',
    defaultCostingMethod: 'fifo',
  });
  assert.equal(trf1.pnlImpactIrr, 0, 'Inter-warehouse transfer MUST have strictly 0 P&L impact');
  assert.equal(trf1.transferRecord.transferredCostIrr, 120_000_000);
  assert.equal(trf1.updatedProduct.stock, 100, 'Total physical stock across warehouses stays 100 kg');
  assert.equal(trf1.updatedProduct.inventoryValueIrr, 400_000_000, 'Total inventory value stays 400M IRR');

  // Transfer 10 kg in_transit to 'انبار تبریز'
  const trf2 = executeTrackedWarehouseTransfer({
    product: trf1.updatedProduct,
    fromWarehouse: 'انبار مرکزی',
    toWarehouse: 'انبار تبریز',
    qty: 10,
    date: '1405/02/10',
    transferNumber: 'TRF-102',
    mode: 'in_transit',
    defaultCostingMethod: 'fifo',
  });
  assert.equal(trf2.transferRecord.status, 'in_transit');

  const matrix = computeMultiWarehouseMatrix({
    products: [trf2.updatedProduct],
    reservedInvoiceItems: [{ productId: 'p_mw_1', warehouse: 'انبار مرکزی', quantity: 15 }],
    transfers: [trf1.transferRecord, trf2.transferRecord],
    defaultCostingMethod: 'fifo',
  });
  const central = matrix.positions.find((p) => p.warehouse === 'انبار مرکزی');
  const shadabad = matrix.positions.find((p) => p.warehouse === 'انبار شادآباد');
  const tabriz = matrix.positions.find((p) => p.warehouse === 'انبار تبریز');
  assert.ok(central && shadabad && tabriz);
  assert.equal(central.physicalQty, 60);
  assert.equal(central.reservedQty, 15);
  assert.equal(central.availableToSellQty, 45);
  assert.equal(central.inTransitOutQty, 10);
  assert.equal(shadabad.physicalQty, 30);
  assert.equal(tabriz.physicalQty, 0, 'Goods in transit must not be counted as destination physical stock before receipt');
  assert.equal(tabriz.inTransitInQty, 10, 'Goods in transit must remain visible as expected inbound quantity');
  assert.equal(matrix.warehouseSummaries.reduce((sum, row) => sum + row.totalPhysicalQty, 0), 90,
    'Physical warehouse quantities exclude the 10 kg still in transit');
  assert.equal(matrix.warehouseSummaries.find((row) => row.warehouse === 'انبار تبریز')?.totalValuationIrr, 40_000_000,
    'In-transit valuation is attributed to the destination summary without physical quantity');
  assert.equal(matrix.totalPhysicalValuationIrr, 400_000_000,
    'The inventory asset valuation still includes the goods in transit');
  assert.equal(matrix.totalInventoryValuationIrr, 400_000_000);
  assert.equal(matrix.reconciliation.length, 1);
  assert.equal(matrix.reconciliation[0].physicalQty, 90);
  assert.equal(matrix.reconciliation[0].inTransitQty, 10);
  assert.equal(matrix.reconciliation[0].accountedQty, 100);
  assert.equal(matrix.reconciliation[0].accountedValueIrr, 400_000_000);
  assert.equal(matrix.reconciliation[0].isBalanced, true,
    'Physical plus in-transit FIFO layers must reconcile to product stock and inventory asset value');

  // Per-warehouse Kardex
  const shadKardex = computeWarehouseProductKardex({
    product: trf2.updatedProduct,
    warehouse: 'انبار شادآباد',
    invoices: [],
    transfers: [trf1.transferRecord, trf2.transferRecord],
  });
  assert.equal(shadKardex.length, 1);
  assert.equal(shadKardex[0].inQty, 30);
  assert.equal(shadKardex[0].balanceQty, 30);

  // Shortage / Surplus control
  const shortage = evaluateWarehouseShortageSurplus({
    product: trf2.updatedProduct,
    warehouse: 'انبار شادآباد',
    countedQty: 27,
    defaultCostingMethod: 'fifo',
  });
  assert.equal(shortage.kind, 'shortage');
  assert.equal(shortage.varianceQty, -3);
  assert.equal(shortage.varianceValueIrr, -12_000_000);
});

test('A fully depleted transfer source remains visible and reconciles physical plus in-transit FIFO stock', () => {
  const product: Product = {
    id: 'prod_fully_transferred',
    ownerId: 'owner_test',
    sku: 'TRF-FULL',
    name: 'کالای انتقال کامل',
    category: 'آزمایشی',
    unit: 'عدد',
    warehouse: 'انبار مبدأ',
    buyPrice: 200,
    sellPrice: 300,
    stock: 5,
    reorderPoint: 0,
    vatExempt: true,
    inventoryValueIrr: 1_000,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'only_source_layer', date: '1405/01/01', sourceRef: 'purchase_full', warehouse: 'انبار مبدأ', originalQty: 5, remainingQty: 5, unitCostIrr: 200, totalCostIrr: 1_000 },
    ],
  };
  const transfer = executeTrackedWarehouseTransfer({
    product,
    fromWarehouse: 'انبار مبدأ',
    toWarehouse: 'انبار مقصد',
    qty: 5,
    date: '1405/01/02',
    transferNumber: 'TRF-FULL-001',
    mode: 'in_transit',
    defaultCostingMethod: 'fifo',
  });
  const matrix = computeMultiWarehouseMatrix({
    products: [transfer.updatedProduct],
    transfers: [transfer.transferRecord],
    defaultCostingMethod: 'fifo',
  });
  const source = matrix.positions.find((position) => position.warehouse === 'انبار مبدأ');
  const destination = matrix.positions.find((position) => position.warehouse === 'انبار مقصد');
  assert.ok(source && destination);
  assert.equal(source.physicalQty, 0);
  assert.equal(source.inTransitOutQty, 5);
  assert.equal(destination.physicalQty, 0);
  assert.equal(destination.inTransitInQty, 5);
  assert.equal(matrix.reconciliation[0].isBalanced, true);
  assert.equal(matrix.reconciliation[0].accountedQty, 5);
  assert.equal(matrix.reconciliation[0].accountedValueIrr, 1_000);
});

test('Multi-warehouse reconciliation preserves fractional FIFO quantities', () => {
  const product: Product = {
    id: 'prod_fractional_fifo',
    ownerId: 'owner_test',
    sku: 'FRAC-01',
    name: 'کالای کسری',
    category: 'آزمایشی',
    unit: 'کیلوگرم',
    warehouse: 'انبار مرکزی',
    buyPrice: 10_000,
    sellPrice: 12_000,
    stock: 0.1234,
    reorderPoint: 0,
    vatExempt: true,
    inventoryValueIrr: 1_234,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'fractional_layer', date: '1405/01/01', sourceRef: 'purchase_fractional', warehouse: 'انبار مرکزی', originalQty: 0.1234, remainingQty: 0.1234, unitCostIrr: 10_000, totalCostIrr: 1_234 },
    ],
  };
  const matrix = computeMultiWarehouseMatrix({ products: [product], defaultCostingMethod: 'fifo' });
  assert.equal(matrix.positions[0].physicalQty, 0.1234);
  assert.equal(matrix.reconciliation[0].physicalQty, 0.1234);
  assert.equal(matrix.reconciliation[0].isBalanced, true);
});

test('Tracked warehouse transfer preserves fractional FIFO quantity through receipt', () => {
  const product: Product = {
    id: 'prod_fractional_transfer',
    ownerId: 'owner_test',
    sku: 'TRF-FRAC',
    name: 'کالای وزنی کسری',
    category: 'آزمایشی',
    unit: 'کیلوگرم',
    warehouse: 'انبار مبدأ',
    buyPrice: 10_000,
    sellPrice: 12_000,
    stock: 0.1234,
    reorderPoint: 0,
    vatExempt: true,
    inventoryValueIrr: 1_234,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'fractional_source_layer', date: '1405/01/01', sourceRef: 'PUR-FRAC', warehouse: 'انبار مبدأ', originalQty: 0.1234, remainingQty: 0.1234, unitCostIrr: 10_000, totalCostIrr: 1_234 },
    ],
  };
  const dispatched = executeTrackedWarehouseTransfer({
    product,
    fromWarehouse: 'انبار مبدأ',
    toWarehouse: 'انبار مقصد',
    qty: 0.1234,
    date: '1405/01/02',
    transferNumber: 'TRF-FRAC-001',
    mode: 'in_transit',
    defaultCostingMethod: 'fifo',
  });
  assert.equal(dispatched.plan.qty, 0.1234);
  assert.equal(dispatched.transferRecord.qty, 0.1234);
  assert.equal(dispatched.updatedProduct.stock, 0.1234);
  assert.equal(dispatched.updatedProduct.inventoryValueIrr, 1_234);

  const received = receiveTrackedWarehouseTransfer({
    product: dispatched.updatedProduct,
    transfer: dispatched.transferRecord,
    receivedDate: '1405/01/03',
  });
  assert.equal(received.updatedTransfer.status, 'received');
  const destinationKardex = computeWarehouseProductKardex({
    product: received.updatedProduct,
    warehouse: 'انبار مقصد',
    invoices: [],
    transfers: [received.updatedTransfer],
  });
  assert.equal(destinationKardex[0].inQty, 0.1234);
  assert.equal(destinationKardex[0].balanceQty, 0.1234);
});

test('Warehouse Kardex preserves four-decimal fractional quantities', () => {
  const product: Product = {
    id: 'prod_kardex_fractional',
    ownerId: 'owner_test',
    sku: 'KDX-FRAC',
    name: 'کالای وزنی کسری',
    category: 'آزمایشی',
    unit: 'کیلوگرم',
    warehouse: 'انبار مقصد',
    buyPrice: 10_000,
    sellPrice: 12_000,
    stock: 0.1234,
    reorderPoint: 0,
    vatExempt: true,
    inventoryValueIrr: 1_234,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'fractional_received', date: '1405/01/03', sourceRef: 'TRF-FRAC', warehouse: 'انبار مقصد', originalQty: 0.1234, remainingQty: 0.1234, unitCostIrr: 10_000, totalCostIrr: 1_234 },
    ],
  };
  const kardex = computeWarehouseProductKardex({
    product,
    warehouse: 'انبار مقصد',
    invoices: [],
    transfers: [{
      id: 'transfer_fractional',
      transferNumber: 'TRF-FRAC',
      date: '1405/01/02',
      receivedDate: '1405/01/03',
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      fromWarehouse: 'انبار مبدأ',
      toWarehouse: 'انبار مقصد',
      qty: 0.1234,
      transferredCostIrr: 1_234,
      transferredLayers: product.costLayers || [],
      status: 'received',
    }],
  });
  assert.equal(kardex.length, 1);
  assert.equal(kardex[0].inQty, 0.1234);
  assert.equal(kardex[0].balanceQty, 0.1234,
    'Kardex running balances must preserve the same four-decimal precision as FIFO layers');
});

test('Receiving an in-transit transfer moves only its exact FIFO layers and preserves valuation', () => {
  const product: Product = {
    id: 'prod_receive_transfer',
    ownerId: 'owner_test',
    sku: 'TRF-RCV',
    name: 'کالای آزمایشی',
    category: 'آزمایشی',
    unit: 'عدد',
    warehouse: 'انبار مرکزی',
    buyPrice: 100,
    sellPrice: 150,
    stock: 8,
    reorderPoint: 0,
    vatExempt: true,
    inventoryValueIrr: 1_000,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'source_remain', date: '1405/01/01', sourceRef: 'purchase_1', warehouse: 'انبار مرکزی', originalQty: 3, remainingQty: 3, unitCostIrr: 100, totalCostIrr: 300 },
      { layerId: 'trf_transfer_1_purchase_2', date: '1405/01/02', sourceRef: 'purchase_2', warehouse: 'در راه → انبار مقصد', originalQty: 5, remainingQty: 5, unitCostIrr: 140, totalCostIrr: 700 },
    ],
  };
  const transfer = {
    id: 'transfer_1',
    transferNumber: 'TRF-001',
    date: '1405/01/02',
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    fromWarehouse: 'انبار مرکزی',
    toWarehouse: 'انبار مقصد',
    qty: 5,
    transferredCostIrr: 700,
    transferredLayers: [
      { layerId: 'trf_transfer_1_purchase_2', date: '1405/01/02', sourceRef: 'purchase_2', warehouse: 'انبار مقصد', originalQty: 5, remainingQty: 5, unitCostIrr: 140, totalCostIrr: 700 },
    ],
    status: 'in_transit' as const,
  };

  const received = receiveTrackedWarehouseTransfer({
    product,
    transfer,
    receivedDate: '1405/01/03',
  });
  assert.equal(received.updatedTransfer.status, 'received');
  assert.equal(received.updatedTransfer.receivedDate, '1405/01/03');
  assert.equal(received.updatedProduct.stock, 8);
  assert.equal(received.updatedProduct.inventoryValueIrr, 1_000);
  assert.equal(received.updatedProduct.costLayers?.find((l) => l.layerId === 'trf_transfer_1_purchase_2')?.warehouse, 'انبار مقصد');
  assert.equal(received.updatedProduct.costLayers?.find((l) => l.layerId === 'source_remain')?.warehouse, 'انبار مرکزی');
  assert.equal(received.pnlImpactIrr, 0);

  const destinationBeforeReceipt = computeWarehouseProductKardex({
    product,
    warehouse: 'انبار مقصد',
    invoices: [],
    transfers: [transfer],
  });
  assert.equal(destinationBeforeReceipt.length, 0,
    'An in-transit transfer must not appear as a physical inbound Kardex movement before receipt');
  const sourceDuringTransit = computeWarehouseProductKardex({
    product,
    warehouse: 'انبار مرکزی',
    invoices: [],
    transfers: [transfer],
  });
  assert.equal(sourceDuringTransit.length, 1);
  assert.equal(sourceDuringTransit[0].movementType, 'transfer_out');
  assert.equal(sourceDuringTransit[0].outQty, 5);

  const destinationAfterReceipt = computeWarehouseProductKardex({
    product: received.updatedProduct,
    warehouse: 'انبار مقصد',
    invoices: [],
    transfers: [received.updatedTransfer],
  });
  assert.equal(destinationAfterReceipt.length, 1);
  assert.equal(destinationAfterReceipt[0].movementType, 'transfer_in');
  assert.equal(destinationAfterReceipt[0].date, '1405/01/03',
    'The destination Kardex must record the physical receipt date, not dispatch date');
  assert.equal(destinationAfterReceipt[0].inQty, 5);
  assert.equal(destinationAfterReceipt[0].balanceQty, 5);

  const sourceReconciliation = reconcileWarehouseKardex({
    product,
    warehouse: 'انبار مرکزی',
    invoices: [],
    transfers: [transfer],
    openingQty: 8,
    openingValueIrr: 1_000,
    defaultCostingMethod: 'fifo',
  });
  assert.equal(sourceReconciliation.kardexQty, 3);
  assert.equal(sourceReconciliation.physicalQty, 3);
  assert.equal(sourceReconciliation.kardexValueIrr, 300);
  assert.equal(sourceReconciliation.physicalValueIrr, 300);
  assert.equal(sourceReconciliation.isBalanced, true,
    'Source Kardex quantity and value must reconcile after transfer dispatch');

  const destinationReconciliation = reconcileWarehouseKardex({
    product: received.updatedProduct,
    warehouse: 'انبار مقصد',
    invoices: [],
    transfers: [received.updatedTransfer],
    openingQty: 0,
    openingValueIrr: 0,
    defaultCostingMethod: 'fifo',
  });
  assert.equal(destinationReconciliation.kardexQty, 5);
  assert.equal(destinationReconciliation.physicalQty, 5);
  assert.equal(destinationReconciliation.kardexValueIrr, 700);
  assert.equal(destinationReconciliation.physicalValueIrr, 700);
  assert.equal(destinationReconciliation.isBalanced, true,
    'Destination Kardex must reconcile quantity and FIFO value on actual receipt');

  const mismatchedOpening = reconcileWarehouseKardex({
    product,
    warehouse: 'انبار مرکزی',
    invoices: [],
    transfers: [transfer],
    openingQty: 9,
    openingValueIrr: 1_100,
    defaultCostingMethod: 'fifo',
  });
  assert.equal(mismatchedOpening.isBalanced, false,
    'Opening-balance discrepancies must be reported rather than silently normalized');
  assert.equal(mismatchedOpening.isQuantityBalanced, false);
  assert.equal(mismatchedOpening.isValueBalanced, false);

  assert.throws(
    () => receiveTrackedWarehouseTransfer({ product: received.updatedProduct, transfer: received.updatedTransfer, receivedDate: '1405/01/04' }),
    /فقط انتقالی/
  );
  assert.throws(
    () => receiveTrackedWarehouseTransfer({
      product: { ...product, costLayers: product.costLayers?.filter((l) => l.layerId !== 'trf_transfer_1_purchase_2') },
      transfer,
      receivedDate: '1405/01/03',
    }),
    /لایه‌های انتقال/
  );
});

// ============================================================================
// TEST 7: PERIOD CLOSING WIZARD (11 CHECKS), CLOSED LOCK & AUDITED REOPENING
// ============================================================================
test('7. Period Closing Wizard Blocks Drafts, Closes Clean Year, Locks Period & Audits Formal Reopening', () => {
  const ws = makeFreshCleanWorkspace();
  const permV: Voucher = {
    id: 'v_c1',
    ownerId: 'owner_test',
    voucherNumber: 1,
    date: '1405/06/01',
    fiscalYear: '1405',
    description: 'فروش نقدی مستقیم',
    voucherType: 'general',
    status: 'permanent',
    totalDebit: 50_000_000,
    totalCredit: 50_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'دریافت', debit: 50_000_000, credit: 0 },
      { accountCode: '60101', accountTitle: 'فروش', description: 'درآمد فروش', debit: 0, credit: 50_000_000 },
    ],
  };
  permV.integrityHash = computeVoucherIntegrityHash(permV);

  const draftV: Voucher = {
    id: 'v_draft_1',
    ownerId: 'owner_test',
    voucherNumber: 2,
    date: '1405/06/10',
    fiscalYear: '1405',
    description: 'پیش‌نویس هزینه اجاره',
    voucherType: 'general',
    status: 'draft',
    totalDebit: 5_000_000,
    totalCredit: 5_000_000,
    lines: [
      { accountCode: '80201', accountTitle: 'اجاره', description: 'اجاره', debit: 5_000_000, credit: 0 },
      { accountCode: '10101', accountTitle: 'صندوق', description: 'پرداخت', debit: 0, credit: 5_000_000 },
    ],
  };

  // With draft present, wizard MUST block closing
  const blockedWiz = evaluatePeriodClosingChecklist({
    profile: ws.profile,
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: [permV, draftV],
    invoices: [],
    cheques: [],
    assets: [],
  });
  assert.equal(blockedWiz.checks.length, 11, 'Closing wizard must run all 11 statutory checks');
  assert.equal(blockedWiz.canCloseNow, false, 'Draft voucher must block closing');
  assert.equal(blockedWiz.blockingFailureCount, 1);

  // Remove draft -> clean wizard passes
  const cleanWiz = evaluatePeriodClosingChecklist({
    profile: ws.profile,
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: [permV],
    invoices: [],
    cheques: [],
    assets: [],
  });
  assert.equal(cleanWiz.canCloseNow, true, 'Clean period must allow closing');
  assert.equal(cleanWiz.projectedNetProfitIrr, 50_000_000);

  // Generate Closing Voucher & close fiscal year 1405
  const closingPlan = planYearEndClosing({
    accounts: ws.accounts,
    vouchers: [permV],
    fiscalYear: '1405',
    nextVoucherNumber: 2,
    ownerId: 'owner_test',
    deviceId: 'dev_test',
    closedFiscalYears: [],
  });
  assert.ok(closingPlan.closingVoucher && closingPlan.closingVoucher.lines.length >= 2);
  assert.equal(closingPlan.netProfit, 50_000_000);

  // Attempt posting into closed fiscal year 1405 MUST be rejected
  const postInClosed = validateVoucherPayload({
    payload: {
      date: '1405/11/10',
      description: 'تلاش برای ثبت در دوره بسته',
      lines: permV.lines,
      voucherType: 'general',
    },
    accounts: ws.accounts,
    existingVouchers: [permV],
    closedFiscalYears: ['1405'],
  });
  assert.equal(postInClosed.valid, false, 'Posting into closed fiscal year must be blocked');

  // Reopening: non-manager rejected
  const deniedRole = planPeriodReopening({
    fiscalYear: '1405',
    closedFiscalYears: ['1405'],
    reason: 'اصلاح سند مالیاتی حسابرسی',
    operatorName: 'حسابدار',
    operatorRole: 'accountant',
    timestampShamsi: '1405/12/29',
  });
  assert.equal(deniedRole.ok, false, 'Accountant cannot reopen closed fiscal period');

  // Reopening: short reason rejected
  const deniedReason = planPeriodReopening({
    fiscalYear: '1405',
    closedFiscalYears: ['1405'],
    reason: 'اصلاح',
    operatorName: 'مدیر مالی',
    operatorRole: 'finance_manager',
    timestampShamsi: '1405/12/29',
  });
  assert.equal(deniedReason.ok, false, 'Reason shorter than 8 chars must be rejected');

  // Reopening: finance_manager with documented reason succeeds & records full audit trail
  const reopened = planPeriodReopening({
    fiscalYear: '1405',
    closedFiscalYears: ['1405'],
    reason: 'ثبت سند تعدیل سنواتی به درخواست حسابرس رسمی',
    operatorName: 'مدیر مالی',
    operatorRole: 'finance_manager',
    userId: 'uid_mgr',
    deviceId: 'dev_hq',
    timestampShamsi: '1405/12/29',
  });
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  assert.deepEqual(reopened.plan.updatedClosedFiscalYears, []);
  assert.equal(reopened.plan.auditRecord.operationType, 'period_reopen');
  assert.ok(reopened.plan.auditRecord.beforeValue && reopened.plan.auditRecord.afterValue);
});

// ============================================================================
// TEST 8: BANK RECONCILIATION ENGINE
// ============================================================================
test('8. Bank Reconciliation Parses CSV/JSON, Detects Duplicates & Ambiguities, Requires Explicit Confirmation', () => {
  const vouchers: Voucher[] = [
    {
      id: 'v_bnk_1',
      ownerId: 'owner_test',
      voucherNumber: 10,
      date: '1405/08/10',
      fiscalYear: '1405',
      description: 'واریز تسویه فاکتور مشتری',
      voucherType: 'treasury',
      referenceId: 'REF-7788',
      status: 'permanent',
      totalDebit: 50_000_000,
      totalCredit: 50_000_000,
      lines: [
        { accountCode: '10201', accountTitle: 'بانک ملت', description: 'واریز مشتری', debit: 50_000_000, credit: 0 },
        { accountCode: '10401', accountTitle: 'بدهکاران', description: 'تسویه', debit: 0, credit: 50_000_000 },
      ],
    },
    {
      id: 'v_bnk_2',
      ownerId: 'owner_test',
      voucherNumber: 11,
      date: '1405/08/15',
      fiscalYear: '1405',
      description: 'برداشت چک در راه',
      voucherType: 'treasury',
      status: 'permanent',
      totalDebit: 10_000_000,
      totalCredit: 10_000_000,
      lines: [
        { accountCode: '30101', accountTitle: 'بستانکاران', description: 'پرداخت', debit: 10_000_000, credit: 0 },
        { accountCode: '10201', accountTitle: 'بانک ملت', description: 'برداشت', debit: 0, credit: 10_000_000 },
      ],
    },
  ];

  const csv = [
    'تاریخ,شرح,واریز,برداشت,مانده,شماره پیگیری',
    '۱۴۰۵/۰۸/۱۰,واریز مشتری بهارستان,50000000,0,50000000,REF-7788',
    '1405/08/12,کارمزد حواله ساتنا,0,500000,49500000,FEE-1',
    '1405/08/12,کارمزد حواله ساتنا,0,500000,49000000,FEE-1',
  ].join('\n');

  const lines = parseBankStatementInput(csv);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].date, '1405/08/10', 'Persian digits normalized to Latin Shamsi date');

  const report = runBankReconciliation({
    bankAccountCode: '10201',
    statementLines: lines,
    vouchers,
  });

  assert.equal(report.rows[0].confidence, 'exact_ref_amount');
  assert.equal(report.rows[0].reviewStatus, 'pending_review', 'Must NEVER auto-finalize without explicit review');
  assert.equal(report.summary.isFullyReviewed, false);
  assert.equal(report.summary.duplicateStatementCount, 2, 'Duplicate statement rows flagged');
  assert.equal(report.summary.unmatchedBankCount, 2);
  assert.equal(report.summary.unmatchedBookCount, 1, 'Book voucher #11 in-transit detected');
  assert.equal(report.summary.bookEndingBalanceIrr, 40_000_000);
  assert.equal(report.summary.statementEndingBalanceIrr, 49_000_000);
  assert.equal(report.summary.bankVsBookDifferenceIrr, 9_000_000);

  let decisions = applyReconciliationDecision({}, {
    statementRowId: report.rows[0].statementLine.id,
    reviewStatus: 'confirmed',
    linkedVoucherId: 'v_bnk_1',
    linkedVoucherNumber: 10,
    reviewedBy: 'حسابدار خزانه',
  });
  decisions = applyReconciliationDecision(decisions, {
    statementRowId: report.rows[1].statementLine.id,
    reviewStatus: 'adjusted',
    reviewedBy: 'حسابدار خزانه',
  });
  decisions = applyReconciliationDecision(decisions, {
    statementRowId: report.rows[2].statementLine.id,
    reviewStatus: 'rejected',
    reviewedBy: 'حسابدار خزانه',
  });

  const reviewed = runBankReconciliation({
    bankAccountCode: '10201',
    statementLines: lines,
    vouchers,
    priorDecisions: decisions,
  });
  assert.equal(reviewed.summary.isFullyReviewed, true);
  assert.equal(reviewed.summary.confirmedCount, 2);
});

// ============================================================================
// TEST 9: HOLO 2.0.3 SAFE IDEMPOTENT MIGRATION (DRY-RUN, VERIFY, REPLAY-SAFE)
// ============================================================================
test('9. Holo 2.0.3 Migration Dry-Run, Verification Checks & Idempotent 2nd Replay', () => {
  const ws = makeFreshCleanWorkspace();
  const rawHoloJson = JSON.stringify({
    sourceVersion: '2.0.3',
    fiscalYear: '1405',
    accounts: [{ code: '10199', title: 'صندوق شعبه قدیم هلو', category: 'asset' }],
    customers: [{ code: 'C-501', name: 'مشتری قدیمی هلو', openingBalance: 15_000_000 }],
    vendors: [{ code: 'V-901', name: 'تأمین‌کننده قدیمی هلو', openingBalance: -8_000_000 }],
    products: [{ sku: 'OLD-SKU-1', name: 'نخ اکریلیک هلو', stock: 25, buyPrice: 2_000_000, sellPrice: 3_000_000 }],
    vouchers: [
      {
        voucherNumber: 1,
        date: '1405/01/15',
        description: 'سند انتقال مانده از هلو ۲.۰.۳',
        lines: [
          { accountCode: '10199', accountTitle: 'صندوق شعبه قدیم هلو', debit: 50_000_000, credit: 0 },
          { accountCode: '50101', accountTitle: 'سرمایه', debit: 0, credit: 50_000_000 },
        ],
      },
    ],
  });

  const parsed = parseHolo203Json(rawHoloJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const sourceSnapshotBefore = JSON.stringify(parsed.payload);

  const dry = runHolo203Migration({
    source: parsed.payload,
    existing: { accounts: ws.accounts, parties: ws.parties, products: ws.products, vouchers: ws.vouchers },
    ownerId: 'owner_test',
    dryRun: true,
  });
  assert.equal(dry.canCommit, true);
  assert.equal(dry.verification.debitCreditBalanced, true);
  assert.equal(dry.verification.partyBalancesMatch, true);
  assert.equal(dry.verification.inventoryMatches, true);
  assert.equal(dry.newlyAdded.accounts.length, 1);
  assert.equal(dry.newlyAdded.parties.length, 2);
  assert.equal(dry.newlyAdded.products.length, 1);
  assert.equal(dry.newlyAdded.vouchers.length, 1);

  assert.equal(JSON.stringify(parsed.payload), sourceSnapshotBefore, 'Source data must never be mutated');

  const replay = runHolo203Migration({
    source: parsed.payload,
    existing: dry.mergedData,
    ownerId: 'owner_test',
    dryRun: false,
  });
  assert.equal(replay.newlyAdded.accounts.length, 0);
  assert.equal(replay.newlyAdded.parties.length, 0);
  assert.equal(replay.newlyAdded.products.length, 0);
  assert.equal(replay.newlyAdded.vouchers.length, 0);
  assert.equal(replay.mergedData.vouchers.length, dry.mergedData.vouchers.length);
});

// ============================================================================
// TEST 10: MULTI-DEVICE SYNC CONFLICT DETECTION & IDEMPOTENCY
// ============================================================================
test('10. Multi-Device Sync Conflict Detection Halts Silent Overwrite & Deduplicates operationId', () => {
  const seen = new Set<string>(['op_already_done']);

  const dup = evaluateMultiDeviceSyncState({
    operationId: 'op_already_done',
    seenOperationIds: seen,
    localRevision: 5,
    remoteRevision: 5,
    localDeviceId: 'dev_A',
    remoteDeviceId: 'dev_A',
    localSummary: { voucherCount: 10, invoiceCount: 4, productCount: 3, payloadHash: 'h1' },
    remoteSummary: { voucherCount: 10, invoiceCount: 4, productCount: 3, payloadHash: 'h1' },
    policy: 'manual_review',
  });
  assert.equal(dup.resolutionAction, 'idempotent_skip');

  const conflict = evaluateMultiDeviceSyncState({
    operationId: 'op_new_1',
    seenOperationIds: seen,
    localRevision: 5,
    remoteRevision: 6,
    localDeviceId: 'dev_A',
    remoteDeviceId: 'dev_B',
    localSummary: { voucherCount: 11, invoiceCount: 5, productCount: 3, payloadHash: 'hash_local' },
    remoteSummary: { voucherCount: 12, invoiceCount: 5, productCount: 3, payloadHash: 'hash_remote' },
    policy: 'manual_review',
  });
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.requiresManualReview, true);
  assert.equal(conflict.resolutionAction, 'halt_for_manual_merge');
  assert.ok(conflict.conflictFields.length >= 1);

  const fww = evaluateMultiDeviceSyncState({
    operationId: 'op_new_2',
    seenOperationIds: seen,
    localRevision: 5,
    remoteRevision: 6,
    localDeviceId: 'dev_A',
    remoteDeviceId: 'dev_B',
    localSummary: { voucherCount: 11, invoiceCount: 5, productCount: 3, payloadHash: 'hash_local' },
    remoteSummary: { voucherCount: 12, invoiceCount: 5, productCount: 3, payloadHash: 'hash_remote' },
    policy: 'first_write_wins',
  });
  assert.equal(fww.resolutionAction, 'keep_remote');
});

// ============================================================================
// TEST 11: BACKUP INTEGRITY, TAMPERING & CORRUPTION DETECTION
// ============================================================================
test('11. Backup Integrity Verifies Checksum and Detects Tampered/Corrupted Snapshots', () => {
  const payload = JSON.stringify({
    profile: { companyName: 'شرکت هلو' },
    accounts: [{ code: '10101' }],
    vouchers: [{ id: 'v1' }],
    invoices: [],
    products: [],
  });
  const goodSnap: LocalBackupSnapshot = {
    id: 'bk_1',
    schemaVersion: 2,
    checksum256: computeDeterministicHash256(payload),
    savedAt: new Date().toISOString(),
    savedAtShamsi: '1405/08/10',
    reason: 'manual',
    deviceId: 'dev_1',
    deviceLabel: 'دسکتاپ',
    companyName: 'شرکت هلو',
    voucherCount: 1,
    invoiceCount: 0,
    productCount: 0,
    sizeKb: 1,
    payloadJson: payload,
  };

  const okRes = verifyLocalBackupIntegrity(goodSnap);
  assert.equal(okRes.valid, true);
  assert.equal(okRes.checksumVerified, true);

  const tamperedSnap: LocalBackupSnapshot = {
    ...goodSnap,
    payloadJson: payload.replace('10101', '10102'),
  };
  const badRes = verifyLocalBackupIntegrity(tamperedSnap);
  assert.equal(badRes.valid, false);
  assert.equal(badRes.checksumVerified, false);

  const corruptSnap: LocalBackupSnapshot = {
    ...goodSnap,
    checksum256: undefined,
    payloadJson: '{broken_json',
  };
  const corruptRes = verifyLocalBackupIntegrity(corruptSnap);
  assert.equal(corruptRes.valid, false);
});

// ============================================================================
// TEST 12: OFFLINE DOCUMENT VAULT (SHA-256 INTEGRITY & RBAC SENSITIVITY)
// ============================================================================
test('12. Offline Document Vault Enforces MIME Allowlist, SHA-256 Verification & RBAC Sensitivity', async () => {
  const badMime = await saveDocumentAttachment({
    entityType: 'invoice',
    entityId: 'inv_1',
    entityLabel: 'INV-1',
    fileName: 'malware.exe',
    mimeType: 'application/x-msdownload',
    dataUrl: 'data:application/x-msdownload;base64,TVqQ',
    uploadedBy: 'کاربر',
    uploadedByRole: 'finance_manager',
  });
  assert.equal(badMime.ok, false);

  const saved = await saveDocumentAttachment({
    entityType: 'contract',
    entityId: 'cnt_405',
    entityLabel: 'قرارداد تأمین نخ ۴۰۵',
    fileName: 'contract-405.pdf',
    mimeType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    sensitivity: 'restricted',
    uploadedBy: 'مدیر مالی',
    uploadedByRole: 'finance_manager',
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.meta.sha256.length, 64);

  assert.equal(canRoleAccessSensitivity('warehouse_keeper', 'restricted'), false);
  const denied = await retrieveVerifiedAttachment(saved.meta.id, 'warehouse_keeper');
  assert.equal(denied.ok, false);

  const allowed = await retrieveVerifiedAttachment(saved.meta.id, 'auditor_readonly');
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.equal(allowed.integrityValid, true);
  }
});

// ============================================================================
// TEST 13: STRICTLY ISOLATED FINANCIAL FORECASTING
// ============================================================================
test('13. Financial Forecasting Engine Produces 30/60/90-Day Estimates Without Mutating Ledger', () => {
  const seed = createHolooSeedData('owner_test');
  const vouchersBefore = JSON.stringify(seed.vouchers);
  const tb = computeTrialBalance(seed.accounts, seed.vouchers, { fiscalYear: '1405' });

  const forecast = computeFinancialForecast({
    trialBalance: tb,
    vouchers: seed.vouchers,
    invoices: seed.invoices,
    cheques: seed.cheques,
    products: seed.products,
    asOfDate: '1405/08/15',
  });

  assert.equal(forecast.isForecastOnly, true);
  assert.equal(forecast.mutatesLedger, false);
  assert.equal(forecast.horizons.length, 3);
  assert.deepEqual(
    forecast.horizons.map((h) => h.horizonDays),
    [30, 60, 90]
  );
  assert.ok(forecast.disclaimer.length > 10);
  assert.equal(JSON.stringify(seed.vouchers), vouchersBefore, 'Forecast must NEVER mutate vouchers');
});

// ============================================================================
// TEST 14: ISOLATED ACCOUNTING SANDBOX ZERO-LIVE-MUTATION PROOF
// ============================================================================
test('14. Isolated Sandbox Simulates Vouchers/Invoices with Diff Report & Zero Live Data Mutation', () => {
  const ws = makeFreshCleanWorkspace();
  const liveBefore = JSON.stringify({
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: ws.vouchers,
    invoices: ws.invoices,
    cheques: ws.cheques,
  });

  let session = createSandboxSession({
    profile: ws.profile,
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: ws.vouchers,
    invoices: ws.invoices,
    cheques: ws.cheques,
  });

  const vRes = postSandboxVoucher(session, {
    date: '1405/01/05',
    description: 'سند سرمایه آزمایشی',
    voucherType: 'opening',
    status: 'permanent',
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'نقد', debit: 100_000_000, credit: 0 },
      { accountCode: '50101', accountTitle: 'سرمایه', description: 'سرمایه', debit: 0, credit: 100_000_000 },
    ],
  });
  assert.equal(vRes.ok, true);
  if (!vRes.ok) return;
  session = vRes.session;

  const pRes = postSandboxInvoice(session, {
    invoiceNumber: 'SBX-PUR-1',
    invoiceType: 'purchase',
    date: '1405/02/01',
    partyId: ws.supplier.id,
    partyName: ws.supplier.name,
    warehouse: 'انبار مرکزی',
    items: [makeItem(ws.product, 10, 5_000_000, 0)],
    subtotal: 50_000_000,
    discount: 0,
    vatAmount: 0,
    grandTotal: 50_000_000,
    paidCash: 50_000_000,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 0,
    status: 'settled',
  });
  assert.equal(pRes.ok, true, pRes.ok ? '' : pRes.error);
  if (!pRes.ok) return;
  session = pRes.session;

  const { diff } = computeSandboxDiff(session);
  assert.equal(diff.isLiveDataUntouched, true);
  assert.equal(diff.voucherCountDelta, 2);
  assert.equal(diff.invoiceCountDelta, 1);
  assert.equal(diff.deltaAssetsIrr, 100_000_000);
  assert.equal(diff.deltaInventoryValueIrr, 50_000_000);
  assert.equal(diff.sandboxBalanceSheetBalanced, true);

  const liveAfter = JSON.stringify({
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: ws.vouchers,
    invoices: ws.invoices,
    cheques: ws.cheques,
  });
  assert.equal(liveAfter, liveBefore, 'Live workspace MUST remain byte-for-byte identical');
});

// ============================================================================
// TEST 15: INDEPENDENT READ-ONLY AUDIT MODE (14 CONTROLS, 9 FIELDS, ZERO MUTATION)
// ============================================================================
test('15. Independent Audit Mode Executes All 14 Controls Read-Only, Populates All 9 Fields & Detects Injected Defects', () => {
  const ws = makeFreshCleanWorkspace();
  const cleanV: Voucher = {
    id: 'v_aud_1',
    ownerId: 'owner_test',
    voucherNumber: 1,
    date: '1405/01/05',
    fiscalYear: '1405',
    description: 'سرمایه اولیه',
    voucherType: 'opening',
    status: 'permanent',
    totalDebit: 500_000_000,
    totalCredit: 500_000_000,
    lines: [
      { accountCode: '10101', accountTitle: 'صندوق', description: 'نقد', debit: 500_000_000, credit: 0 },
      { accountCode: '50101', accountTitle: 'سرمایه', description: 'سرمایه', debit: 0, credit: 500_000_000 },
    ],
  };
  cleanV.integrityHash = computeVoucherIntegrityHash(cleanV);

  const cleanReport = runIndependentAuditMode({
    profile: ws.profile,
    accounts: ws.accounts,
    parties: ws.parties,
    products: ws.products,
    vouchers: [cleanV],
    invoices: [],
    cheques: [],
    auditLogs: [],
  });
  assert.equal(cleanReport.readOnlyMode, true);
  assert.equal(cleanReport.mutatedRecordCount, 0);
  assert.equal(cleanReport.stats.controlsExecuted, 14);
  assert.equal(cleanReport.criticalErrors.length, 0);
  assert.equal(cleanReport.majorErrors.length, 0);
  assert.equal(cleanReport.healthScore, 100);
  assert.ok(cleanReport.auditorDisclaimer.includes('جایگزین'));

  const brokenV1: Voucher = {
    ...cleanV,
    id: 'v_broken_1',
    voucherNumber: 1,
    totalDebit: 500_000_000,
    totalCredit: 400_000_000,
    integrityHash: 'TAMPERED_HASH',
    lines: [
      { accountCode: '10401', accountTitle: 'بدهکاران', description: 'بدون شخص!', debit: 500_000_000, credit: 0 },
      { accountCode: '50101', accountTitle: 'سرمایه', description: 'سرمایه', debit: 0, credit: 400_000_000 },
    ],
  };
  const dupV2: Voucher = {
    ...cleanV,
    id: 'v_dup_2',
    voucherNumber: 1,
  };
  const orphanInv: Invoice = {
    id: 'inv_orphan_1',
    ownerId: 'owner_test',
    invoiceNumber: 'INV-ORPHAN',
    invoiceType: 'sale',
    date: '1405/03/01',
    partyId: 'non_existent_party',
    partyName: 'شخص یتیم',
    warehouse: 'انبار مرکزی',
    items: [],
    subtotal: 10_000_000,
    discount: 0,
    vatAmount: 1_000_000,
    grandTotal: 11_000_000,
    paidCash: 0,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 11_000_000,
    status: 'issued',
    voucherId: 'missing_voucher_999',
  };
  const negProduct: Product = {
    ...ws.product,
    stock: -5,
    inventoryValueIrr: -25_000_000,
  };

  const inputPayload = {
    profile: ws.profile,
    accounts: ws.accounts,
    parties: ws.parties,
    products: [negProduct],
    vouchers: [brokenV1, dupV2],
    invoices: [orphanInv],
    cheques: [],
    auditLogs: [],
  };
  const beforeStr = JSON.stringify(inputPayload);

  const defectReport = runIndependentAuditMode(inputPayload);
  const afterStr = JSON.stringify(inputPayload);

  assert.equal(afterStr, beforeStr, 'Independent Audit Mode MUST NOT mutate a single byte of input data');
  assert.ok(defectReport.criticalErrors.length >= 3, 'Must flag unbalanced voucher, tampered hash, orphan link, negative stock');
  assert.ok(defectReport.healthScore < 70, 'Health score must drop transparently when critical errors exist');

  for (const f of defectReport.allFindings) {
    assert.ok(f.discrepancyId && f.discrepancyId.length > 0, 'discrepancyId required');
    assert.ok(f.errorType && f.errorType.length > 0, 'errorType required');
    assert.ok(['critical', 'major', 'warning'].includes(f.severity), 'severity required');
    assert.equal(typeof f.discrepancyAmount, 'number', 'discrepancyAmount must be numeric');
    assert.ok(Array.isArray(f.relatedDocuments), 'relatedDocuments must be array');
    assert.ok(f.probableCause && f.probableCause.length > 0, 'probableCause required');
    assert.ok(f.suggestedFix && f.suggestedFix.length > 0, 'suggestedFix required');
    assert.ok(['open', 'in_review', 'resolved', 'accepted_by_auditor'].includes(f.reviewStatus), 'reviewStatus required');
    assert.ok(typeof f.reviewResult === 'string' && f.reviewResult.length > 0, 'reviewResult required');
  }
});

// ============================================================================
// RUNNER
// ============================================================================
async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(err);
      failed++;
    }
  }
  console.log(`\nERP Integrity & Independent Audit Suite: ${passed}/${tests.length} passed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();

test('Warehouse stocktake preserves four-decimal quantities and rejects invalid counts', () => {
  const product: Product = {
    id: 'prod_stocktake_fractional', ownerId: 'owner_test', sku: 'STK-004',
    name: 'کالای شمارش کسری', category: 'آزمایشی', unit: 'کیلوگرم',
    warehouse: 'انبار مرکزی', buyPrice: 1000, sellPrice: 1500, stock: 1,
    reorderPoint: 0, vatExempt: true, inventoryValueIrr: 1000,
    costingMethod: 'fifo',
    costLayers: [{ layerId: 'stocktake_layer', date: '1405/01/01', sourceRef: 'opening',
      warehouse: 'انبار مرکزی', originalQty: 1, remainingQty: 1, unitCostIrr: 1000, totalCostIrr: 1000 }],
  };
  const fractional = evaluateWarehouseShortageSurplus({ product, warehouse: 'انبار مرکزی', countedQty: 0.8765, defaultCostingMethod: 'fifo' });
  assert.equal(fractional.bookQty, 1);
  assert.equal(fractional.countedQty, 0.8765);
  assert.equal(fractional.varianceQty, -0.1235);
  assert.equal(fractional.kind, 'shortage');
  assert.throws(() => evaluateWarehouseShortageSurplus({ product, warehouse: 'انبار مرکزی', countedQty: Number.NaN }), /متناهی و غیرمنفی/);
  assert.throws(() => evaluateWarehouseShortageSurplus({ product, warehouse: 'انبار مرکزی', countedQty: -0.1 }), /متناهی و غیرمنفی/);
});

test('Warehouse matrix preserves four-decimal reserved and in-transit quantities', () => {
  const product: Product = {
    id: 'prod_matrix_fractional', ownerId: 'owner_test', sku: 'MAT-004',
    name: 'کالای ماتریس کسری', category: 'آزمایشی', unit: 'کیلوگرم',
    warehouse: 'انبار مبدأ', buyPrice: 1000, sellPrice: 1500, stock: 1,
    reorderPoint: 0, vatExempt: true, inventoryValueIrr: 1000,
    costingMethod: 'fifo',
    costLayers: [
      { layerId: 'matrix_source', date: '1405/01/01', sourceRef: 'opening', warehouse: 'انبار مبدأ', originalQty: 0.8766, remainingQty: 0.8766, unitCostIrr: 1000, totalCostIrr: 877 },
      { layerId: 'matrix_transit', date: '1405/01/02', sourceRef: 'transfer', warehouse: 'در راه → انبار مقصد', originalQty: 0.1234, remainingQty: 0.1234, unitCostIrr: 1000, totalCostIrr: 123 },
    ],
  };
  const transfer = {
    id: 'matrix_transfer', transferNumber: 'MAT-TRF', date: '1405/01/02',
    productId: product.id, sku: product.sku, productName: product.name,
    fromWarehouse: 'انبار مبدأ', toWarehouse: 'انبار مقصد', qty: 0.1234,
    transferredCostIrr: 123, transferredLayers: [], status: 'in_transit',
  };
  const matrix = computeMultiWarehouseMatrix({
    products: [product], transfers: [transfer],
    reservedInvoiceItems: [{ productId: product.id, warehouse: 'انبار مبدأ', quantity: 0.1234 }],
    defaultCostingMethod: 'fifo',
  });
  const source = matrix.positions.find((position) => position.warehouse === 'انبار مبدأ');
  const destination = matrix.positions.find((position) => position.warehouse === 'انبار مقصد');
  assert.equal(source?.reservedQty, 0.1234);
  assert.equal(source?.availableToSellQty, 0.7532);
  assert.equal(destination?.inTransitInQty, 0.1234);
});
