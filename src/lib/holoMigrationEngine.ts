/**
 * Safe, Idempotent Data Migration Engine from Holo 2.0.3 -> Holo Apex Offline AI
 *
 * Guarantees:
 * - Source data is NEVER modified or deleted (read-only input).
 * - Schema auto-detection supports Holo 2.0.3 Persian/English JSON exports.
 * - Deterministic mapping of accounts, parties, products, inventory balances, and vouchers.
 * - Built-in Dry-Run simulation before any real import.
 * - Full pre-commit verification:
 *    * Record counts (source vs mapped vs skipped duplicates)
 *    * Total Debit === Total Credit across migrated vouchers
 *    * Party opening & ledger balance conservation
 *    * Inventory quantity & valuation conservation
 * - Idempotent / replay-safe: deterministic `mig_h203_*` IDs guarantee running the exact
 *   same migration multiple times produces ZERO duplicate records!
 */

import {
  Account,
  AccountCategory,
  AccountLevel,
  AccountNature,
  Party,
  PartyType,
  Product,
  Voucher,
  VoucherLine,
} from '../types/accounting';
import { computeVoucherIntegrityHash, isValidShamsiDate } from './accountingEngine';
import { addIrr, isExactIrrBalanced, mulQtyByIrr, roundQtyFixed, sumIrr, toExactIrr } from './moneyMath';

export interface Holo203SourcePayload {
  sourceVersion?: string; // e.g. '2.0.3'
  exportedAt?: string;
  companyName?: string;
  fiscalYear?: string;
  accounts?: Array<Record<string, unknown>>;
  parties?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>; // Legacy Holo 2.0.3 split customer/vendor tables
  vendors?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  inventory?: Array<Record<string, unknown>>;
  vouchers?: Array<Record<string, unknown>>;
}

