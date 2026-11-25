import assert from 'node:assert/strict';
import {
  fuzzyFilterAndRank,
  fuzzyScoreFields,
  fuzzyScoreToken,
  getHighlightSegments,
  normalizeFuzzyText,
  stripSeparators,
} from '../src/lib/fuzzySearch';
import { mulQtyByIrr, percentOfIrr, sumIrr, toExactIrr } from '../src/lib/moneyMath';
import {
  formatCompactMoney,
  formatMoney,
  formatNumber,
  normalizeIranianPhoneForWhatsApp,
} from '../src/lib/format';
import {
  createDefaultDashboardLayout,
  isDefaultDashboardLayout,
  normalizeDashboardLayout,
  reorderIds,
  toggleDashboardWidgetVisibility,
} from '../src/lib/dashboardLayout';
import {
  executeFinancialVoiceSearch,
  normalizeSpokenPersianNumbers,
  parseFinancialVoiceQuery,
  type FinancialVoiceSearchDataset,
} from '../src/lib/financialVoiceSearch';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error('   ', err instanceof Error ? err.message : err);
  }
}

console.log('\n[Audit Test Suite] Persian Fuzzy Search & Accounting Math Hardening\n');

// ---------------------------------------------------------------------------
// 1. Strict Persian/Arabic Normalization
// ---------------------------------------------------------------------------
test('normalizes Arabic ي/ى/ئ/ك/أ/إ/آ/ٱ/ة/ۀ/ؤ, diacritics, tatweel, and Persian/Arabic digits', () => {
  assert.equal(normalizeFuzzyText('شركت نساجي و ريسندگي البرز'), 'شرکت نساجی و ریسندگی البرز');
  assert.equal(normalizeFuzzyText('كالاى أصلي إيراني آبي ٱلبرز'), 'کالای اصلی ایرانی ابی البرز');
  assert.equal(normalizeFuzzyText('فاكتورِ پيش‌فروشِ — ١٤٠٤/٠٨/١٢'), 'فاکتور پیش فروش — 1404/08/12');
  assert.equal(normalizeFuzzyText('مالیاتِ ارزش‌افزودۀ ۱۰٪'), 'مالیات ارزش افزوده 10٪');
  assert.equal(normalizeFuzzyText('مؤدیانِ كــد ۰۱۲۳۴۵۶۷۸۹'), 'مودیان کد 0123456789');
  assert.equal(normalizeFuzzyText('پیش\u200cفاکتور\u200f\ufeff'), 'پیش فاکتور');
});

test('stripSeparators strips Persian thousands separator (٬), ZWNJ, hyphens, slashes, and commas', () => {
  assert.equal(stripSeparators(normalizeFuzzyText('۱۸۵٬۰۰۰٬۰۰۰')), '185000000');
  assert.equal(stripSeparators(normalizeFuzzyText('F-1404-101')), 'f1404101');
  assert.equal(stripSeparators(normalizeFuzzyText('پیش‌فاکتور')), 'پیشفاکتور');
});

// ---------------------------------------------------------------------------
// 2. ZWNJ (نیم‌فاصله) & Compound Word Equivalence
// ---------------------------------------------------------------------------
test('matches ZWNJ compound words seamlessly across all 3 forms (ZWNJ / space / joined)', () => {
  const forms = ['پیش‌فاکتور فروش', 'پیش فاکتور فروش', 'پیشفاکتور فروش'];
  const queries = ['پیش‌فاکتور', 'پیش فاکتور', 'پیشفاکتور', 'پيش‌فاكتور', 'پيشفاكتور'];

  for (const target of forms) {
    for (const q of queries) {
      const res = fuzzyScoreFields(q, [{ text: target, weight: 1 }]);
      assert.ok(
        res.score >= 85,
        `Expected high score for query "${q}" against "${target}", got ${res.score}`
      );
    }
  }

  const partyRes = fuzzyScoreToken('طرفحساب', 'گزارش مانده طرف‌حساب‌های بدهکار');
  assert.ok(partyRes.score >= 85, `Expected compound pair match for طرفحساب, got ${partyRes.score}`);
});

