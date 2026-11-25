import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  buildBaleShareUrl,
  buildMessengerShareUrls,
  buildRubikaShareUrl,
  buildTelegramShareUrl,
  buildWhatsAppShareUrl,
} from '../src/lib/format';
import {
  DEFAULT_INVOICE_COLUMNS,
  DEFAULT_INVOICE_SETTINGS,
  normalizeInvoiceSettings,
  PERSIAN_FONT_OPTIONS,
  reorderListItem,
} from '../src/lib/invoiceSettings';
import {
  autoMapExcelColumns,
  buildEntityTemplateWorkbook,
  mapModuleToImportEntity,
  parseExcelArrayBuffer,
  parsePersianExcelNumber,
  validateAndTransformImportRows,
} from '../src/lib/universalExcelImport';
import {
  DEFAULT_OFFLINE_AI_WEIGHTS,
  evaluateOfflineAiModel,
  runAutonomousAiOptimization,
} from '../src/lib/localSmallLlm';

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Running Billion Upgrade & Feature Suite...');

test('Bale & Rubika share URLs are generated alongside WhatsApp and Telegram', () => {
  const sample = 'فاکتور فروش شماره ۱۴۰۵-۱۰۱ مبلغ ۱۲,۵۰۰,۰۰۰ ریال';
  const urls = buildMessengerShareUrls(sample, '09123456789');
  assert.ok(urls.whatsappUrl.startsWith('https://wa.me/989123456789?text='));
  assert.ok(urls.telegramUrl.startsWith('https://t.me/share/url?'));
  assert.ok(urls.baleUrl.startsWith('https://ble.ir/share/url?'));
  assert.ok(urls.rubikaUrl.startsWith('https://rubika.ir/share/url?'));
  assert.equal(urls.baleUrl, buildBaleShareUrl(sample));
  assert.equal(urls.rubikaUrl, buildRubikaShareUrl(sample));
  assert.equal(urls.telegramUrl, buildTelegramShareUrl(sample));
  assert.equal(urls.whatsappUrl, buildWhatsAppShareUrl(sample, '09123456789'));
});

test('Drag-and-drop invoice column reorder & settings normalization preserve integrity', () => {
  const reordered = reorderListItem(DEFAULT_INVOICE_COLUMNS, 2, 0);
  assert.equal(reordered[0].key, 'productName');
  assert.equal(reordered.length, DEFAULT_INVOICE_COLUMNS.length);

  const normalized = normalizeInvoiceSettings({
    logoSizePx: 999,
    fontFamily: 'lalezar_vazir',
    columnOrder: [
      { key: 'lineTotal', label: 'مبلغ نهایی', visible: true },
      { key: 'productName', label: 'شرح کالا', visible: true },
    ],
  });
  assert.equal(normalized.logoSizePx, 110);
  assert.equal(normalized.fontFamily, 'lalezar_vazir');
  assert.ok(PERSIAN_FONT_OPTIONS[normalized.fontFamily].headingFontCss.includes('Lalezar'));
  assert.equal(normalized.columnOrder.length, DEFAULT_INVOICE_COLUMNS.length);
  assert.equal(normalized.columnOrder[0].key, 'lineTotal');
  assert.equal(normalized.columnOrder[0].label, 'مبلغ نهایی');
  assert.equal(normalized.sectionOrder.length, DEFAULT_INVOICE_SETTINGS.sectionOrder.length);
});

test('Universal Excel Import parses .xlsx binary buffers and auto-maps Persian/English headers', () => {
  const wb = buildEntityTemplateWorkbook('products');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const parsed = parseExcelArrayBuffer(buf);

  assert.ok(parsed.headers.length >= 6);
  assert.equal(parsed.rows.length, 2);

  const mapping = autoMapExcelColumns(parsed.headers, 'products');
  assert.ok(mapping.name);
  assert.ok(mapping.sku);
  assert.ok(mapping.buyPrice);
  assert.ok(mapping.sellPrice);
  assert.ok(mapping.stock);
  assert.ok(mapping.reorderPoint);

  const transformed = validateAndTransformImportRows('products', parsed.rows, mapping);
  assert.equal(transformed.errors.length, 0);
  assert.equal(transformed.validRows.length, 2);
  assert.equal((transformed.validRows[0] as any).sku, 'YN-DTY-150');
  assert.equal((transformed.validRows[1] as any).stock, 220);
  assert.equal((transformed.validRows[1] as any).reorderPoint, 350);
});

test('Universal Excel Import enforces double-entry balance for grouped vouchers & parses Persian numbers', () => {
  assert.equal(parsePersianExcelNumber('۱۲۵,۴۰۰,۰۰۰ ریال'), 125_400_000);
  assert.equal(mapModuleToImportEntity('treasury'), 'cheques');
  assert.equal(mapModuleToImportEntity('inventory'), 'products');

  const rawRows = [
    { 'شماره سند': 'V-1', 'کد معین': '80201', 'شرح': 'اجاره', 'بدهکار': '۵۰,۰۰۰,۰۰۰', 'بستانکار': '0' },
    { 'شماره سند': 'V-1', 'کد معین': '10201', 'شرح': 'بانک', 'بدهکار': '0', 'بستانکار': '۵۰,۰۰۰,۰۰۰' },
    { 'شماره سند': 'V-BAD', 'کد معین': '80201', 'شرح': 'ناتراز', 'بدهکار': '1000000', 'بستانکار': '0' },
  ];
  const map = autoMapExcelColumns(Object.keys(rawRows[0]), 'vouchers');
  const res = validateAndTransformImportRows('vouchers', rawRows, map, '1405/05/10');
  assert.equal(res.validRows.length, 1);
  assert.equal(res.errors.length, 1);
});

test('Autonomous Offline AI self-evaluation and weight optimization improves degraded weights monotonically', () => {
  const baseline = evaluateOfflineAiModel(DEFAULT_OFFLINE_AI_WEIGHTS);
  assert.equal(baseline.doubleEntryBalanceRatePct, 100);
  assert.ok(baseline.overallScorePct >= 95, `Expected >= 95%, got ${baseline.overallScorePct}%`);

  // Simulate degraded initial weights to verify autonomous coordinate-ascent recovery
  const degraded = {
    ...DEFAULT_OFFLINE_AI_WEIGHTS,
    voucherIntentWeights: {
      ...DEFAULT_OFFLINE_AI_WEIGHTS.voucherIntentWeights,
      sales_return: 0.2,
      purchase_return: 0.2,
      shipping: 0.1,
    },
    copilotSynonymBank: {
      ...DEFAULT_OFFLINE_AI_WEIGHTS.copilotSynonymBank,
      audit: [],
      lifecycle: [],
    },
  };

  const opt = runAutonomousAiOptimization({
    seedWeights: degraded,
    workspaceAccountTitles: ['بانک تجارت ارزی', 'موجودی نخ پنبه شانه'],
    workspacePartyNames: ['کارخانه نساجی سپهر یزد'],
    persist: false,
  });

  assert.equal(opt.improved, true);
  assert.ok(opt.after.overallScorePct >= opt.before.overallScorePct);
  assert.equal(opt.after.doubleEntryBalanceRatePct, 100);
  assert.ok(opt.after.overallScorePct >= 95);
  assert.ok(opt.weights.workspaceLexiconTerms.length >= 4);
  assert.ok(opt.appliedChanges.length >= 1);
});

console.log(`All ${passed} Billion upgrade tests passed!`);
