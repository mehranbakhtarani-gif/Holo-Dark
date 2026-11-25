import type { CloudBackupMeta } from './firebaseCloudBackup';

export type ConflictResolutionPolicy = 'last_write_wins' | 'first_write_wins';

export interface SupabaseStatusInfo {
  configured: boolean;
  connected: boolean;
  tableReady: boolean;
  keyRole?: string | null;
  projectRef: string | null;
  tableName: string;
  latencyMs: number | null;
  errorCode: string | null;
  checkedAt: string | null;
}

export interface OfflineOutboxItem {
  id: string;
  queuedAt: string;
  summary: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
}

export interface RawServerBackupMeta {
  id: string;
  provider: 'supabase';
  revision: number;
  savedAt: string;
  deviceLabel: string;
  companyName: string;
  fiscalYear: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
}

export interface SupabaseSyncResponse {
  status: 'synced' | 'conflict_kept_remote' | 'conflict_overwrote_remote' | 'idempotent_replay';
  idempotentReplay?: boolean;
  operationId?: string;
  serverRevision: number;
  conflictPolicy: ConflictResolutionPolicy;
  syncedAt: string;
  remoteDeviceLabel?: string;
  remoteSnapshotJson?: string;
  retainedBackups?: RawServerBackupMeta[];
  prunedBackupsCount?: number;
}

export interface SupabaseWorkspaceAuthResult {
  ok: boolean;
  workspaceId?: string;
  token?: string;
  expiresAt?: string;
  currentRevision?: number;
  currentUpdatedAt?: string | null;
  error?: string;
  code?: string;
}

export interface SupabaseSessionMeResponse {
  authenticated: boolean;
  authSource?: 'supabase_workspace';
  workspaceId: string | null;
  serverRevision: number;
  updatedAt: string | null;
  backupCount: number;
}

export interface ServerDiagnosticsResponse {
  server: {
    status: 'ok';
    service: string;
    mode: 'development' | 'production';
    port: number;
    nodeVersion: string;
    uptimeSec: number;
    localAiPolicy: 'local_slm_only';
    independentSupabaseMode: boolean;
    timestamp: string;
  };
  supabase: {
    configured: boolean;
    connected: boolean;
    tableReady: boolean;
    auditTableReady: boolean;
    projectRef: string | null;
    tableName: string;
    auditTableName: string;
    latencyMs: number | null;
    errorCode: string | null;
  };
  session: {
    authenticated: boolean;
    authSource: 'supabase_workspace' | 'firebase' | 'disconnected';
    workspaceId: string | null;
    serverRevision: number;
    lastUpdatedAt: string | null;
    backupCount: number;
  };
}

export interface LiveServerTestCheck {
  id: string;
  title: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface SupabaseRemediationItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  summary: string;
  steps: string[];
  envKeyHint?: string;
}

export interface LiveServerTestResult {
  ok: boolean;
  testedAt: string;
  totalLatencyMs: number;
  projectRef: string | null;
  serverRevision: number;
  backupCount: number;
  authSource: string;
  keyRole?: string | null;
  networkReachable?: boolean;
  rlsWriteReady?: boolean;
  remediations?: SupabaseRemediationItem[];
  checks: LiveServerTestCheck[];
  error?: string;
}

export interface SupabaseBackupsListResponse {
  ok: boolean;
  maxBackups?: number;
  currentRevision?: number;
  currentUpdatedAt?: string | null;
  currentDeviceId?: string;
  currentDeviceLabel?: string;
  prunedCount?: number;
  backups?: CloudBackupMeta[];
  error?: string;
}

export function formatShamsiFromIso(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const datePart = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    const timePart = d.toLocaleTimeString('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${datePart} · ${timePart}`;
  } catch {
    return iso;
  }
}

export function normalizeSupabaseBackups(raw?: RawServerBackupMeta[]): CloudBackupMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((b) => ({
    id: b.id,
    provider: 'supabase',
    revision: Number(b.revision) || 1,
    savedAt: b.savedAt || new Date().toISOString(),
    savedAtShamsi: formatShamsiFromIso(b.savedAt || new Date().toISOString()),
    deviceLabel: b.deviceLabel || 'دستگاه کاری',
    companyName: b.companyName || '',
    fiscalYear: b.fiscalYear || '1405',
    voucherCount: Number(b.voucherCount) || 0,
    invoiceCount: Number(b.invoiceCount) || 0,
    productCount: Number(b.productCount) || 0,
  }));
}