// ---------------------------------------------------------------------------
// 3. Multi-Field Accounting Data, Swapped Order, Partial Words, Stopwords
// ---------------------------------------------------------------------------
test('matches accounting records with swapped word order, partial tokens, and Arabic chars', () => {
  const accounts = [
    { code: '10201', title: 'موجودی بانک ملت شعبه مرکزی', level: 'معین' },
    { code: '10401', title: 'حساب‌های دریافتنی تجاری (مشتریان)', level: 'معین' },
    { code: '40101', title: 'فروش نخ پلی‌استر و ویسکوز', level: 'کل' },
    { code: '50102', title: 'بهای تمام‌شده کالای فروش‌رفته', level: 'معین' },
  ];

  // Swapped words + Arabic chars + Persian digits
  const r1 = fuzzyFilterAndRank(accounts, 'مركزي ملت ۱۰۲۰۱', (a) => [
    { text: a.code, weight: 1.4 },
    { text: a.title, weight: 1.2 },
    { text: a.level, weight: 0.8 },
  ]);
  assert.equal(r1[0]?.item.code, '10201');

  // Stopword tolerance ("نخ و پلی استر" matches "فروش نخ پلی‌استر و ویسکوز")
  const r2 = fuzzyFilterAndRank(accounts, 'پلی استر از نخ', (a) => [
    { text: a.code, weight: 1.4 },
    { text: a.title, weight: 1.2 },
  ]);
  assert.equal(r2[0]?.item.code, '40101');

  // Compound word + partial words
  const r3 = fuzzyFilterAndRank(accounts, 'دریافتنی حسابهای', (a) => [
    { text: a.code, weight: 1.4 },
    { text: a.title, weight: 1.2 },
  ]);
  assert.equal(r3[0]?.item.code, '10401');
});

test('matches invoice numbers without separators and with Persian/Arabic digits', () => {
  const invoices = [
    { number: 'F-1404-101', party: 'نساجی و ریسندگی البرز', type: 'فاکتور رسمی فروش' },
    { number: 'PF-1404-089', party: 'بازرگانی بافت گستر سپاهان', type: 'پیش‌فاکتور' },
  ];

  const r1 = fuzzyFilterAndRank(invoices, '۱۴۰۴۱۰۱', (inv) => [
    { text: inv.number, weight: 1.5 },
    { text: inv.party, weight: 1.2 },
    { text: inv.type, weight: 1.0 },
  ]);
  assert.equal(r1[0]?.item.number, 'F-1404-101');

  const r2 = fuzzyFilterAndRank(invoices, 'پيشفاكتور سپاهان', (inv) => [
    { text: inv.number, weight: 1.5 },
    { text: inv.party, weight: 1.2 },
    { text: inv.type, weight: 1.0 },
  ]);
  assert.equal(r2[0]?.item.number, 'PF-1404-089');
});

// ---------------------------------------------------------------------------
// 4. Typo Tolerance (Damerau-Levenshtein)
// ---------------------------------------------------------------------------
test('tolerates single-character typos, transpositions, and compound typos in Persian', () => {
  const products = [
    { sku: 'DTY-150-48', name: 'نخ پلی‌استر DTY ۱۵۰/۴۸ نیمه‌مات سفید', lot: 'LOT-404A' },
    { sku: 'FDY-75-36', name: 'نخ فیلامنت براق ۷۵/۳۶ کارتن ۲۵ کیلویی', lot: 'LOT-404B' },
  ];

  // Transposition typo: "فروش" typed as "فروس"
  const typo1 = fuzzyScoreToken('فروس', 'فاکتور فروش رسمی');
  assert.ok(typo1.score >= 50 && typo1.kind === 'typo');

  // Missing letter in compound word: "پشفاکتور" -> "پیش‌فاکتور"
  const typo2 = fuzzyScoreFields('پشفاکتور', [{ text: 'پیش‌فاکتور فروش', weight: 1 }]);
  assert.ok(typo2.score >= 50, `Expected compound typo match for پشفاکتور, got ${typo2.score}`);

  // Typo in yarn name: "پلیستر" -> "پلی‌استر"
  const r = fuzzyFilterAndRank(products, 'پلیستر ۱۵۰۴۸', (p) => [
    { text: p.sku, weight: 1.3 },
    { text: p.name, weight: 1.25 },
    { text: p.lot, weight: 1.0 },
  ]);
  assert.equal(r[0]?.item.sku, 'DTY-150-48');
});

