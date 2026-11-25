import assert from 'node:assert/strict';
import {
  formatGroupedNumberInput,
  normalizeDigitsToAscii,
  parseGroupedNumberInput,
} from '../src/lib/format';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('Running 3-digit IRR & numeric input formatting tests...');

test('normalizes Persian and Arabic-Indic digits plus Persian decimal separator to ASCII', () => {
  assert.equal(normalizeDigitsToAscii('۱۲۳۴۵۶۷۸۹۰'), '1234567890');
  assert.equal(normalizeDigitsToAscii('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  assert.equal(normalizeDigitsToAscii('۱۲۵۰٫۷۵'), '1250.75');
});

test('returns empty string for 0/empty/null/undefined by default so faded placeholders remain visible', () => {
  assert.equal(formatGroupedNumberInput(0), '');
  assert.equal(formatGroupedNumberInput('0'), '');
  assert.equal(formatGroupedNumberInput('۰'), '');
  assert.equal(formatGroupedNumberInput(''), '');
  assert.equal(formatGroupedNumberInput(null), '');
  assert.equal(formatGroupedNumberInput(undefined), '');
});

test('shows "0" only when showZero=true is explicitly requested', () => {
  assert.equal(formatGroupedNumberInput(0, false, true), '0');
  assert.equal(formatGroupedNumberInput('0', false, true), '0');
});

test('formats IRR integer amounts with 3-digit thousand separators', () => {
  assert.equal(formatGroupedNumberInput(12500000), '12,500,000');
  assert.equal(formatGroupedNumberInput(1000000000), '1,000,000,000');
  assert.equal(formatGroupedNumberInput('۱۲۵۰۰۰۰۰'), '12,500,000');
  assert.equal(formatGroupedNumberInput('۱۲,۵۰۰,۰۰۰'), '12,500,000');
});

test('formats and parses decimal weights/quantities with 3-digit grouping', () => {
  assert.equal(formatGroupedNumberInput('1250.75', true), '1,250.75');
  assert.equal(formatGroupedNumberInput('۱٬۲۵۰٫۷۵', true), '1,250.75');
  assert.equal(formatGroupedNumberInput('0.5', true), '0.5');
  assert.equal(parseGroupedNumberInput('۱٬۲۵۰٫۷۵', true), 1250.75);
  assert.equal(parseGroupedNumberInput('1,250.75', true), 1250.75);
});

test('parses Persian, Arabic, and ASCII grouped strings cleanly back to JS numbers', () => {
  assert.equal(parseGroupedNumberInput('۱۲,۵۰۰,۰۰۰'), 12500000);
  assert.equal(parseGroupedNumberInput('١٢٬٥٠٠٬٠٠٠'), 12500000);
  assert.equal(parseGroupedNumberInput('  85,400,000 '), 85400000);
  assert.equal(parseGroupedNumberInput(''), 0);
  assert.equal(parseGroupedNumberInput('-15.5', true), -15.5);
  assert.equal(parseGroupedNumberInput('-1,200'), -1200);
});

console.log(`\nAll ${passed} money/numeric input formatting tests passed.`);