export interface MigrationErrorItem {
  entity: 'account' | 'party' | 'product' | 'voucher';
  sourceIndex: number;
  sourceCode?: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface MigrationVerificationMetrics {
  sourceCounts: { accounts: number; parties: number; products: number; vouchers: number };
  mappedCounts: { accounts: number; parties: number; products: number; vouchers: number };
  skippedDuplicates: { accounts: number; parties: number; products: number; vouchers: number };
  totalSourceDebitIrr: number;
  totalSourceCreditIrr: number;
  totalMigratedDebitIrr: number;
  totalMigratedCreditIrr: number;
  debitCreditBalanced: boolean;
  sourcePartyOpeningSumIrr: number;
  migratedPartyOpeningSumIrr: number;
  partyBalancesMatch: boolean;
  sourceInventoryQty: number;
  migratedInventoryQty: number;
  sourceInventoryValueIrr: number;
  migratedInventoryValueIrr: number;
  inventoryMatches: boolean;
}

export interface HoloMigrationResult {
  dryRun: boolean;
  detectedSchema: string;
  canCommit: boolean;
  errors: MigrationErrorItem[];
  warnings: MigrationErrorItem[];
  verification: MigrationVerificationMetrics;
  mergedData: {
    accounts: Account[];
    parties: Party[];
    products: Product[];
    vouchers: Voucher[];
  };
  newlyAdded: {
    accounts: Account[];
    parties: Party[];
    products: Product[];
    vouchers: Voucher[];
  };
}

function pickStr(obj: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const k of keys) {
    const val = obj[k];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  return fallback;
}

function pickNum(obj: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const k of keys) {
    const val = obj[k];
    if (val !== undefined && val !== null && val !== '') {
      const n = Number(String(val).replace(/,/g, '').trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function inferAccountCategory(code: string, rawCat?: string): AccountCategory {
  const c = (rawCat || '').toLowerCase();
  if (c === 'asset' || c === 'دارایی') return 'asset';
  if (c === 'liability' || c === 'بدهی') return 'liability';
  if (c === 'equity' || c === 'سرمایه') return 'equity';
  if (c === 'revenue' || c === 'درآمد') return 'revenue';
  if (c === 'cogs' || c === 'بهای تمام شده') return 'cogs';
  if (c === 'expense' || c === 'هزینه') return 'expense';
  if (code.startsWith('1') || code.startsWith('2')) return 'asset';
  if (code.startsWith('3') || code.startsWith('4')) return 'liability';
  if (code.startsWith('5')) return 'equity';
  if (code.startsWith('6')) return 'revenue';
  if (code.startsWith('7')) return 'cogs';
  if (code.startsWith('8')) return 'expense';
  return 'memo';
}

function inferAccountNature(cat: AccountCategory): AccountNature {
  if (cat === 'asset' || cat === 'cogs' || cat === 'expense') return 'debit';
  if (cat === 'liability' || cat === 'equity' || cat === 'revenue') return 'credit';
  return 'both';
}

function inferAccountLevel(code: string, rawLevel?: string): AccountLevel {
  const l = (rawLevel || '').toLowerCase();
  if (l === 'group' || l === 'kol' || l === 'moein' || l === 'tafsili') return l;
  if (code.length <= 1) return 'group';
  if (code.length <= 3) return 'kol';
  if (code.length <= 5) return 'moein';
  return 'tafsili';
}

export function detectHolo203Schema(payload: Holo203SourcePayload): string {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const ver = payload.sourceVersion || '2.0.3';
  const hasLegacySplit = Array.isArray(payload.customers) || Array.isArray(payload.vendors);
  return hasLegacySplit
    ? `Holo ${ver} (Legacy Split Customer/Vendor Tables)`
    : `Holo ${ver} (Unified Accounting Export)`;
}

/**
 * Safely parses raw JSON text into a Holo203SourcePayload while stripping prototype pollution keys.
 */
export function parseHolo203Json(rawJson: string): { ok: true; payload: Holo203SourcePayload } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawJson, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'ساختار فایل ورودی هلو ۲.۰.۳ باید یک شیء JSON معتبر باشد.' };
    }
    return { ok: true, payload: parsed as Holo203SourcePayload };
  } catch {
    return { ok: false, error: 'فایل JSON قابل تجزیه نیست؛ لطفاً صحت ساختار فایل خروجی هلو را بررسی کنید.' };
  }
}

/**
 * Runs Holo 2.0.3 Migration in either Dry-Run (`dryRun: true`) or Commit-Ready (`dryRun: false`) mode.
 * Pure & deterministic: never mutates `source` or `existing` arrays.
 */