// ---------------------------------------------------------------------------
// 5. Highlight Segment Integrity
// ---------------------------------------------------------------------------
test('getHighlightSegments preserves 100% of original string and highlights across ZWNJ/Arabic/separators/typos', () => {
  const cases: Array<{ text: string; query: string }> = [
    { text: 'پیش‌فاکتور شماره F-1404-101', query: 'پیشفاکتور ۱۴۰۴۱۰۱' },
    { text: 'شرکت نساجی و ریسندگی البرز', query: 'نساجي البرز' },
    { text: 'فاکتور فروش رسمی', query: 'فروس' },
    { text: 'مبلغ ۱۸۵٬۰۰۰٬۰۰۰ ریال', query: '185000' },
  ];

  for (const { text, query } of cases) {
    const segs = getHighlightSegments(text, query);
    assert.equal(
      segs.map((s) => s.text).join(''),
      text,
      `Reconstructed text must equal original for "${text}"`
    );
    assert.ok(
      segs.some((s) => s.match),
      `Expected at least one highlighted match for query "${query}" in "${text}"`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Accounting Math & Formatting Hardening
// ---------------------------------------------------------------------------
test('toExactIrr parses Persian/Arabic digits, Persian thousands separators, and guards NaN/Infinity', () => {
  assert.equal(toExactIrr('۱٬۲۵۰٬۰۰۰'), 1250000);
  assert.equal(toExactIrr('١,٢٥٠,٠٠٠'), 1250000);
  assert.equal(toExactIrr(' 450,500 '), 450500);
  assert.equal(toExactIrr(Number.NaN), 0);
  assert.equal(toExactIrr(Number.POSITIVE_INFINITY), 0);
  assert.equal(toExactIrr('not-a-number'), 0);
});

test('fixed-point BigInt invoice math avoids IEEE-754 floating-point drift', () => {
  // 19.99 * 1000 = 19990 exact; 0.1 + 0.2 style fractional quantities stay exact
  assert.equal(mulQtyByIrr(12.35, 1850000), 22847500);
  assert.equal(percentOfIrr(22847500, 10), 2284750);
  assert.equal(sumIrr([22847500, 2284750]), 25132250);
});

test('formatMoney / formatCompactMoney / formatNumber never emit NaN', () => {
  assert.equal(formatMoney(Number.NaN, 'IRT').includes('NaN'), false);
  assert.equal(formatMoney(Number.POSITIVE_INFINITY, 'IRR').includes('Infinity'), false);
  assert.equal(formatCompactMoney(Number.NaN, 'IRT').includes('NaN'), false);
  assert.equal(formatNumber(Number.NaN).includes('NaN'), false);
  assert.equal(normalizeIranianPhoneForWhatsApp('٠٩١٢٣٤٥٦٧٨٩'), '989123456789');
  assert.equal(normalizeIranianPhoneForWhatsApp('۰۹۱۲-۳۴۵-۶۷۸۹'), '989123456789');
});

// ---------------------------------------------------------------------------
// 7. Dashboard Drag-and-Drop Layout Persistence & Safety
// ---------------------------------------------------------------------------
test('dashboardLayout reorders KPI/widget cards cleanly and enforces min-1 visible widget', () => {
  const def = createDefaultDashboardLayout();
  assert.equal(isDefaultDashboardLayout(def), true);

  const reorderedKpi = reorderIds(def.kpiOrder, 'inventory', 'balance');
  assert.deepEqual(reorderedKpi, ['inventory', 'balance', 'receivables']);

  const reorderedWidgets = reorderIds(def.widgetOrder, 'urgent_cheques', 'recent_invoices');
  assert.equal(reorderedWidgets[0], 'urgent_cheques');
  assert.equal(
    isDefaultDashboardLayout({ ...def, widgetOrder: reorderedWidgets }),
    false
  );

  // Attempting to hide all 4 widgets must keep at least 1 visible
  let cfg = def;
  cfg = toggleDashboardWidgetVisibility(cfg, 'recent_invoices');
  cfg = toggleDashboardWidgetVisibility(cfg, 'quick_actions');
  cfg = toggleDashboardWidgetVisibility(cfg, 'liquidity_pulse');
  cfg = toggleDashboardWidgetVisibility(cfg, 'urgent_cheques');
  assert.equal(cfg.hiddenWidgets.length, 3);

  // Corrupted persisted data normalizes safely without unknown keys or duplicates
  const normalized = normalizeDashboardLayout({
    kpiOrder: ['inventory', 'unknown_key', 'inventory'],
    widgetOrder: ['liquidity_pulse'],
    hiddenWidgets: ['recent_invoices', 'quick_actions', 'liquidity_pulse', 'urgent_cheques'],
  });
  assert.deepEqual(normalized.kpiOrder, ['inventory', 'balance', 'receivables']);
  assert.equal(normalized.widgetOrder.length, 4);
  assert.equal(normalized.hiddenWidgets.length, 3);
});

// ---------------------------------------------------------------------------
// 8. Persian Financial Voice Search (Spoken Numbers, Intent, Multi-Entity)
// ---------------------------------------------------------------------------
test('normalizeSpokenPersianNumbers converts spoken Persian numbers including compounds to digits', () => {
  assert.equal(normalizeSpokenPersianNumbers('فاکتور صد و یک'), 'فاکتور 101');
  assert.equal(normalizeSpokenPersianNumbers('سند بیست و پنج البرز'), 'سند 25 البرز');
  assert.equal(normalizeSpokenPersianNumbers('چک سه میلیون و پانصد هزار'), 'چک 3 میلیون و 500 هزار');
});

test('parseFinancialVoiceQuery strips Persian spoken filler words and detects financial domain', () => {
  const q1 = parseFinancialVoiceQuery('لطفاً لیست پیش‌فاکتور سپاهان را نشان بده');
  assert.equal(q1.detectedDomain, 'proforma');
  assert.ok(q1.cleanedKeywords.includes('سپاهان'));

  const q2 = parseFinancialVoiceQuery('چک‌های صیادی بانک ملت');
  assert.equal(q2.detectedDomain, 'cheques');
  assert.ok(q2.cleanedKeywords.includes('ملت'));

  const q3 = parseFinancialVoiceQuery('موجودی انبار نخ پلی استر');
  assert.equal(q3.detectedDomain, 'inventory');

  const q4 = parseFinancialVoiceQuery('گزارش سود و زیان را باز کن');
  assert.equal(q4.detectedDomain, 'reports');
});

test('executeFinancialVoiceSearch ranks invoices, cheques, parties, inventory, accounts, vouchers, and reports', () => {
  const dataset: FinancialVoiceSearchDataset = {
    unit: 'IRT',
    invoices: [
      {
        id: 'inv-1',
        ownerId: 'u-1',
        invoiceNumber: 'F-1404-101',
        invoiceType: 'sale',
        date: '1404/08/10',
        partyId: 'p-1',
        partyName: 'نساجی و ریسندگی البرز',
        warehouse: 'انبار مرکزی',
        items: [
          {
            productId: 'pr-1',
            sku: 'DTY-150-48',
            productName: 'نخ پلی‌استر DTY 150',
            unit: 'کیلوگرم',
            quantity: 100,
            unitPrice: 1850000,
            discount: 0,
            vatAmount: 18500000,
            lineTotal: 203500000,
          },
        ],
        subtotal: 185000000,
        discount: 0,
        vatAmount: 18500000,
        grandTotal: 203500000,
        paidCash: 0,
        paidBank: 0,
        paidCheque: 0,
        creditAmount: 203500000,
        status: 'issued',
      },
      {
        id: 'inv-2',
        ownerId: 'u-1',
        invoiceNumber: 'PF-1404-089',
        invoiceType: 'proforma',
        date: '1404/08/12',
        partyId: 'p-2',
        partyName: 'بازرگانی بافت گستر سپاهان',
        warehouse: 'انبار مرکزی',
        items: [
          {
            productId: 'pr-2',
            sku: 'VIS-30',
            productName: 'نخ ویسکوز ۳۰',
            unit: 'کیلوگرم',
            quantity: 50,
            unitPrice: 1200000,
            discount: 0,
            vatAmount: 6000000,
            lineTotal: 66000000,
          },
        ],
        subtotal: 60000000,
        discount: 0,
        vatAmount: 6000000,
        grandTotal: 66000000,
        paidCash: 0,
        paidBank: 0,
        paidCheque: 0,
        creditAmount: 66000000,
        status: 'issued',
      },
    ],
    cheques: [
      {
        id: 'ch-1',
        ownerId: 'u-1',
        direction: 'receivable',
        serial: '984512',
        sayadiId: '1234567890123456',
        bankName: 'بانک ملت',
        partyId: 'p-1',
        partyName: 'نساجی و ریسندگی البرز',
        issueDate: '1404/08/01',
        dueDate: '1404/09/15',
        amount: 95000000,
        status: 'deposited',
      },
    ],
    parties: [
      {
        id: 'p-1',
        ownerId: 'u-1',
        code: 'C-101',
        name: 'نساجی و ریسندگی البرز',
        partyType: 'customer',
        phone: '09121112233',
        creditLimit: 500000000,
        openingBalance: 0,
        accountCode: '10301',
      },
    ],
    products: [
      {
        id: 'pr-1',
        ownerId: 'u-1',
        sku: 'DTY-150-48',
        name: 'نخ پلی‌استر DTY ۱۵۰/۴۸',
        category: 'نخ پلی‌استر',
        warehouse: 'انبار مرکزی',
        unit: 'کیلوگرم',
        buyPrice: 1500000,
        sellPrice: 1850000,
        stock: 420,
        reorderPoint: 100,
        vatExempt: false,
      },
    ],
    accounts: [
      {
        id: 'acc-10201',
        ownerId: 'u-1',
        code: '10201',
        title: 'بانک ملت شعبه مرکزی',
        category: 'asset',
        level: 'moein',
        nature: 'debit',
        isSystem: true,
      },
    ],
    vouchers: [
      {
        id: 'v-25',
        ownerId: 'u-1',
        voucherNumber: 25,
        date: '1404/08/11',
        description: 'سند فروش رسمی البرز',
        voucherType: 'sales',
        status: 'permanent',
        totalDebit: 203500000,
        totalCredit: 203500000,
        lines: [],
      },
    ],
    trialBalance: [
      {
        accountCode: '10201',
        accountTitle: 'بانک ملت شعبه مرکزی',
        category: 'asset',
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 500000000,
        periodCredit: 120000000,
        totalDebit: 500000000,
        totalCredit: 120000000,
        balanceDebit: 380000000,
        balanceCredit: 0,
      },
    ],
    partyBalances: new Map([['p-1', 203500000]]),
  };

  const r1 = executeFinancialVoiceSearch('فاکتور صد و یک البرز', dataset);
  assert.equal(r1.results[0]?.id, 'inv-inv-1');

  const r2 = executeFinancialVoiceSearch('پیش فاکتور سپاهان', dataset);
  assert.equal(r2.parsed.detectedDomain, 'proforma');
  assert.equal(r2.results[0]?.id, 'inv-inv-2');

  const r3 = executeFinancialVoiceSearch('چک صیادی بانک ملت', dataset);
  assert.equal(r3.results[0]?.id, 'chq-ch-1');

  const r4 = executeFinancialVoiceSearch('سند بیست و پنج', dataset);
  assert.equal(r4.results[0]?.id, 'vch-v-25');

  const r5 = executeFinancialVoiceSearch('گزارش سود و زیان', dataset);
  assert.equal(r5.results[0]?.module, 'reports');
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