const POLICY_STORAGE_KEY = 'holoo_apex_conflict_policy_v1';
const OUTBOX_STORAGE_KEY = 'holoo_apex_offline_outbox_v1';
const REVISION_STORAGE_KEY = 'holoo_apex_supabase_revision_v1';
const LAST_SYNC_STORAGE_KEY = 'holoo_apex_supabase_last_sync_v1';
const SB_WORKSPACE_ID_KEY = 'holoo_apex_supabase_workspace_id_v1';
const SB_AUTO_BACKUP_KEY = 'holoo_apex_supabase_auto_backup_v1';

export function loadSupabaseAutoBackupEnabled(): boolean {
  try {
    const val = localStorage.getItem(SB_AUTO_BACKUP_KEY);
    if (val === '0' || val === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

export function saveSupabaseAutoBackupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SB_AUTO_BACKUP_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

function buildApiHeaders(token?: string | null, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'HolooApex',
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function loadSavedSupabaseWorkspaceId(): string {
  try {
    const val = localStorage.getItem(SB_WORKSPACE_ID_KEY) || '';
    return /^[a-zA-Z0-9_-]{3,48}$/.test(val) ? val : 'atlasris_main';
  } catch {
    return 'atlasris_main';
  }
}

export function saveSupabaseWorkspaceId(workspaceId: string): void {
  try {
    localStorage.setItem(SB_WORKSPACE_ID_KEY, workspaceId);
  } catch {
    // ignore
  }
}

export async function checkSupabaseWorkspaceState(
  workspaceId: string
): Promise<{ ok: boolean; initialized?: boolean; error?: string }> {
  try {
    const resp = await fetch(
      `/api/supabase/auth/state?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: 'GET', cache: 'no-store', credentials: 'include' }
    );
    const json = (await resp.json().catch(() => ({}))) as {
      initialized?: boolean;
      error?: string;
    };
    if (!resp.ok) return { ok: false, error: json.error || 'خطا در بررسی فضای کاری Supabase' };
    return { ok: true, initialized: Boolean(json.initialized) };
  } catch {
    return { ok: false, error: 'ارتباط با سرور Supabase برقرار نشد.' };
  }
}

export async function fetchSupabaseSessionMe(): Promise<SupabaseSessionMeResponse> {
  try {
    const resp = await fetch('/api/supabase/auth/me', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: buildApiHeaders(),
    });
    if (!resp.ok) {
      return { authenticated: false, workspaceId: null, serverRevision: 0, updatedAt: null, backupCount: 0 };
    }
    const json = (await resp.json().catch(() => ({}))) as Partial<SupabaseSessionMeResponse>;
    return {
      authenticated: Boolean(json.authenticated),
      authSource: json.authSource,
      workspaceId: json.workspaceId ?? null,
      serverRevision: Number(json.serverRevision) || 0,
      updatedAt: json.updatedAt ?? null,
      backupCount: Number(json.backupCount) || 0,
    };
  } catch {
    return { authenticated: false, workspaceId: null, serverRevision: 0, updatedAt: null, backupCount: 0 };
  }
}

export async function logoutSupabaseWorkspaceAuth(): Promise<boolean> {
  try {
    const resp = await fetch('/api/supabase/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function setupSupabaseWorkspaceAuth(
  workspaceId: string,
  passcode: string
): Promise<SupabaseWorkspaceAuthResult> {
  try {
    const resp = await fetch('/api/supabase/auth/setup', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(null, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ workspaceId, passcode }),
    });
    const json = (await resp.json().catch(() => ({}))) as SupabaseWorkspaceAuthResult;
    if (!resp.ok) {
      return {
        ok: false,
        error: json.error || 'فعال‌سازی فضای کاری ناموفق بود.',
        code: json.code || `HTTP_${resp.status}`,
      };
    }
    return {
      ok: true,
      workspaceId: json.workspaceId,
      token: json.token,
      expiresAt: json.expiresAt,
      currentRevision: Number(json.currentRevision) || 0,
      currentUpdatedAt: json.currentUpdatedAt ?? null,
    };
  } catch {
    return {
      ok: false,
      error: 'ارتباط با سرور Supabase برقرار نشد.',
      code: 'NETWORK_ERROR',
    };
  }
}

export async function loginSupabaseWorkspaceAuth(
  workspaceId: string,
  passcode: string
): Promise<SupabaseWorkspaceAuthResult> {
  try {
    const resp = await fetch('/api/supabase/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(null, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ workspaceId, passcode }),
    });
    const json = (await resp.json().catch(() => ({}))) as SupabaseWorkspaceAuthResult;
    if (!resp.ok) {
      return {
        ok: false,
        error: json.error || 'ورود به فضای کاری Supabase ناموفق بود.',
        code: json.code || `HTTP_${resp.status}`,
      };
    }
    return {
      ok: true,
      workspaceId: json.workspaceId,
      token: json.token,
      expiresAt: json.expiresAt,
      currentRevision: Number(json.currentRevision) || 0,
      currentUpdatedAt: json.currentUpdatedAt ?? null,
    };
  } catch {
    return {
      ok: false,
      error: 'ارتباط با سرور Supabase برقرار نشد.',
      code: 'NETWORK_ERROR',
    };
  }
}

export async function fetchServerDiagnostics(
  token?: string | null
): Promise<ServerDiagnosticsResponse | null> {
  try {
    const resp = await fetch('/api/server/diagnostics', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: buildApiHeaders(token),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ServerDiagnosticsResponse;
  } catch {
    return null;
  }
}

export async function runLiveServerAndSupabaseTest(
  token?: string | null
): Promise<LiveServerTestResult> {
  try {
    const resp = await fetch('/api/supabase/test', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
    });
    const json = (await resp.json().catch(() => ({}))) as Partial<LiveServerTestResult>;
    if (!resp.ok) {
      return {
        ok: false,
        testedAt: new Date().toISOString(),
        totalLatencyMs: 0,
        projectRef: null,
        serverRevision: 0,
        backupCount: 0,
        authSource: 'disconnected',
        checks: [],
        error: json.error || `خطای سرور هنگام اجرای تست (HTTP ${resp.status})`,
      };
    }
    return {
      ok: Boolean(json.ok),
      testedAt: json.testedAt || new Date().toISOString(),
      totalLatencyMs: Number(json.totalLatencyMs) || 0,
      projectRef: json.projectRef ?? null,
      serverRevision: Number(json.serverRevision) || 0,
      backupCount: Number(json.backupCount) || 0,
      authSource: json.authSource || 'disconnected',
      keyRole: json.keyRole ?? null,
      networkReachable: typeof json.networkReachable === 'boolean' ? json.networkReachable : undefined,
      rlsWriteReady: typeof json.rlsWriteReady === 'boolean' ? json.rlsWriteReady : undefined,
      remediations: Array.isArray(json.remediations) ? json.remediations : [],
      checks: Array.isArray(json.checks) ? json.checks : [],
    };
  } catch {
    return {
      ok: false,
      testedAt: new Date().toISOString(),
      totalLatencyMs: 0,
      projectRef: null,
      serverRevision: 0,
      backupCount: 0,
      authSource: 'disconnected',
      keyRole: null,
      networkReachable: false,
      rlsWriteReady: false,
      remediations: [
        {
          id: 'express_unreachable',
          severity: 'critical',
          title: 'دسترسی به سرور محلی Express برقرار نشد',
          summary: 'مرورگر نتوانست به مسیر /api/supabase/test پاسخ بگیرد.',
          steps: [
            'اتصال اینترنت دستگاه خود را بررسی کنید (وضعیت آفلاین یا قطعی موقت).',
            'اطمینان حاصل کنید سرور برنامه روی پورت ۳۰۰۰ در حال اجرا است و صفحه را یک‌بار تازه‌سازی کنید.',
          ],
        },
      ],
      checks: [],
      error: 'عدم دسترسی به سرور برنامه (ممکن است دستگاه آفلاین باشد یا سرور در حال راه‌اندازی باشد).',
    };
  }
}

export function loadConflictPolicy(): ConflictResolutionPolicy {
  try {
    const raw = localStorage.getItem(POLICY_STORAGE_KEY);
    if (raw === 'first_write_wins' || raw === 'last_write_wins') {
      return raw;
    }
  } catch {
    // ignore
  }
  return 'last_write_wins';
}

export function saveConflictPolicy(policy: ConflictResolutionPolicy): void {
  try {
    localStorage.setItem(POLICY_STORAGE_KEY, policy);
  } catch {
    // ignore
  }
}

export function loadOfflineOutbox(): OfflineOutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineOutboxItem[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineOutboxItem(item: Omit<OfflineOutboxItem, 'id' | 'queuedAt'>): OfflineOutboxItem[] {
  const existing = loadOfflineOutbox();
  const next: OfflineOutboxItem[] = [
    ...existing.slice(-24),
    {
      ...item,
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      queuedAt: new Date().toISOString(),
    },
  ];
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearOfflineOutbox(): void {
  try {
    localStorage.removeItem(OUTBOX_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function loadLastSupabaseRevision(): number {
  try {
    const n = Number(localStorage.getItem(REVISION_STORAGE_KEY) || '0');
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveLastSupabaseRevision(rev: number): void {
  try {
    localStorage.setItem(REVISION_STORAGE_KEY, String(Math.max(0, Math.floor(rev))));
  } catch {
    // ignore
  }
}

export function loadLastSupabaseSyncAt(): string | null {
  try {
    return localStorage.getItem(LAST_SYNC_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveLastSupabaseSyncAt(shamsiStamp: string): void {
  try {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, shamsiStamp);
  } catch {
    // ignore
  }
}

export async function fetchSupabaseServerStatus(): Promise<SupabaseStatusInfo> {
  try {
    const resp = await fetch('/api/supabase/status', {
      method: 'GET',
      cache: 'no-store',
    });
    if (!resp.ok) {
      return {
        configured: false,
        connected: false,
        tableReady: false,
        projectRef: null,
        tableName: 'holoo_apex_workspaces',
        latencyMs: null,
        errorCode: `HTTP_${resp.status}`,
        checkedAt: new Date().toISOString(),
      };
    }
    const data = (await resp.json()) as Omit<SupabaseStatusInfo, 'checkedAt'>;
    return {
      ...data,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      configured: false,
      connected: false,
      tableReady: false,
      projectRef: null,
      tableName: 'holoo_apex_workspaces',
      latencyMs: null,
      errorCode: 'OFFLINE_OR_UNREACHABLE',
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function fetchSupabaseBackups(
  idToken?: string | null
): Promise<SupabaseBackupsListResponse> {
  try {
    const resp = await fetch('/api/supabase/backups', {
      method: 'GET',
      credentials: 'include',
      headers: buildApiHeaders(idToken),
      cache: 'no-store',
    });
    const json = (await resp.json().catch(() => ({}))) as {
      maxBackups?: number;
      currentRevision?: number;
      currentUpdatedAt?: string | null;
      currentDeviceId?: string;
      currentDeviceLabel?: string;
      prunedCount?: number;
      backups?: RawServerBackupMeta[];
      error?: string;
    };
    if (!resp.ok) {
      return { ok: false, error: json.error || 'خطا در دریافت لیست پشتیبان‌های Supabase' };
    }
    return {
      ok: true,
      maxBackups: json.maxBackups ?? 3,
      currentRevision: Number(json.currentRevision) || 0,
      currentUpdatedAt: json.currentUpdatedAt ?? null,
      currentDeviceId: json.currentDeviceId || '',
      currentDeviceLabel: json.currentDeviceLabel || '',
      prunedCount: Number(json.prunedCount) || 0,
      backups: normalizeSupabaseBackups(json.backups),
    };
  } catch {
    return { ok: false, error: 'ارتباط با Supabase برقرار نشد.' };
  }
}

export async function deleteSupabaseBackup(
  idToken: string | null | undefined,
  backupId: string
): Promise<{ ok: boolean; backups?: CloudBackupMeta[]; error?: string }> {
  try {
    const resp = await fetch(`/api/supabase/backups/${encodeURIComponent(backupId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildApiHeaders(idToken),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      backups?: RawServerBackupMeta[];
      error?: string;
    };
    if (!resp.ok) {
      return { ok: false, error: json.error || 'خطا در حذف نسخه پشتیبان' };
    }
    return { ok: true, backups: normalizeSupabaseBackups(json.backups) };
  } catch {
    return { ok: false, error: 'ارتباط با Supabase برقرار نشد.' };
  }
}

export async function resetSupabaseCloudStorage(
  idToken: string | null | undefined,
  options: { clearWorkspace?: boolean; clearBackups?: boolean; clearAuditLogs?: boolean } = {}
): Promise<{
  ok: boolean;
  deletedWorkspace?: boolean;
  deletedBackups?: number;
  deletedAuditLogs?: boolean;
  error?: string;
  code?: string;
}> {
  try {
    const resp = await fetch('/api/supabase/reset', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(idToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        clearWorkspace: options.clearWorkspace !== false,
        clearBackups: options.clearBackups !== false,
        clearAuditLogs: options.clearAuditLogs !== false,
      }),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      deletedWorkspace?: boolean;
      deletedBackups?: number;
      deletedAuditLogs?: boolean;
      error?: string;
      code?: string;
    };
    if (!resp.ok) {
      return {
        ok: false,
        error: json.error || 'خطا در پاکسازی فضای ابری Supabase',
        code: json.code || `HTTP_${resp.status}`,
      };
    }
    return {
      ok: true,
      deletedWorkspace: Boolean(json.deletedWorkspace),
      deletedBackups: Number(json.deletedBackups) || 0,
      deletedAuditLogs: Boolean(json.deletedAuditLogs),
    };
  } catch {
    return {
      ok: false,
      error: 'ارتباط با سرور Supabase برای پاکسازی برقرار نشد.',
      code: 'NETWORK_ERROR',
    };
  }
}

export async function pushSnapshotToSupabase(params: {
  idToken?: string | null;
  operationId?: string;
  deviceId: string;
  deviceLabel: string;
  conflictPolicy: ConflictResolutionPolicy;
  clientRevision: number;
  companyName: string;
  fiscalYear: string;
  voucherCount: number;
  invoiceCount: number;
  productCount: number;
  snapshotJson: string;
}): Promise<{ ok: boolean; data?: SupabaseSyncResponse; error?: string; code?: string }> {
  try {
    const resp = await fetch('/api/supabase/sync', {
      method: 'POST',
      credentials: 'include',
      headers: buildApiHeaders(params.idToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ...(params.operationId ? { operationId: params.operationId } : {}),
        deviceId: params.deviceId,
        deviceLabel: params.deviceLabel,
        conflictPolicy: params.conflictPolicy,
        clientRevision: params.clientRevision,
        clientUpdatedAt: new Date().toISOString(),
        companyName: params.companyName,
        fiscalYear: params.fiscalYear,
        voucherCount: params.voucherCount,
        invoiceCount: params.invoiceCount,
        productCount: params.productCount,
        snapshotJson: params.snapshotJson,
      }),
    });

    const json = (await resp.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    } & Partial<SupabaseSyncResponse>;

    if (!resp.ok) {
      return {
        ok: false,
        error: json.error || 'خطا در همگام‌سازی با Supabase',
        code: json.code || `HTTP_${resp.status}`,
      };
    }

    return {
      ok: true,
      data: json as SupabaseSyncResponse,
    };
  } catch {
    return {
      ok: false,
      error: 'عدم دسترسی به سرور Supabase (تغییرات در صف آفلاین ذخیره ماند).',
      code: 'NETWORK_ERROR',
    };
  }
}

export async function pullSnapshotFromSupabase(
  idToken?: string | null,
  backupId?: string
): Promise<{
  ok: boolean;
  found?: boolean;
  backupId?: string;
  revision?: number;
  lastDeviceLabel?: string;
  updatedAt?: string;
  snapshotJson?: string;
  error?: string;
}> {
  try {
    const url = backupId
      ? `/api/supabase/pull?backupId=${encodeURIComponent(backupId)}`
      : '/api/supabase/pull';
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: buildApiHeaders(idToken),
      cache: 'no-store',
    });
    const json = (await resp.json().catch(() => ({}))) as {
      found?: boolean;
      backupId?: string;
      revision?: number;
      lastDeviceLabel?: string;
      updatedAt?: string;
      snapshotJson?: string;
      error?: string;
    };
    if (!resp.ok) {
      return { ok: false, error: json.error || 'خطا در بازیابی از Supabase' };
    }
    return { ok: true, ...json };
  } catch {
    return { ok: false, error: 'ارتباط با Supabase برقرار نشد.' };
  }
}

// ==================== MULTI-DEVICE CONFLICT & IDEMPOTENCY ENGINE ====================

export interface MultiDeviceSyncConflict {
  hasConflict: boolean;
  requiresManualReview: boolean;
  operationId: string;
  localRevision: number;
  remoteRevision: number;
  localDeviceId: string;
  remoteDeviceId: string;
  conflictFields: string[];
  summary: string;
  resolutionAction: 'apply_local' | 'keep_remote' | 'halt_for_manual_merge' | 'idempotent_skip';
}

/**
 * Explicit non-silent multi-device sync conflict detector.
 * Guarantees financial records are NEVER silently overwritten when two different devices
 * diverge from the same base revision; also enforces unique operationId deduplication.
 */
export function evaluateMultiDeviceSyncState(params: {
  operationId: string;
  seenOperationIds: ReadonlySet<string>;
  localRevision: number;
  remoteRevision: number;
  localDeviceId: string;
  remoteDeviceId: string;
  localSummary: { voucherCount: number; invoiceCount: number; productCount: number; payloadHash: string };
  remoteSummary: { voucherCount: number; invoiceCount: number; productCount: number; payloadHash: string };
  policy: ConflictResolutionPolicy | 'manual_review';
}): MultiDeviceSyncConflict {
  if (params.seenOperationIds.has(params.operationId)) {
    return {
      hasConflict: false,
      requiresManualReview: false,
      operationId: params.operationId,
      localRevision: params.localRevision,
      remoteRevision: params.remoteRevision,
      localDeviceId: params.localDeviceId,
      remoteDeviceId: params.remoteDeviceId,
      conflictFields: [],
      summary: `عملیات ${params.operationId} قبلاً ثبت شده است (تکرار خنثی شد).`,
      resolutionAction: 'idempotent_skip',
    };
  }

  const sameContent = params.localSummary.payloadHash === params.remoteSummary.payloadHash;
  const diverged =
    params.remoteRevision > params.localRevision &&
    params.remoteDeviceId !== params.localDeviceId &&
    !sameContent;

  if (!diverged) {
    return {
      hasConflict: false,
      requiresManualReview: false,
      operationId: params.operationId,
      localRevision: params.localRevision,
      remoteRevision: params.remoteRevision,
      localDeviceId: params.localDeviceId,
      remoteDeviceId: params.remoteDeviceId,
      conflictFields: [],
      summary: 'نسخه محلی با سرور هم‌تراز است و آماده همگام‌سازی بدون تعارض است.',
      resolutionAction: 'apply_local',
    };
  }

  const conflictFields: string[] = [];
  if (params.localSummary.voucherCount !== params.remoteSummary.voucherCount) {
    conflictFields.push(
      `تعداد اسناد (محلی: ${params.localSummary.voucherCount} در برابر سرور: ${params.remoteSummary.voucherCount})`
    );
  }
  if (params.localSummary.invoiceCount !== params.remoteSummary.invoiceCount) {
    conflictFields.push(
      `تعداد فاکتورها (محلی: ${params.localSummary.invoiceCount} در برابر سرور: ${params.remoteSummary.invoiceCount})`
    );
  }
  if (params.localSummary.productCount !== params.remoteSummary.productCount) {
    conflictFields.push(
      `تعداد کالاها (محلی: ${params.localSummary.productCount} در برابر سرور: ${params.remoteSummary.productCount})`
    );
  }
  if (conflictFields.length === 0) {
    conflictFields.push('محتوای اسناد یا مبالغ روی دو دستگاه همزمان تغییر کرده است');
  }

  if (params.policy === 'manual_review') {
    return {
      hasConflict: true,
      requiresManualReview: true,
      operationId: params.operationId,
      localRevision: params.localRevision,
      remoteRevision: params.remoteRevision,
      localDeviceId: params.localDeviceId,
      remoteDeviceId: params.remoteDeviceId,
      conflictFields,
      summary: `تعارض همزمان بین دستگاه ${params.localDeviceId} و ${params.remoteDeviceId} شناسایی شد؛ بازنویسی خودکار متوقف و به بررسی کاربر ارجاع شد.`,
      resolutionAction: 'halt_for_manual_merge',
    };
  }

  if (params.policy === 'first_write_wins') {
    return {
      hasConflict: true,
      requiresManualReview: true,
      operationId: params.operationId,
      localRevision: params.localRevision,
      remoteRevision: params.remoteRevision,
      localDeviceId: params.localDeviceId,
      remoteDeviceId: params.remoteDeviceId,
      conflictFields,
      summary: `تعارض شناسایی شد: طبق سیاست اولین ثبت، نسخه سرور (Rev ${params.remoteRevision}) حفظ می‌شود و نسخه محلی باید بازبینی شود.`,
      resolutionAction: 'keep_remote',
    };
  }

  return {
    hasConflict: true,
    requiresManualReview: true,
    operationId: params.operationId,
    localRevision: params.localRevision,
    remoteRevision: params.remoteRevision,
    localDeviceId: params.localDeviceId,
    remoteDeviceId: params.remoteDeviceId,
    conflictFields,
    summary: `تعارض شناسایی شد: نسخه محلی با ثبت هشدار تعارض و ذخیره بکاپ قبلی قابل اعمال است.`,
    resolutionAction: 'apply_local',
  };
}

