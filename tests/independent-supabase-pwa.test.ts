import assert from 'node:assert/strict';
import {
  fetchServerDiagnostics,
  fetchSupabaseBackups,
  fetchSupabaseSessionMe,
  formatShamsiFromIso,
  loadSupabaseAutoBackupEnabled,
  normalizeSupabaseBackups,
  pushSnapshotToSupabase,
  runLiveServerAndSupabaseTest,
  saveSupabaseAutoBackupEnabled,
} from '../src/lib/dualCloudSync';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    failed += 1;
  }
}

async function run() {
  (globalThis as unknown as { localStorage: ReturnType<typeof createMemoryStorage> }).localStorage =
    createMemoryStorage();

  await test('Independent Supabase auto-backup defaults to enabled and persists toggles', () => {
    assert.equal(loadSupabaseAutoBackupEnabled(), true);
    saveSupabaseAutoBackupEnabled(false);
    assert.equal(loadSupabaseAutoBackupEnabled(), false);
    saveSupabaseAutoBackupEnabled(true);
    assert.equal(loadSupabaseAutoBackupEnabled(), true);
  });

  await test('Normalizes rolling Supabase backups to max 3 versions and formats Shamsi dates', () => {
    const formatted = formatShamsiFromIso('2026-04-01T10:30:00.000Z');
    assert.ok(formatted.length > 5);

    const normalized = normalizeSupabaseBackups([
      {
        id: 'sbw_test__bak__4',
        provider: 'supabase',
        revision: 4,
        savedAt: '2026-04-01T10:30:00.000Z',
        deviceLabel: 'Office PC',
        companyName: 'Atlasris',
        fiscalYear: '1405',
        voucherCount: 12,
        invoiceCount: 5,
        productCount: 20,
      },
      {
        id: 'sbw_test__bak__3',
        provider: 'supabase',
        revision: 3,
        savedAt: '2026-04-01T10:20:00.000Z',
        deviceLabel: 'Office PC',
        companyName: 'Atlasris',
        fiscalYear: '1405',
        voucherCount: 11,
        invoiceCount: 5,
        productCount: 20,
      },
      {
        id: 'sbw_test__bak__2',
        provider: 'supabase',
        revision: 2,
        savedAt: '2026-04-01T10:10:00.000Z',
        deviceLabel: 'Office PC',
        companyName: 'Atlasris',
        fiscalYear: '1405',
        voucherCount: 10,
        invoiceCount: 4,
        productCount: 20,
      },
      {
        id: 'sbw_test__bak__1',
        provider: 'supabase',
        revision: 1,
        savedAt: '2026-04-01T10:00:00.000Z',
        deviceLabel: 'Office PC',
        companyName: 'Atlasris',
        fiscalYear: '1405',
        voucherCount: 9,
        invoiceCount: 4,
        productCount: 20,
      },
    ]);

    assert.equal(normalized.length, 3);
    assert.equal(normalized[0].revision, 4);
    assert.equal(normalized[2].revision, 2);
  });

  await test('Sends HttpOnly cookie credentials + CSRF header without Firebase token on sync/backups', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        assert.equal(init?.credentials, 'include');
        const headers = (init?.headers || {}) as Record<string, string>;
        assert.equal(headers['X-Requested-With'], 'HolooApex');
        assert.equal(headers.Authorization, undefined);

        if (url.includes('/api/supabase/backups')) {
          return new Response(
            JSON.stringify({
              maxBackups: 3,
              currentRevision: 5,
              currentUpdatedAt: '2026-04-01T12:00:00.000Z',
              backups: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            status: 'synced',
            serverRevision: 6,
            conflictPolicy: 'last_write_wins',
            syncedAt: '2026-04-01T12:05:00.000Z',
            retainedBackups: [],
            prunedBackupsCount: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const meta = await fetchSupabaseBackups(null);
      assert.equal(meta.ok, true);
      assert.equal(meta.currentRevision, 5);

      const sync = await pushSnapshotToSupabase({
        idToken: null,
        deviceId: 'dev_test',
        deviceLabel: 'Test Device',
        conflictPolicy: 'last_write_wins',
        clientRevision: 5,
        companyName: 'Atlasris',
        fiscalYear: '1405',
        voucherCount: 2,
        invoiceCount: 1,
        productCount: 3,
        snapshotJson: JSON.stringify({ ok: true }),
      });
      assert.equal(sync.ok, true);
      assert.equal(sync.data?.serverRevision, 6);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test('Parses independent session restore, server diagnostics, and live server test checks', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/supabase/auth/me')) {
          return new Response(
            JSON.stringify({
              authenticated: true,
              authSource: 'supabase_workspace',
              workspaceId: 'atlasris_main',
              serverRevision: 3,
              updatedAt: '2026-04-01T12:00:00.000Z',
              backupCount: 2,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/api/server/diagnostics')) {
          return new Response(
            JSON.stringify({
              server: {
                status: 'ok',
                service: 'holoo-apex-corporate-erp',
                mode: 'development',
                port: 3000,
                nodeVersion: 'v22.0.0',
                uptimeSec: 120,
                localAiPolicy: 'local_slm_only',
                independentSupabaseMode: true,
                timestamp: '2026-04-01T12:00:00.000Z',
              },
              supabase: {
                configured: true,
                connected: true,
                tableReady: true,
                auditTableReady: true,
                projectRef: 'pnzxxdaxvjfacztussxl',
                tableName: 'holoo_apex_workspaces',
                auditTableName: 'holoo_apex_audit_log',
                latencyMs: 95,
                errorCode: null,
              },
              session: {
                authenticated: true,
                authSource: 'supabase_workspace',
                workspaceId: 'atlasris_main',
                serverRevision: 3,
                lastUpdatedAt: '2026-04-01T12:00:00.000Z',
                backupCount: 2,
              },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            testedAt: '2026-04-01T12:01:00.000Z',
            totalLatencyMs: 112,
            projectRef: 'pnzxxdaxvjfacztussxl',
            serverRevision: 3,
            backupCount: 2,
            authSource: 'supabase_workspace',
            checks: [
              { id: 'express_api', title: 'Express', ok: true, latencyMs: 1, detail: 'OK' },
              { id: 'supabase_workspaces_table', title: 'Table', ok: true, latencyMs: 111, detail: 'OK' },
            ],
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const me = await fetchSupabaseSessionMe();
      assert.equal(me.authenticated, true);
      assert.equal(me.serverRevision, 3);

      const diag = await fetchServerDiagnostics();
      assert.equal(diag?.supabase.auditTableReady, true);
      assert.equal(diag?.session.serverRevision, 3);

      const testRes = await runLiveServerAndSupabaseTest();
      assert.equal(testRes.ok, true);
      assert.equal(testRes.checks.length, 2);
      assert.equal(testRes.serverRevision, 3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  console.log(`Independent Supabase & Server Diagnostics Suite: ${passed}/${passed + failed} passed.`);
  if (failed > 0) process.exit(1);
}

run();
