import assert from 'node:assert/strict';
import {
  analyzeAccountingSnapshotConflict,
  getConflictDefaultModeLabel,
  loadSyncConflictDefaultMode,
  resolveConflictDecision,
  saveSyncConflictDefaultMode,
  SYNC_CONFLICT_DEFAULT_STORAGE_KEY,
  syncConflictModeToCloudPolicy,
} from '../src/lib/syncConflictResolver';

let passed = 0;
let failed = 0;

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    failed += 1;
  }
}

// Lightweight localStorage mock for Node test runtime
const memoryStorage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  get length() {
    return memoryStorage.size;
  },
  clear() {
    memoryStorage.clear();
  },
  getItem(key: string) {
    return memoryStorage.has(key) ? memoryStorage.get(key)! : null;
  },
  key(index: number) {
    return Array.from(memoryStorage.keys())[index] ?? null;
  },
  removeItem(key: string) {
    memoryStorage.delete(key);
  },
  setItem(key: string, value: string) {
    memoryStorage.set(key, String(value));
  },
};

console.log('\n[Test Suite] Automatic & Interactive Accounting Sync Conflict Resolution\n');

runTest('1. Default mode starts as "ask" and persists user choice for future conflicts', () => {
  memoryStorage.clear();
  assert.equal(loadSyncConflictDefaultMode(), 'ask');
  assert.deepEqual(resolveConflictDecision('ask'), { autoResolved: false, choice: null });

  saveSyncConflictDefaultMode('keep_local');
  assert.equal(memoryStorage.get(SYNC_CONFLICT_DEFAULT_STORAGE_KEY), 'keep_local');
  assert.equal(loadSyncConflictDefaultMode(), 'keep_local');
  assert.deepEqual(resolveConflictDecision('keep_local'), {
    autoResolved: true,
    choice: 'keep_local',
  });

  saveSyncConflictDefaultMode('restore_remote');
  assert.equal(loadSyncConflictDefaultMode(), 'restore_remote');
  assert.deepEqual(resolveConflictDecision('restore_remote'), {
    autoResolved: true,
    choice: 'restore_remote',
  });
});

runTest('2. Maps saved conflict default mode safely to Supabase cloud conflictPolicy', () => {
  // 'ask' uses first_write_wins probe so server returns remoteSnapshotJson without overwriting
  assert.equal(syncConflictModeToCloudPolicy('ask'), 'first_write_wins');
  assert.equal(syncConflictModeToCloudPolicy('restore_remote'), 'first_write_wins');
  assert.equal(syncConflictModeToCloudPolicy('keep_local'), 'last_write_wins');
  assert.ok(getConflictDefaultModeLabel('keep_local').includes('حفظ'));
  assert.ok(getConflictDefaultModeLabel('restore_remote').includes('بازگردانی'));
});

runTest('3. Detects conflicting vouchers, invoices, and products with readable Persian previews', () => {
  const localSnapshot = JSON.stringify({
    vouchers: [
      {
        id: 'v-101',
        number: 12,
        description: 'سند فروش نخ پنبه',
        status: 'final',
        lines: [{ debit: 45_000_000, credit: 0 }],
        updatedAt: '2026-11-24T10:00:00.000Z',
      },
      {
        id: 'v-local-only',
        number: 13,
        description: 'سند تنخواه کارگاه',
        status: 'draft',
        lines: [{ debit: 2_500_000, credit: 0 }],
      },
    ],
    invoices: [
      {
        id: 'inv-50',
        number: 104,
        type: 'sale',
        partyName: 'بافندگی اطلس',
        grandTotal: 120_000_000,
        date: '1405/08/10',
      },
    ],
    products: [{ id: 'p-1', name: 'نخ پنبه نمره ۳۰', stock: 80, salePrice: 420_000 }],
    parties: [],
    cheques: [],
  });

  const remoteSnapshot = JSON.stringify({
    vouchers: [
      {
        id: 'v-101',
        number: 12,
        description: 'سند فروش نخ پنبه (اصلاح ابری)',
        status: 'final',
        lines: [{ debit: 50_000_000, credit: 0 }],
        updatedAt: '2026-11-24T10:05:00.000Z',
      },
    ],
    invoices: [
      {
        id: 'inv-50',
        number: 104,
        type: 'sale',
        partyName: 'بافندگی اطلس',
        grandTotal: 120_000_000,
        date: '1405/08/10',
      },
      {
        id: 'inv-remote-only',
        number: 105,
        type: 'purchase',
        partyName: 'ریسندگی کویر',
        grandTotal: 75_000_000,
        date: '1405/08/11',
      },
    ],
    products: [{ id: 'p-1', name: 'نخ پنبه نمره ۳۰', stock: 95, salePrice: 420_000 }],
    parties: [],
    cheques: [],
  });

  const summary = analyzeAccountingSnapshotConflict(localSnapshot, remoteSnapshot);
  assert.equal(summary.hasConflicts, true);
  assert.equal(summary.modifiedCount, 2); // v-101 and p-1
  assert.equal(summary.localOnlyCount, 1); // v-local-only
  assert.equal(summary.remoteOnlyCount, 1); // inv-remote-only
  assert.equal(summary.totalConflictingDocs, 4);
  assert.equal(summary.localCounts.vouchers, 2);
  assert.equal(summary.remoteCounts.vouchers, 1);
  assert.equal(summary.localCounts.invoices, 1);
  assert.equal(summary.remoteCounts.invoices, 2);
  assert.ok(summary.previews.some((p) => p.id === 'v-101' && p.conflictKind === 'modified'));
  assert.ok(summary.previews.some((p) => p.id === 'p-1' && p.collectionLabel === 'کالا و انبار'));
});

runTest('4. Ignores volatile sync metadata and strips prototype pollution keys safely', () => {
  const snapA = JSON.stringify({
    vouchers: [
      {
        id: 'v-1',
        number: 1,
        description: 'افتتاحیه',
        lines: [{ debit: 1000, credit: 0 }],
        updatedAt: '2026-11-24T09:00:00.000Z',
        deviceId: 'laptop',
      },
    ],
  });
  const snapB =
    '{"__proto__":{"polluted":true},"vouchers":[{"id":"v-1","number":1,"description":"افتتاحیه","lines":[{"debit":1000,"credit":0}],"updatedAt":"2026-11-24T12:00:00.000Z","deviceId":"phone"}]}';

  const summary = analyzeAccountingSnapshotConflict(snapA, snapB);
  assert.equal(summary.hasConflicts, false);
  assert.equal(summary.totalConflictingDocs, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
