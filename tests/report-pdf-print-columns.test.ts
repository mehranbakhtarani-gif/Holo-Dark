import assert from 'node:assert/strict';
import {
  ReportColumnDef,
  StandardAccountingReportSpec,
  buildSelectedColumnsCsvData,
  buildStandardAccountingReportHtml,
  escapeHtml,
  getDefaultColumnState,
  moveReportColumnOrder,
  normalizeColumnState,
  resolveVisibleColumns,
  toggleReportColumnSelection,
} from '../src/lib/accountingReportExport';
import { CompanyProfile } from '../src/types/accounting';

const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const sampleProfile: CompanyProfile = {
  uid: 'u1',
  displayName: 'حسابدار ارشد',
  companyName: 'شرکت بازرگانی نخ <آزمون> & تجارت',
  economicCode: '411223344556',
  nationalId: '14001234567',
  fiscalYear: '1405',
  currencyUnit: 'IRR',
  role: 'accountant',
};

const sampleColumns: ReportColumnDef[] = [
  { key: 'code', label: 'کد حساب', isCode: true, defaultVisible: true, essential: true },
  { key: 'title', label: 'عنوان حساب', align: 'right', defaultVisible: true, essential: true },
  { key: 'openD', label: 'اول دوره بد', isNumeric: true, defaultVisible: false },
  { key: 'balD', label: 'مانده بدهکار', isNumeric: true, defaultVisible: true, essential: true },
  { key: 'balC', label: 'مانده بستانکار', isNumeric: true, defaultVisible: true, essential: true },
];

const sampleSpec: StandardAccountingReportSpec = {
  reportId: 'trial_test',
  fileNamePrefix: 'holoo-trial-test',
  title: 'تراز آزمایشی رسمی',
  subtitle: 'گزارش تراز آزمایشی دوره مالی',
  periodLabel: 'کل سال مالی ۱۴۰۵',
  voucherScopeLabel: 'فقط اسناد قطعی (رسمی)',
  currencyUnit: 'IRR',
  recommendedOrientation: 'landscape',
  columns: sampleColumns,
  rows: [
    {
      id: '10101',
      cells: {
        code: '۱۰۱۰۱',
        title: 'صندوق مرکزی <اصلی>',
        openD: '۱۰,۰۰۰,۰۰۰',
        balD: '۲۵,۰۰۰,۰۰۰',
        balC: '—',
      },
    },
    {
      id: '50101',
      cells: {
        code: '۵۰۱۰۱',
        title: 'سرمایه ثبت‌شده',
        openD: '—',
        balD: '—',
        balC: '۲۵,۰۰۰,۰۰۰',
      },
    },
  ],
  footerLabel: 'تراز کل',
  footerTotals: {
    openD: '۱۰,۰۰۰,۰۰۰',
    balD: '۲۵,۰۰۰,۰۰۰',
    balC: '۲۵,۰۰۰,۰۰۰',
  },
};

test('1. Column selection respects defaultVisible, enforces min-1 active column, and reorders cleanly', () => {
  const def = getDefaultColumnState(sampleColumns);
  assert.deepEqual(def.selectedKeys, ['code', 'title', 'balD', 'balC']);

  // Toggle openD on
  const withOpen = toggleReportColumnSelection(def, 'openD');
  assert.deepEqual(withOpen.selectedKeys, ['code', 'title', 'openD', 'balD', 'balC']);

  // Move balC up above balD
  const reordered = moveReportColumnOrder(withOpen, 'balC', 'up');
  assert.deepEqual(reordered.orderedKeys, ['code', 'title', 'openD', 'balC', 'balD']);
  assert.deepEqual(reordered.selectedKeys, ['code', 'title', 'openD', 'balC', 'balD']);

  // Prevent deselecting the final remaining column
  const single = { orderedKeys: def.orderedKeys, selectedKeys: ['code'] };
  const afterAttempt = toggleReportColumnSelection(single, 'code');
  assert.deepEqual(afterAttempt.selectedKeys, ['code']);
});

test('2. normalizeColumnState drops obsolete keys and appends newly added schema columns', () => {
  const normalized = normalizeColumnState(sampleColumns, {
    orderedKeys: ['balD', 'legacy_removed_col', 'code'],
    selectedKeys: ['balD', 'legacy_removed_col'],
  });
  assert.deepEqual(normalized.orderedKeys, ['balD', 'code', 'title', 'openD', 'balC']);
  assert.deepEqual(normalized.selectedKeys, ['balD']);
});

test('3. Standard accounting print HTML renders only selected columns in order, escapes XSS, and applies A4 styles', () => {
  const state = {
    orderedKeys: ['code', 'title', 'balC', 'balD', 'openD'],
    selectedKeys: ['code', 'title', 'balC'],
  };
  const visible = resolveVisibleColumns(sampleColumns, state);
  const html = buildStandardAccountingReportHtml(sampleSpec, visible, sampleProfile, {
    orientation: 'portrait',
    showRowNumbers: true,
    showSignatures: true,
    showKpis: false,
    compactDensity: false,
    preparedBy: 'حسابدار رسمی',
  });

  // RTL & A4 portrait rule
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes('size: A4 portrait'));
  // Double-underline accounting total style
  assert.ok(html.includes('border-bottom: 3.5px double #0f172a'));
  // Selected columns present
  assert.ok(html.includes('>ردیف<'));
  assert.ok(html.includes('>کد حساب<'));
  assert.ok(html.includes('>عنوان حساب<'));
  assert.ok(html.includes('>مانده بستانکار<'));
  // Unselected columns strictly omitted
  assert.ok(!html.includes('>اول دوره بد<'));
  assert.ok(!html.includes('>مانده بدهکار<'));
  // Signature block present
  assert.ok(html.includes('تنظیم‌کننده / حسابدار'));
  assert.ok(html.includes('مدیرعامل / مهر رسمی شرکت'));
  // XSS / HTML injection strictly escaped
  assert.ok(html.includes(escapeHtml('شرکت بازرگانی نخ <آزمون> & تجارت')));
  assert.ok(!html.includes('<آزمون>'));
  assert.ok(!html.includes('<اصلی>'));
});

test('4. Filtered CSV data matches exact selected columns, row numbers, and footer totals', () => {
  const visible = resolveVisibleColumns(sampleColumns, {
    orderedKeys: ['code', 'title', 'balD', 'balC', 'openD'],
    selectedKeys: ['code', 'balD'],
  });
  const csv = buildSelectedColumnsCsvData(sampleSpec, visible, true);
  assert.deepEqual(csv.headers, ['ردیف', 'کد حساب', 'مانده بدهکار']);
  assert.equal(csv.rows.length, 3); // 2 data rows + 1 footer total row
  assert.deepEqual(csv.rows[0], ['1', '۱۰۱۰۱', '۲۵,۰۰۰,۰۰۰']);
  assert.deepEqual(csv.rows[2], ['', 'تراز کل', '۲۵,۰۰۰,۰۰۰']);
});

let passed = 0;
for (const t of tests) {
  t.fn();
  passed++;
  console.log(`  ✓ ${t.name}`);
}
console.log(`\n[Standard Accounting PDF/Print & Column Selection] ${passed}/${tests.length} tests passed.`);