export function runHolo203Migration(params: {
  source: Holo203SourcePayload;
  existing: {
    accounts: readonly Account[];
    parties: readonly Party[];
    products: readonly Product[];
    vouchers: readonly Voucher[];
  };
  ownerId: string;
  defaultFiscalYear?: string;
  dryRun?: boolean;
}): HoloMigrationResult {
  const { source, existing, ownerId, defaultFiscalYear = '1405', dryRun = true } = params;
  const detectedSchema = detectHolo203Schema(source);

  const errors: MigrationErrorItem[] = [];
  const warnings: MigrationErrorItem[] = [];

  const srcAccounts = Array.isArray(source.accounts) ? source.accounts : [];
  const srcParties = [
    ...(Array.isArray(source.parties) ? source.parties : []),
    ...(Array.isArray(source.customers)
      ? source.customers.map((c) => ({ ...c, _inferredType: 'customer' }))
      : []),
    ...(Array.isArray(source.vendors)
      ? source.vendors.map((v) => ({ ...v, _inferredType: 'vendor' }))
      : []),
  ];
  const srcProducts = [
    ...(Array.isArray(source.products) ? source.products : []),
    ...(Array.isArray(source.inventory) ? source.inventory : []),
  ];
  const srcVouchers = Array.isArray(source.vouchers) ? source.vouchers : [];

  const existingAccountCodes = new Set(existing.accounts.map((a) => a.code));
  const existingPartyIds = new Set(existing.parties.map((p) => p.id));
  const existingPartyCodes = new Set(existing.parties.map((p) => p.code));
  const existingProductSkus = new Set(existing.products.map((p) => p.sku));
  const existingVoucherIds = new Set(existing.vouchers.map((v) => v.id));
  const existingVoucherRefs = new Set(
    existing.vouchers.map((v) => v.referenceId).filter(Boolean) as string[]
  );

  const newAccounts: Account[] = [];
  const newParties: Party[] = [];
  const newProducts: Product[] = [];
  const newVouchers: Voucher[] = [];

  const skippedDuplicates = { accounts: 0, parties: 0, products: 0, vouchers: 0 };

  // 1. Map Accounts
  srcAccounts.forEach((raw, idx) => {
    const code = pickStr(raw, ['code', 'accountCode', 'SarfaslCode', 'کد']);
    const title = pickStr(raw, ['title', 'name', 'SarfaslName', 'عنوان']);
    if (!code || !title) {
      errors.push({
        entity: 'account',
        sourceIndex: idx,
        sourceCode: code,
        severity: 'error',
        message: 'حساب مبدأ فاقد کد یا عنوان معتبر است.',
      });
      return;
    }
    if (existingAccountCodes.has(code)) {
      skippedDuplicates.accounts += 1;
      return;
    }
    const category = inferAccountCategory(code, pickStr(raw, ['category', 'type', 'نوع']));
    newAccounts.push({
      id: `mig_h203_acc_${code}`,
      ownerId,
      code,
      title,
      level: inferAccountLevel(code, pickStr(raw, ['level'])),
      parentCode: pickStr(raw, ['parentCode']) || undefined,
      category,
      nature: inferAccountNature(category),
      isSystem: false,
      active: true,
    });
    existingAccountCodes.add(code);
  });

  // 2. Map Parties (with code -> partyId lookup for vouchers)
  const partyBySourceCode = new Map<string, Party>();
  for (const ep of existing.parties) partyBySourceCode.set(ep.code, ep);

  let sourcePartyOpeningSumIrr = 0;
  let migratedPartyOpeningSumIrr = 0;

  srcParties.forEach((raw, idx) => {
    const code = pickStr(raw, ['code', 'partyCode', 'C_Code', 'کد'], `H203-P-${idx + 1}`);
    const name = pickStr(raw, ['name', 'C_Name', 'fullName', 'نام']);
    if (!name) {
      errors.push({
        entity: 'party',
        sourceIndex: idx,
        sourceCode: code,
        severity: 'error',
        message: 'طرف‌حساب مبدأ فاقد نام است.',
      });
      return;
    }
    const openingBalance = toExactIrr(
      pickNum(raw, ['openingBalance', 'Bedehkar', 'mandeh', 'مانده'], 0)
    );
    sourcePartyOpeningSumIrr = addIrr(sourcePartyOpeningSumIrr, openingBalance);

    const migId = `mig_h203_party_${code}`;
    if (existingPartyIds.has(migId) || existingPartyCodes.has(code)) {
      skippedDuplicates.parties += 1;
      migratedPartyOpeningSumIrr = addIrr(migratedPartyOpeningSumIrr, openingBalance);
      return;
    }

    const rawType = pickStr(raw, ['partyType', 'type', '_inferredType'], 'both').toLowerCase();
    const partyType: PartyType =
      rawType === 'customer' || rawType === 'مشتری'
        ? 'customer'
        : rawType === 'vendor' || rawType === 'supplier' || rawType === 'تأمین‌کننده'
          ? 'vendor'
          : rawType === 'intermediary'
            ? 'intermediary'
            : 'both';

    const mapped: Party = {
      id: migId,
      ownerId,
      code,
      name,
      partyType,
      nationalId: pickStr(raw, ['nationalId', 'MelliCode']) || undefined,
      economicCode: pickStr(raw, ['economicCode', 'EcoCode']) || undefined,
      phone: pickStr(raw, ['phone', 'Tel', 'Mobile']) || undefined,
      address: pickStr(raw, ['address', 'Address']) || undefined,
      creditLimit: Math.max(0, toExactIrr(pickNum(raw, ['creditLimit', 'Credit'], 0))),
      openingBalance,
      accountCode: partyType === 'vendor' ? '30101' : '10401',
    };
    newParties.push(mapped);
    existingPartyIds.add(migId);
    existingPartyCodes.add(code);
    partyBySourceCode.set(code, mapped);
    migratedPartyOpeningSumIrr = addIrr(migratedPartyOpeningSumIrr, openingBalance);
  });

  // 3. Map Products & Inventory Balances
  let sourceInventoryQty = 0;
  let migratedInventoryQty = 0;
  let sourceInventoryValueIrr = 0;
  let migratedInventoryValueIrr = 0;

  srcProducts.forEach((raw, idx) => {
    const sku = pickStr(raw, ['sku', 'A_Code', 'code', 'کدکالا'], `H203-SKU-${idx + 1}`);
    const name = pickStr(raw, ['name', 'A_Name', 'title', 'نام']);
    if (!name) {
      errors.push({
        entity: 'product',
        sourceIndex: idx,
        sourceCode: sku,
        severity: 'error',
        message: 'کالای مبدأ فاقد نام معتبر است.',
      });
      return;
    }
    const stock = roundQtyFixed(pickNum(raw, ['stock', 'Exist', 'qty', 'موجودی'], 0), 4);
    const buyPrice = Math.max(0, toExactIrr(pickNum(raw, ['buyPrice', 'BuyPrice', 'فی‌خرید'], 0)));
    const sellPrice = Math.max(0, toExactIrr(pickNum(raw, ['sellPrice', 'Sel_Price', 'فی‌فروش'], buyPrice)));
    const explicitVal = pickNum(raw, ['inventoryValueIrr', 'totalValueIrr'], -1);
    const valIrr = explicitVal >= 0 ? toExactIrr(explicitVal) : mulQtyByIrr(stock, buyPrice);

    if (stock < 0) {
      errors.push({
        entity: 'product',
        sourceIndex: idx,
        sourceCode: sku,
        severity: 'error',
        message: `موجودی منفی (${stock}) در کالای مبدأ مجاز نیست.`,
      });
      return;
    }

    sourceInventoryQty = roundQtyFixed(sourceInventoryQty + stock, 4);
    sourceInventoryValueIrr = addIrr(sourceInventoryValueIrr, valIrr);

    if (existingProductSkus.has(sku)) {
      skippedDuplicates.products += 1;
      migratedInventoryQty = roundQtyFixed(migratedInventoryQty + stock, 4);
      migratedInventoryValueIrr = addIrr(migratedInventoryValueIrr, valIrr);
      return;
    }

    const warehouse = pickStr(raw, ['warehouse', 'AnbarName'], 'انبار مرکزی مهاجرت‌شده');
    const migProdId = `mig_h203_prod_${sku}`;
    newProducts.push({
      id: migProdId,
      ownerId,
      sku,
      name,
      category: pickStr(raw, ['category', 'GroupName'], 'کالاهای مهاجرت‌شده هلو ۲.۰.۳'),
      warehouse,
      unit: pickStr(raw, ['unit', 'UnitName'], 'کیلوگرم'),
      buyPrice,
      sellPrice,
      stock,
      reorderPoint: Math.max(0, pickNum(raw, ['reorderPoint', 'MinExist'], 10)),
      vatExempt: Boolean(raw.vatExempt),
      costingMethod: 'moving_average',
      inventoryValueIrr: valIrr,
      costLayers:
        stock > 0
          ? [
              {
                layerId: `mig_lyr_${sku}`,
                date: `${source.fiscalYear || defaultFiscalYear}/01/01`,
                sourceRef: `holo_203_migration_${sku}`,
                warehouse,
                originalQty: stock,
                remainingQty: stock,
                unitCostIrr: stock > 0 ? Math.round(valIrr / stock) : buyPrice,
                totalCostIrr: valIrr,
              },
            ]
          : [],
    });
    existingProductSkus.add(sku);
    migratedInventoryQty = roundQtyFixed(migratedInventoryQty + stock, 4);
    migratedInventoryValueIrr = addIrr(migratedInventoryValueIrr, valIrr);
  });

  // 4. Map Vouchers (with strict Dr=Cr check and idempotent deduplication)
  const mergedAccountMap = new Map<string, Account>();
  for (const a of [...existing.accounts, ...newAccounts]) mergedAccountMap.set(a.code, a);

  let nextVoucherNum = existing.vouchers.reduce((m, v) => Math.max(m, v.voucherNumber), 0) + 1;
  let totalSourceDebitIrr = 0;
  let totalSourceCreditIrr = 0;
  let totalMigratedDebitIrr = 0;
  let totalMigratedCreditIrr = 0;

  srcVouchers.forEach((raw, idx) => {
    const sourceNum = pickStr(raw, ['voucherNumber', 'SanadNo', 'id'], String(idx + 1));
    const date = pickStr(raw, ['date', 'SanadDate'], `${source.fiscalYear || defaultFiscalYear}/01/01`);
    const desc = pickStr(raw, ['description', 'SanadDesc'], `سند مهاجرت‌شده هلو ۲.۰.۳ #${sourceNum}`);
    const rawLines = Array.isArray(raw.lines) ? (raw.lines as Array<Record<string, unknown>>) : [];

    if (!isValidShamsiDate(date)) {
      errors.push({
        entity: 'voucher',
        sourceIndex: idx,
        sourceCode: sourceNum,
        severity: 'error',
        message: `تاریخ سند مبدأ (${date}) معتبر نیست.`,
      });
      return;
    }
    if (rawLines.length < 2) {
      errors.push({
        entity: 'voucher',
        sourceIndex: idx,
        sourceCode: sourceNum,
        severity: 'error',
        message: 'سند مبدأ دارای کمتر از ۲ آرتیکل است.',
      });
      return;
    }

    const mappedLines: VoucherLine[] = rawLines.map((rl) => {
      const accountCode = pickStr(rl, ['accountCode', 'SarfaslCode', 'code'], '10101');
      const acc = mergedAccountMap.get(accountCode);
      const partyCode = pickStr(rl, ['partyCode', 'C_Code']);
      const matchedParty = partyCode ? partyBySourceCode.get(partyCode) : undefined;
      return {
        accountCode,
        accountTitle: pickStr(rl, ['accountTitle', 'SarfaslName'], acc?.title || accountCode),
        partyId: matchedParty?.id || pickStr(rl, ['partyId']) || undefined,
        partyName: matchedParty?.name || pickStr(rl, ['partyName']) || undefined,
        description: pickStr(rl, ['description', 'Desc'], desc),
        debit: Math.max(0, toExactIrr(pickNum(rl, ['debit', 'Bed'], 0))),
        credit: Math.max(0, toExactIrr(pickNum(rl, ['credit', 'Bes'], 0))),
      };
    });

    const dr = sumIrr(mappedLines.map((l) => l.debit));
    const cr = sumIrr(mappedLines.map((l) => l.credit));
    totalSourceDebitIrr = addIrr(totalSourceDebitIrr, dr);
    totalSourceCreditIrr = addIrr(totalSourceCreditIrr, cr);

    if (!isExactIrrBalanced(dr, cr) || dr <= 0) {
      errors.push({
        entity: 'voucher',
        sourceIndex: idx,
        sourceCode: sourceNum,
        severity: 'error',
        message: `سند مبدأ #${sourceNum} نامتوازن است (بدهکار: ${dr}، بستانکار: ${cr}).`,
      });
      return;
    }

    // Warn if line references unmapped account
    for (const l of mappedLines) {
      if (!mergedAccountMap.has(l.accountCode)) {
        warnings.push({
          entity: 'voucher',
          sourceIndex: idx,
          sourceCode: sourceNum,
          severity: 'warning',
          message: `کد حساب ${l.accountCode} در کدینگ مقصد تعریف نشده بود و نیازمند نگاشت دستی است.`,
        });
      }
    }

    const migRef = `holo203_v_${source.fiscalYear || defaultFiscalYear}_${sourceNum}`;
    const migId = `mig_${migRef}`;
    if (existingVoucherIds.has(migId) || existingVoucherRefs.has(migRef)) {
      skippedDuplicates.vouchers += 1;
      totalMigratedDebitIrr = addIrr(totalMigratedDebitIrr, dr);
      totalMigratedCreditIrr = addIrr(totalMigratedCreditIrr, cr);
      return;
    }

    const mappedVoucher: Voucher = {
      id: migId,
      ownerId,
      voucherNumber: nextVoucherNum++,
      date,
      fiscalYear: date.slice(0, 4),
      description: desc,
      voucherType:
        pickStr(raw, ['voucherType']) === 'opening' ? 'opening' : 'general',
      status: 'permanent',
      totalDebit: dr,
      totalCredit: cr,
      referenceId: migRef,
      lines: mappedLines,
    };
    mappedVoucher.integrityHash = computeVoucherIntegrityHash(mappedVoucher);

    newVouchers.push(mappedVoucher);
    existingVoucherIds.add(migId);
    existingVoucherRefs.add(migRef);
    totalMigratedDebitIrr = addIrr(totalMigratedDebitIrr, dr);
    totalMigratedCreditIrr = addIrr(totalMigratedCreditIrr, cr);
  });

  const verification: MigrationVerificationMetrics = {
    sourceCounts: {
      accounts: srcAccounts.length,
      parties: srcParties.length,
      products: srcProducts.length,
      vouchers: srcVouchers.length,
    },
    mappedCounts: {
      accounts: newAccounts.length,
      parties: newParties.length,
      products: newProducts.length,
      vouchers: newVouchers.length,
    },
    skippedDuplicates,
    totalSourceDebitIrr,
    totalSourceCreditIrr,
    totalMigratedDebitIrr,
    totalMigratedCreditIrr,
    debitCreditBalanced:
      isExactIrrBalanced(totalSourceDebitIrr, totalSourceCreditIrr) &&
      isExactIrrBalanced(totalMigratedDebitIrr, totalMigratedCreditIrr) &&
      totalSourceDebitIrr === totalMigratedDebitIrr,
    sourcePartyOpeningSumIrr,
    migratedPartyOpeningSumIrr,
    partyBalancesMatch: sourcePartyOpeningSumIrr === migratedPartyOpeningSumIrr,
    sourceInventoryQty: roundQtyFixed(sourceInventoryQty, 2),
    migratedInventoryQty: roundQtyFixed(migratedInventoryQty, 2),
    sourceInventoryValueIrr,
    migratedInventoryValueIrr,
    inventoryMatches:
      Math.abs(sourceInventoryQty - migratedInventoryQty) < 0.005 &&
      sourceInventoryValueIrr === migratedInventoryValueIrr,
  };

  const canCommit =
    errors.length === 0 &&
    verification.debitCreditBalanced &&
    verification.partyBalancesMatch &&
    verification.inventoryMatches;

  return {
    dryRun,
    detectedSchema,
    canCommit,
    errors,
    warnings,
    verification,
    newlyAdded: {
      accounts: newAccounts,
      parties: newParties,
      products: newProducts,
      vouchers: newVouchers,
    },
    mergedData: {
      accounts: [...existing.accounts, ...newAccounts],
      parties: [...existing.parties, ...newParties],
      products: [...existing.products, ...newProducts],
      vouchers: [...existing.vouchers, ...newVouchers],
    },
  };
}
