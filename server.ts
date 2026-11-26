import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasSupabaseRevisionConflict, resolveVerifiedFirebaseIdentity } from './server/authPolicy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

// Server-side HMAC signing key for independent Supabase Workspace sessions.
// Prefers explicit SUPABASE_SESSION_SECRET; otherwise derives a deterministic HMAC key
// from SUPABASE_SERVICE_ROLE_KEY so HttpOnly sessions survive restarts without exposing secrets.
const SUPABASE_SESSION_SECRET =
  String(process.env.SUPABASE_SESSION_SECRET || '').trim() ||
  (process.env.SUPABASE_SERVICE_ROLE_KEY
    ? crypto
        .createHmac('sha256', 'holoo-apex-supabase-session-key-v1')
        .update(String(process.env.SUPABASE_SERVICE_ROLE_KEY))
        .digest('hex')
    : crypto.randomBytes(32).toString('hex'));
const SUPABASE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for persistent PWA independent auto-backup
const SUPABASE_SESSION_COOKIE = 'holoo_sb_session';
const SERVER_BOOT_TIME_MS = Date.now();

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Baseline security headers (preserve iframe embed compatibility by omitting X-Frame-Options)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  // Lightweight sliding-window per-IP rate limiter for API routes
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const createRateLimiter = (maxPerMinute: number) => (req: Request, res: Response, next: express.NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${req.method}:${req.baseUrl}${req.path}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets.entries()) {
          if (now > v.resetAt || rateBuckets.size > 4000) rateBuckets.delete(k);
          if (rateBuckets.size <= 4000) break;
        }
      }
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        error: 'تعداد درخواست‌ها بیش از حد مجاز در دقیقه است. لطفاً کمی صبر کرده و دوباره تلاش کنید.',
      });
      return;
    }
    next();
  };

  // Apply API throttling before JSON parsing so oversized or malformed bodies are rate-limited too.
  app.use('/api/ai', createRateLimiter(30));
  app.use('/api/supabase', createRateLimiter(80));
  app.use('/api/live-fx', createRateLimiter(10));
  app.use('/api/server', createRateLimiter(10));
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'holoo-apex-corporate-erp',
      timestamp: new Date().toISOString(),
    });
  });

  // Live Tehran Free-Market FX Rate Proxy (synced with Chand / AlanChand & TGJU)
  interface LiveFxItem {
    code: 'USD' | 'EUR' | 'AED' | 'CNY';
    name: string;
    symbol: string;
    priceIrr: number;
    buyIrr?: number;
    highIrr?: number;
    lowIrr?: number;
    changeIrr: number;
    changePercent: number;
    direction: 'up' | 'down' | 'flat';
    updatedTime: string;
  }

  interface LiveFxCache {
    fetchedAt: number;
    source: string;
    sourceUrl: string;
    items: LiveFxItem[];
  }

  let liveFxCache: LiveFxCache | null = null;
  const FX_CACHE_TTL_MS = 60_000;

  const parseNumericString = (raw: unknown): number => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw !== 'string') return 0;
    const persian = '۰۱۲۳۴۵۶۷۸۹';
    const arabic = '٠١٢٣٤٥٦٧٨٩';
    let normalized = '';
    for (const ch of raw) {
      const pIdx = persian.indexOf(ch);
      if (pIdx !== -1) {
        normalized += String(pIdx);
      } else {
        const aIdx = arabic.indexOf(ch);
        normalized += aIdx !== -1 ? String(aIdx) : ch;
      }
    }
    const cleaned = normalized.replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  async function fetchLiveFxRates(): Promise<LiveFxCache> {
    const items: LiveFxItem[] = [];

    // Primary structured JSON source (Tehran Free Market — aligned with chand.app / TGJU)
    try {
      const tgjuResp = await fetch('https://call1.tgju.org/ajax.json', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HolooApexERP/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (tgjuResp.ok) {
        const json = (await tgjuResp.json()) as {
          current?: Record<
            string,
            {
              p?: string;
              h?: string;
              l?: string;
              d?: string;
              dp?: number | string;
              dt?: string;
              t?: string;
              ts?: string;
            }
          >;
        };
        const cur = json?.current || {};
        const spec: {
          code: 'USD' | 'EUR' | 'AED' | 'CNY';
          key: string;
          name: string;
          symbol: string;
        }[] = [
          { code: 'USD', key: 'price_dollar_rl', name: 'دلار آمریکا', symbol: '$' },
          { code: 'EUR', key: 'price_eur', name: 'یورو اروپا', symbol: '€' },
          { code: 'AED', key: 'price_aed', name: 'درهم امارات', symbol: 'د.إ' },
          { code: 'CNY', key: 'price_cny', name: 'یوان چین', symbol: '¥' },
        ];

        for (const s of spec) {
          const row = cur[s.key];
          if (!row) continue;
          const priceIrr = Math.round(parseNumericString(row.p));
          if (priceIrr <= 0) continue;
          const highIrr = Math.round(parseNumericString(row.h)) || undefined;
          const lowIrr = Math.round(parseNumericString(row.l)) || undefined;
          const rawDelta = Math.round(parseNumericString(row.d));
          const dp = Math.abs(parseNumericString(row.dp));
          const dt = String(row.dt || '').toLowerCase();
          const direction: 'up' | 'down' | 'flat' =
            dt === 'high' ? 'up' : dt === 'low' ? 'down' : 'flat';
          const changeIrr = direction === 'down' ? -Math.abs(rawDelta) : Math.abs(rawDelta);

          items.push({
            code: s.code,
            name: s.name,
            symbol: s.symbol,
            priceIrr,
            highIrr,
            lowIrr,
            changeIrr,
            changePercent: direction === 'down' ? -dp : dp,
            direction,
            updatedTime: String(row.t || row.ts || ''),
          });
        }
      }
    } catch {
      // Fallback below
    }

    // Secondary fallback from AlanChand public currencies page if primary had fewer than 4 items
    if (items.length < 4) {
      try {
        const acResp = await fetch('https://alanchand.com/currencies-price', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HolooApexERP/1.0)' },
          signal: AbortSignal.timeout(6000),
        });
        if (acResp.ok) {
          const html = await acResp.text();
          const existingCodes = new Set(items.map((i) => i.code));
          const fallbackSpecs: {
            code: 'USD' | 'EUR' | 'AED' | 'CNY';
            slug: string;
            name: string;
            symbol: string;
          }[] = [
            { code: 'USD', slug: 'usd', name: 'دلار آمریکا', symbol: '$' },
            { code: 'EUR', slug: 'eur', name: 'یورو اروپا', symbol: '€' },
            { code: 'AED', slug: 'aed', name: 'درهم امارات', symbol: 'د.إ' },
            { code: 'CNY', slug: 'cny', name: 'یوان چین', symbol: '¥' },
          ];
          for (const fs of fallbackSpecs) {
            if (existingCodes.has(fs.code)) continue;
            const idx = html.indexOf(`currencies-price/${fs.slug}`);
            if (idx === -1) continue;
            const textChunk = html
              .slice(idx, idx + 700)
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ');
            const numMatch = textChunk.match(/([۰-۹0-9]{2,3}[,،][۰-۹0-9]{3})/);
            if (numMatch) {
              const toman = parseNumericString(numMatch[1]);
              if (toman > 1000) {
                items.push({
                  code: fs.code,
                  name: fs.name,
                  symbol: fs.symbol,
                  priceIrr: Math.round(toman * 10),
                  changeIrr: 0,
                  changePercent: 0,
                  direction: 'flat',
                  updatedTime: new Date().toLocaleTimeString('fa-IR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                });
              }
            }
          }
        }
      } catch {
        // Ignore fallback failure
      }
    }

    return {
      fetchedAt: Date.now(),
      source: 'بازار آزاد تهران (همگام با chand.app)',
      sourceUrl: 'https://chand.app/',
      items,
    };
  }

  app.get('/api/live-fx', async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      if (
        !forceRefresh &&
        liveFxCache &&
        liveFxCache.items.length > 0 &&
        Date.now() - liveFxCache.fetchedAt < FX_CACHE_TTL_MS
      ) {
        res.json({
          ...liveFxCache,
          cached: true,
        });
        return;
      }

      const fresh = await fetchLiveFxRates();
      if (fresh.items.length > 0) {
        liveFxCache = fresh;
        res.json({ ...fresh, cached: false });
        return;
      }

      if (liveFxCache && liveFxCache.items.length > 0) {
        res.json({ ...liveFxCache, cached: true, stale: true });
        return;
      }

      res.status(502).json({
        error: 'امکان دریافت لحظه‌ای نرخ ارز از سرور منبع وجود ندارد.',
        items: [],
      });
    } catch {
      res.status(502).json({
        error: 'خطا در ارتباط با منبع نرخ لحظه‌ای ارز.',
        items: [],
      });
    }
  });

  // ---------------- 100% LOCAL ON-DEVICE AI POLICY ----------------
  // All AI features run strictly via the embedded Local-SLM inside the client application.
  // Zero prompts, vouchers, invoices, or images are transmitted to external cloud AI services.
  app.all('/api/ai/*', (_req: Request, res: Response) => {
    res.status(410).json({
      error:
        'تمامی قابلیت‌های هوش مصنوعی به صورت ۱۰۰٪ محلی توسط موتور بومی Local-SLM داخل برنامه پردازش می‌شوند و هیچ داده‌ای به سرویس‌های ابری خارجی ارسال نمی‌گردد.',
      mode: 'local_slm_only',
    });
  });

  app.post('/api/images/generate', (_req: Request, res: Response) => {
    res.status(410).json({
      error:
        'برای حفظ حریم خصوصی کامل و عملکرد کاملاً محلی، ارسال داده به سرویس‌های هوش مصنوعی ابری غیرفعال است.',
      mode: 'local_slm_only',
    });
  });

  // ---------------- DUAL-CLOUD SUPABASE POSTGRESQL SYNC PROXY ----------------
  // Keeps SUPABASE_SERVICE_ROLE_KEY strictly on the server and verifies Firebase ID Tokens
  // on every protected sync/pull request before accessing owner-scoped PostgreSQL rows.
  let firebaseWebApiKey = '';
  try {
    const fbCfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(fbCfgPath)) {
      const parsedCfg = JSON.parse(fs.readFileSync(fbCfgPath, 'utf-8')) as { apiKey?: string };
      firebaseWebApiKey = String(parsedCfg.apiKey || '').trim();
    }
  } catch {
    firebaseWebApiKey = '';
  }

  function isPrivateOrBlockedHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      h === 'localhost' ||
      h === '::1' ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
      h === '0.0.0.0'
    ) {
      return true;
    }
    return false;
  }

  type SupabaseKeyRole =
    | 'service_role_jwt'
    | 'sb_secret'
    | 'anon_jwt'
    | 'sb_publishable'
    | 'unknown';

  function classifySupabaseKeyRole(key: string): SupabaseKeyRole {
    if (key.startsWith('sb_secret_')) return 'sb_secret';
    if (key.startsWith('sb_publishable_')) return 'sb_publishable';
    const parts = key.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
          role?: string;
        };
        if (decoded?.role === 'service_role') return 'service_role_jwt';
        if (decoded?.role === 'anon') return 'anon_jwt';
      } catch {
        // non-JWT or malformed payload
      }
    }
    return 'unknown';
  }

  interface ValidatedSupabaseConfig {
    baseUrl: string;
    serviceRoleKey: string;
    keyRole: SupabaseKeyRole;
    tableName: string;
    auditTableName: string;
    projectRef: string;
  }

  function getValidatedSupabaseConfig(): ValidatedSupabaseConfig | null {
    const rawUrl = String(process.env.SUPABASE_URL || '').trim();
    const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!rawUrl || !serviceRoleKey) return null;

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return null;
      if (isPrivateOrBlockedHost(parsed.hostname)) return null;

      const rawTable = String(process.env.SUPABASE_TABLE_NAME || 'holoo_apex_workspaces').trim();
      const tableName = /^[a-z][a-z0-9_]{2,60}$/.test(rawTable)
        ? rawTable
        : 'holoo_apex_workspaces';

      const projectRef = parsed.hostname.split('.')[0] || parsed.hostname;
      return {
        baseUrl: `${parsed.origin}`,
        serviceRoleKey,
        keyRole: classifySupabaseKeyRole(serviceRoleKey),
        tableName,
        auditTableName: 'holoo_apex_audit_log',
        projectRef,
      };
    } catch {
      return null;
    }
  }

  const isValidWorkspaceSlug = (raw: string) => /^[a-zA-Z0-9_-]{3,48}$/.test(raw);
  const isValidOperationId = (raw: string) => /^[a-zA-Z0-9_-]{8,120}$/.test(raw);

  // In-memory LRU cache for idempotent sync replay protection across fast network retries
  const recentSyncedOps = new Map<
    string,
    { serverRevision: number; syncedAt: string; status: string }
  >();

  function hashWorkspacePasscode(passcode: string, saltHex?: string): { saltHex: string; hashHex: string } {
    const salt = saltHex || crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(passcode, salt, 32).toString('hex');
    return { saltHex: salt, hashHex: derived };
  }

  function verifyWorkspacePasscode(passcode: string, saltHex: string, expectedHashHex: string): boolean {
    try {
      const actual = crypto.scryptSync(passcode, saltHex, 32);
      const expected = Buffer.from(expectedHashHex, 'hex');
      if (actual.length !== expected.length) return false;
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  function signSupabaseWorkspaceToken(workspaceId: string): { token: string; expiresAt: string } {
    const exp = Date.now() + SUPABASE_TOKEN_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({ wid: workspaceId, exp, v: 1 }),
      'utf-8'
    ).toString('base64url');
    const sig = crypto
      .createHmac('sha256', SUPABASE_SESSION_SECRET)
      .update(payload)
      .digest('base64url');
    return {
      token: `sbw1.${payload}.${sig}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  function verifySupabaseWorkspaceToken(
    token: string
  ): { uid: string; workspaceId: string; email: string; authSource: 'supabase_workspace' } | null {
    if (!token.startsWith('sbw1.')) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [, payload, sig] = parts;
    if (!payload || !sig) return null;
    try {
      const expectedSig = crypto
        .createHmac('sha256', SUPABASE_SESSION_SECRET)
        .update(payload)
        .digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
        wid?: string;
        exp?: number;
      };
      if (!decoded.wid || !isValidWorkspaceSlug(decoded.wid)) return null;
      if (!decoded.exp || Date.now() > decoded.exp) return null;
      return {
        uid: `sbw_${decoded.wid}`,
        workspaceId: decoded.wid,
        email: `${decoded.wid}@supabase.local`,
        authSource: 'supabase_workspace',
      };
    } catch {
      return null;
    }
  }

  async function verifyFirebaseBearerToken(
    idToken: string
  ): Promise<{ uid: string; email: string; authSource: 'firebase' } | null> {
    if (!idToken || idToken.length > 8192 || !firebaseWebApiKey) return null;

    try {
      const lookupUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseWebApiKey)}`;
      const resp = await fetch(lookupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(7000),
      });
      if (!resp.ok) return null;
      const data: unknown = await resp.json();
      const identity = resolveVerifiedFirebaseIdentity(data);
      if (!identity) return null;
      return {
        ...identity,
        authSource: 'firebase',
      };
    } catch {
      return null;
    }
  }

  function parseCookieValue(req: Request, name: string): string | null {
    const rawCookie = String(req.headers.cookie || '');
    if (!rawCookie) return null;
    for (const part of rawCookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k === name) {
        try {
          return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
          return part.slice(idx + 1).trim();
        }
      }
    }
    return null;
  }

  function setSupabaseSessionCookie(res: Response, token: string): void {
    const maxAgeSec = Math.floor(SUPABASE_TOKEN_TTL_MS / 1000);
    // Emit Secure; SameSite=None; Partitioned; HttpOnly for HTTPS/iframe preview & PWA persistence
    res.setHeader(
      'Set-Cookie',
      `${SUPABASE_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`
    );
  }

  function clearSupabaseSessionCookie(res: Response): void {
    res.setHeader(
      'Set-Cookie',
      `${SUPABASE_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`
    );
  }

  function hasValidCsrfGuard(req: Request): boolean {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const xrw = String(req.headers['x-requested-with'] || '').trim();
    if (xrw === 'HolooApex' || xrw === 'XMLHttpRequest') return true;
    const origin = String(req.headers.origin || '').trim();
    const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (origin && expectedHost) {
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.host.toLowerCase() === expectedHost) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Decoupled auth resolver for Supabase routes:
   * 1. Independent Supabase Workspace Token (`sbw1.*`) via Authorization Bearer OR HttpOnly cookie — ZERO dependency on Firebase!
   * 2. Optional legacy Firebase Bearer token if explicitly sent by a client.
   */
  async function resolveSupabaseActor(
    req: Request
  ): Promise<{
    uid: string;
    workspaceId?: string;
    email: string;
    authSource: 'supabase_workspace' | 'firebase';
  } | null> {
    const authHeader = String(req.headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token && token.length <= 8192) {
        if (token.startsWith('sbw1.')) {
          return verifySupabaseWorkspaceToken(token);
        }
        return verifyFirebaseBearerToken(token);
      }
    }

    const cookieToken = parseCookieValue(req, SUPABASE_SESSION_COOKIE);
    if (cookieToken && cookieToken.startsWith('sbw1.') && cookieToken.length <= 4096) {
      if (!hasValidCsrfGuard(req)) return null;
      return verifySupabaseWorkspaceToken(cookieToken);
    }

    return null;
  }

  async function extractSafePostgrestCode(resp: globalThis.Response): Promise<string> {
    try {
      const raw = (await resp.json()) as { code?: string; message?: string };
      if (raw?.code && /^[A-Z0-9_]{2,20}$/.test(String(raw.code))) {
        return String(raw.code);
      }
    } catch {
      // ignore non-JSON body
    }
    return `HTTP_${resp.status}`;
  }

  function buildSupabaseHeaders(cfg: ValidatedSupabaseConfig, extra?: Record<string, string>) {
    // New Supabase Secret API keys (sb_secret_*) must be sent in `apikey` only,
    // NOT in `Authorization: Bearer` (which PostgREST parses strictly as a JWT).
    const headers: Record<string, string> = {
      apikey: cfg.serviceRoleKey,
      'Content-Type': 'application/json',
      ...extra,
    };
    if (cfg.keyRole !== 'sb_secret' && cfg.keyRole !== 'sb_publishable') {
      headers.Authorization = `Bearer ${cfg.serviceRoleKey}`;
    }
    return headers;
  }

  function isReadOnlySupabaseKey(cfg: ValidatedSupabaseConfig): boolean {
    return cfg.keyRole === 'anon_jwt' || cfg.keyRole === 'sb_publishable';
  }

  // Independent Supabase Workspace Auth — Check if a workspace passcode is already initialized
  app.get('/api/supabase/auth/state', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }
    const workspaceId = String(req.query.workspaceId || 'atlasris_main').trim();
    if (!isValidWorkspaceSlug(workspaceId)) {
      res.status(400).json({ error: 'شناسه فضای کاری باید شامل حروف انگلیسی، عدد یا خط تیره (۳ تا ۴۸ کاراکتر) باشد.' });
      return;
    }

    try {
      const authOwnerKey = `__sb_auth__${workspaceId}`;
      const url = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(authOwnerKey)}&select=owner_id,updated_at&limit=1`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'خطا در بررسی وضعیت حساب مستقل Supabase.' });
        return;
      }
      const rows = (await resp.json().catch(() => [])) as { owner_id?: string }[];
      res.json({
        workspaceId,
        initialized: Array.isArray(rows) && rows.length > 0,
      });
    } catch {
      res.status(502).json({ error: 'ارتباط با Supabase برای بررسی فضای کاری برقرار نشد.' });
    }
  });

  // Independent Supabase Workspace Auth — First-run setup (creates scrypt-hashed passcode in Supabase)
  app.post('/api/supabase/auth/setup', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }
    if (isReadOnlySupabaseKey(cfg)) {
      res.status(403).json({
        error:
          'کلید تنظیم‌شده در SUPABASE_SERVICE_ROLE_KEY از نوع anon/publishable است و به دلیل فعال بودن RLS اجازه ایجاد فضای کاری ندارد. لطفاً کلید service_role یا secret key (با پیشوند sb_secret_) را از بخش API Keys در پنل Supabase در تنظیمات Secrets وارد کنید.',
        code: 'INVALID_ANON_KEY',
      });
      return;
    }

    const workspaceId = String(req.body?.workspaceId || '').trim();
    const passcode = String(req.body?.passcode || '');

    if (!isValidWorkspaceSlug(workspaceId)) {
      res.status(400).json({ error: 'شناسه فضای کاری نامعتبر است (فقط حروف انگلیسی، عدد، - و _ مجاز است).' });
      return;
    }
    if (passcode.length < 6 || passcode.length > 128) {
      res.status(400).json({ error: 'رمز عبور فضای کاری Supabase باید حداقل ۶ کاراکتر باشد.' });
      return;
    }

    const authOwnerKey = `__sb_auth__${workspaceId}`;
    try {
      // Prevent overwriting an already-claimed workspace
      const checkUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(authOwnerKey)}&select=owner_id&limit=1`;
      const checkResp = await fetch(checkUrl, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(6000),
      });
      if (checkResp.ok) {
        const existing = (await checkResp.json().catch(() => [])) as unknown[];
        if (Array.isArray(existing) && existing.length > 0) {
          res.status(409).json({
            error: 'این فضای کاری قبلاً فعال شده است. لطفاً با رمز عبور ثبت‌شده وارد شوید.',
          });
          return;
        }
      }

      const { saltHex, hashHex } = hashWorkspacePasscode(passcode);
      const nowIso = new Date().toISOString();
      const createResp = await fetch(`${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}`, {
        method: 'POST',
        headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          owner_id: authOwnerKey,
          owner_email: `${workspaceId}@supabase.local`,
          company_name: `Workspace Auth (${workspaceId})`,
          fiscal_year: '1405',
          revision: 1,
          conflict_policy: 'last_write_wins',
          last_device_id: 'auth_setup',
          last_device_label: 'Supabase Independent Auth',
          voucher_count: 0,
          invoice_count: 0,
          product_count: 0,
          snapshot_json: {
            kind: 'supabase_workspace_auth_v1',
            workspaceId,
            saltHex,
            hashHex,
            createdAt: nowIso,
          },
          client_updated_at: nowIso,
          updated_at: nowIso,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!createResp.ok) {
        const pgCode = await extractSafePostgrestCode(createResp);
        if (pgCode === '42501') {
          res.status(403).json({
            error:
              'دسترسی نوشتن در جدول Supabase به دلیل سیاست RLS رد شد (کد 42501). لطفاً مطمئن شوید مقدار SUPABASE_SERVICE_ROLE_KEY در Secrets برابر با کلید service_role یا secret key (sb_secret_...) است و نه کلید anon/publishable.',
            code: pgCode,
          });
          return;
        }
        if (pgCode === '23505') {
          res.status(409).json({
            error: 'این فضای کاری قبلاً در Supabase ثبت شده است. لطفاً از گزینه «ورود مستقل» استفاده کنید.',
            code: pgCode,
          });
          return;
        }
        if (pgCode === '42P01' || pgCode === 'PGRST205') {
          res.status(400).json({
            error: 'جدول holoo_apex_workspaces هنوز در Supabase ایجاد نشده است. لطفاً فایل supabase/schema.sql را در SQL Editor اجرا کنید.',
            code: pgCode,
          });
          return;
        }
        if (pgCode === 'PGRST204' || pgCode === '42703') {
          res.status(400).json({
            error: 'ساختار ستون‌های جدول Supabase با نسخه فعلی هماهنگ نیست. لطفاً اسکریپت supabase/schema.sql را مجدداً اجرا کنید.',
            code: pgCode,
          });
          return;
        }
        res.status(createResp.status).json({
          error: `خطا در فعال‌سازی فضای کاری مستقل Supabase (کد ${pgCode}).`,
          code: pgCode,
        });
        return;
      }

      const signed = signSupabaseWorkspaceToken(workspaceId);
      setSupabaseSessionCookie(res, signed.token);
      res.json({
        ok: true,
        workspaceId,
        token: signed.token,
        expiresAt: signed.expiresAt,
        currentRevision: 0,
      });
    } catch {
      res.status(502).json({ error: 'ارتباط با Supabase برقرار نشد.' });
    }
  });

  // Independent Supabase Workspace Auth — Sign in with workspaceId + passcode (no Firebase/Google required!)
  app.post('/api/supabase/auth/login', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }
    const workspaceId = String(req.body?.workspaceId || '').trim();
    const passcode = String(req.body?.passcode || '');

    if (!isValidWorkspaceSlug(workspaceId) || passcode.length < 6 || passcode.length > 128) {
      res.status(400).json({ error: 'شناسه فضای کاری یا رمز عبور معتبر نیست.' });
      return;
    }

    const authOwnerKey = `__sb_auth__${workspaceId}`;
    try {
      const url = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(authOwnerKey)}&select=snapshot_json&limit=1`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'خطا در بررسی اطلاعات ورود Supabase.' });
        return;
      }
      const rows = (await resp.json().catch(() => [])) as {
        snapshot_json?: { saltHex?: string; hashHex?: string } | string;
      }[];
      const rawAuth = rows?.[0]?.snapshot_json;
      const authObj =
        typeof rawAuth === 'string'
          ? (JSON.parse(rawAuth) as { saltHex?: string; hashHex?: string })
          : rawAuth;

      if (!authObj?.saltHex || !authObj?.hashHex) {
        res.status(404).json({
          error: 'این فضای کاری هنوز در Supabase ایجاد نشده است. ابتدا روی «ایجاد و فعال‌سازی» کلیک کنید.',
        });
        return;
      }

      const valid = verifyWorkspacePasscode(passcode, authObj.saltHex, authObj.hashHex);
      if (!valid) {
        res.status(401).json({ error: 'رمز عبور فضای کاری Supabase اشتباه است.' });
        return;
      }

      const signed = signSupabaseWorkspaceToken(workspaceId);
      setSupabaseSessionCookie(res, signed.token);

      // Hydrate current server revision immediately on login so UI never stalls at #0
      let currentRevision = 0;
      let currentUpdatedAt: string | null = null;
      try {
        const revUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(`sbw_${workspaceId}`)}&select=revision,updated_at&limit=1`;
        const revResp = await fetch(revUrl, {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(5000),
        });
        if (revResp.ok) {
          const revRows = (await revResp.json().catch(() => [])) as {
            revision?: number;
            updated_at?: string;
          }[];
          if (revRows?.[0]) {
            currentRevision = Number(revRows[0].revision) || 0;
            currentUpdatedAt = revRows[0].updated_at || null;
          }
        }
      } catch {
        // Non-blocking revision lookup
      }

      res.json({
        ok: true,
        workspaceId,
        token: signed.token,
        expiresAt: signed.expiresAt,
        currentRevision,
        currentUpdatedAt,
      });
    } catch {
      res.status(502).json({ error: 'ارتباط با Supabase برای ورود مستقل برقرار نشد.' });
    }
  });

  // Restore independent Supabase workspace session from HttpOnly cookie (zero Firebase dependency)
  app.get('/api/supabase/auth/me', async (req: Request, res: Response) => {
    const verified = await resolveSupabaseActor(req);
    if (!verified || verified.authSource !== 'supabase_workspace' || !verified.workspaceId) {
      res.json({ authenticated: false, workspaceId: null, serverRevision: 0, updatedAt: null, backupCount: 0 });
      return;
    }

    const cfg = getValidatedSupabaseConfig();
    let serverRevision = 0;
    let updatedAt: string | null = null;
    let backupCount = 0;

    if (cfg) {
      try {
        const [curResp, bakResult] = await Promise.all([
          fetch(
            `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&select=revision,updated_at&limit=1`,
            {
              method: 'GET',
              headers: buildSupabaseHeaders(cfg),
              signal: AbortSignal.timeout(6000),
            }
          ),
          listAndPruneSupabaseBackups(cfg, verified.uid),
        ]);
        if (curResp.ok) {
          const rows = (await curResp.json().catch(() => [])) as {
            revision?: number;
            updated_at?: string;
          }[];
          if (rows?.[0]) {
            serverRevision = Number(rows[0].revision) || 0;
            updatedAt = rows[0].updated_at || null;
          }
        }
        backupCount = bakResult.backups.length;
      } catch {
        // Return authenticated session even on transient Supabase latency
      }
    }

    res.json({
      authenticated: true,
      authSource: 'supabase_workspace',
      workspaceId: verified.workspaceId,
      serverRevision,
      updatedAt,
      backupCount,
    });
  });

  // Clear independent Supabase HttpOnly session cookie
  app.post('/api/supabase/auth/logout', (req: Request, res: Response) => {
    if (!hasValidCsrfGuard(req)) {
      res.status(403).json({ error: 'درخواست خروج معتبر نیست.' });
      return;
    }
    clearSupabaseSessionCookie(res);
    res.json({ ok: true });
  });

  // Public health check for Supabase connectivity (never returns secrets)
  app.get('/api/supabase/status', async (_req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.json({
        configured: false,
        connected: false,
        tableReady: false,
        projectRef: null,
        tableName: 'holoo_apex_workspaces',
        latencyMs: null,
        errorCode: 'NOT_CONFIGURED',
      });
      return;
    }

    const t0 = Date.now();
    try {
      const checkUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?select=owner_id&limit=1`;
      const resp = await fetch(checkUrl, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Math.max(1, Date.now() - t0);

      if (resp.ok) {
        const invalidAnon = isReadOnlySupabaseKey(cfg);
        res.json({
          configured: true,
          connected: true,
          tableReady: !invalidAnon,
          keyRole: cfg.keyRole,
          projectRef: cfg.projectRef,
          tableName: cfg.tableName,
          latencyMs,
          errorCode: invalidAnon ? 'INVALID_ANON_KEY' : null,
        });
        return;
      }

      if (resp.status === 404 || resp.status === 400) {
        res.json({
          configured: true,
          connected: true,
          tableReady: false,
          projectRef: cfg.projectRef,
          tableName: cfg.tableName,
          latencyMs,
          errorCode: 'TABLE_MISSING',
        });
        return;
      }

      res.json({
        configured: true,
        connected: false,
        tableReady: false,
        projectRef: cfg.projectRef,
        tableName: cfg.tableName,
        latencyMs,
        errorCode: resp.status === 401 || resp.status === 403 ? 'AUTH_FAILED' : `HTTP_${resp.status}`,
      });
    } catch {
      res.json({
        configured: true,
        connected: false,
        tableReady: false,
        projectRef: cfg.projectRef,
        tableName: cfg.tableName,
        latencyMs: null,
        errorCode: 'NETWORK_UNREACHABLE',
      });
    }
  });

  // Comprehensive live Server + Supabase diagnostics endpoint (never exposes secrets)
  app.get('/api/server/diagnostics', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    const verified = await resolveSupabaseActor(req);

    const serverInfo = {
      status: 'ok' as const,
      service: 'holoo-apex-corporate-erp',
      mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      port: PORT,
      nodeVersion: process.version,
      uptimeSec: Math.max(0, Math.floor((Date.now() - SERVER_BOOT_TIME_MS) / 1000)),
      localAiPolicy: 'local_slm_only' as const,
      independentSupabaseMode: true,
      timestamp: new Date().toISOString(),
    };

    if (!cfg) {
      res.json({
        server: serverInfo,
        supabase: {
          configured: false,
          connected: false,
          tableReady: false,
          auditTableReady: false,
          projectRef: null,
          tableName: 'holoo_apex_workspaces',
          auditTableName: 'holoo_apex_audit_log',
          latencyMs: null,
          errorCode: 'NOT_CONFIGURED',
        },
        session: {
          authenticated: false,
          authSource: 'disconnected',
          workspaceId: null,
          serverRevision: 0,
          lastUpdatedAt: null,
          backupCount: 0,
        },
      });
      return;
    }

    const t0 = Date.now();
    let connected = false;
    let tableReady = false;
    let auditTableReady = false;
    let errorCode: string | null = null;
    let latencyMs: number | null = null;

    try {
      const [wsResp, auditResp] = await Promise.all([
        fetch(`${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?select=owner_id&limit=1`, {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(6000),
        }),
        fetch(`${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.auditTableName)}?select=id&limit=1`, {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(6000),
        }).catch(() => null),
      ]);
      latencyMs = Math.max(1, Date.now() - t0);
      if (wsResp.ok) {
        connected = true;
        if (isReadOnlySupabaseKey(cfg)) {
          tableReady = false;
          errorCode = 'INVALID_ANON_KEY';
        } else {
          tableReady = true;
        }
      } else if (wsResp.status === 404 || wsResp.status === 400) {
        connected = true;
        tableReady = false;
        errorCode = 'TABLE_MISSING';
      } else {
        errorCode = wsResp.status === 401 || wsResp.status === 403 ? 'AUTH_FAILED' : `HTTP_${wsResp.status}`;
      }
      auditTableReady = Boolean(auditResp && auditResp.ok);
    } catch {
      errorCode = 'NETWORK_UNREACHABLE';
    }

    let serverRevision = 0;
    let lastUpdatedAt: string | null = null;
    let backupCount = 0;

    if (verified && isValidSafeId(verified.uid) && tableReady) {
      try {
        const [curResp, bakResult] = await Promise.all([
          fetch(
            `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&select=revision,updated_at&limit=1`,
            {
              method: 'GET',
              headers: buildSupabaseHeaders(cfg),
              signal: AbortSignal.timeout(6000),
            }
          ),
          listAndPruneSupabaseBackups(cfg, verified.uid),
        ]);
        if (curResp.ok) {
          const rows = (await curResp.json().catch(() => [])) as {
            revision?: number;
            updated_at?: string;
          }[];
          if (rows?.[0]) {
            serverRevision = Number(rows[0].revision) || 0;
            lastUpdatedAt = rows[0].updated_at || null;
          }
        }
        backupCount = bakResult.backups.length;
      } catch {
        // Non-blocking session inspection
      }
    }

    res.json({
      server: serverInfo,
      supabase: {
        configured: true,
        connected,
        tableReady,
        auditTableReady,
        projectRef: cfg.projectRef,
        tableName: cfg.tableName,
        auditTableName: cfg.auditTableName,
        latencyMs,
        errorCode,
      },
      session: {
        authenticated: Boolean(verified),
        authSource: verified ? verified.authSource : 'disconnected',
        workspaceId: verified?.workspaceId || null,
        serverRevision,
        lastUpdatedAt,
        backupCount,
      },
    });
  });

  // Live Interactive Server & Supabase Multi-Step Test Endpoint
  app.post('/api/supabase/test', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const checks: {
      id: string;
      title: string;
      ok: boolean;
      latencyMs: number;
      detail: string;
    }[] = [];

    // 1. Express Server Health
    checks.push({
      id: 'express_api',
      title: 'سرویس بک‌اند Express و سیاست حریم خصوصی',
      ok: true,
      latencyMs: 1,
      detail: `فعال روی پورت ${PORT} (${process.env.NODE_ENV === 'production' ? 'Production' : 'Development'}) · هوش مصنوعی ۱۰۰٪ محلی`,
    });

    interface SupabaseRemediationItem {
      id: string;
      severity: 'critical' | 'warning' | 'info';
      title: string;
      summary: string;
      steps: string[];
      envKeyHint?: string;
    }

    const remediations: SupabaseRemediationItem[] = [];

    // 2. Supabase Server Configuration
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      checks.push({
        id: 'supabase_env',
        title: 'پیکربندی کلیدهای سرور Supabase',
        ok: false,
        latencyMs: 1,
        detail: 'متغیرهای SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY روی سرور تنظیم نشده‌اند.',
      });
      remediations.push({
        id: 'missing_env_vars',
        severity: 'critical',
        title: 'کلیدهای اتصال Supabase در محیط سرور تنظیم نشده است',
        summary: 'برای فعال‌سازی فضای کاری مستقل، آدرس پروژه و کلید مخفی سرور باید در بخش Secrets ذخیره شوند.',
        envKeyHint: 'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
        steps: [
          'وارد پنل Supabase شوید و از مسیر Project Settings → Data API آدرس HTTPS پروژه (https://<ref>.supabase.co) را کپی کرده و در متغیر SUPABASE_URL قرار دهید.',
          'از مسیر Project Settings → API Keys کلید مخفی Secret (شروع با sb_secret_...) یا service_role را کپی کرده و در متغیر SUPABASE_SERVICE_ROLE_KEY ذخیره کنید.',
          'پس از ذخیره متغیرها، دکمه «اجرای مجدد عیب‌یابی خودکار» را بزنید.',
        ],
      });
      res.json({
        ok: false,
        testedAt: new Date().toISOString(),
        totalLatencyMs: Math.max(1, Date.now() - startedAt),
        projectRef: null,
        serverRevision: 0,
        backupCount: 0,
        authSource: 'disconnected',
        keyRole: 'missing',
        networkReachable: false,
        rlsWriteReady: false,
        remediations,
        checks,
      });
      return;
    }

    const hasInvalidAnonKey = isReadOnlySupabaseKey(cfg);
    checks.push({
      id: 'supabase_env',
      title: 'پیکربندی کلیدهای سرور Supabase',
      ok: !hasInvalidAnonKey,
      latencyMs: 1,
      detail: hasInvalidAnonKey
        ? `خطا: کلید تنظیم‌شده در SUPABASE_SERVICE_ROLE_KEY از نوع عمومی (${cfg.keyRole}) است و توسط RLS مسدود می‌شود. لطفاً کلید مخفی Secret (sb_secret_...) یا service_role را از بخش API Keys در Supabase وارد کنید.`
        : `پروژه ${cfg.projectRef} با ارتباط امن HTTPS و کلید مجاز سرور (${cfg.keyRole}) تنظیم شده است.`,
    });

    if (hasInvalidAnonKey) {
      remediations.push({
        id: 'replace_publishable_key',
        severity: 'critical',
        title: 'کلید فعلی از نوع عمومی (Publishable/Anon) است و اجازه نوشتن ندارد',
        summary: `سیاست امنیتی RLS روی جداول حسابداری فعال است؛ کلید فعلی (${cfg.keyRole}) توسط PostgreSQL با خطای ۴۲۵۰۱ رد می‌شود.`,
        envKeyHint: 'SUPABASE_SERVICE_ROLE_KEY',
        steps: [
          'در پنل Supabase به مسیر Project Settings → API Keys بروید.',
          'به‌جای Publishable / anon key، کلید مخفی Secret key (با پیشوند sb_secret_...) یا Legacy service_role را کپی کنید.',
          'مقدار متغیر SUPABASE_SERVICE_ROLE_KEY را در تنظیمات Secrets محیط اجرا با کلید مخفی جایگزین کنید.',
          'پس از اعمال تغییر، سرور به‌صورت خودکار دسترسی نوشتن را تایید می‌کند و می‌توانید فضای کاری مستقل را فعال کنید.',
        ],
      });
    }

    // 3. Workspaces table live probe
    let tableReady = false;
    let networkReachable = false;
    let workspaceHttpStatus: number | null = null;
    const tWs = Date.now();
    try {
      const wsResp = await fetch(
        `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?select=owner_id,revision,updated_at&limit=1`,
        {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(7000),
        }
      );
      networkReachable = true;
      workspaceHttpStatus = wsResp.status;
      const wsMs = Math.max(1, Date.now() - tWs);
      if (wsResp.ok) {
        tableReady = true;
        checks.push({
          id: 'supabase_workspaces_table',
          title: `اتصال به جدول ${cfg.tableName}`,
          ok: true,
          latencyMs: wsMs,
          detail: hasInvalidAnonKey
            ? `شبکه Supabase در دسترس است (${wsMs}ms)، اما برای نوشتن و ایجاد فضای کاری نیاز به کلید مخفی Secret دارید.`
            : `اتصال برقرار و جدول اسنپ‌شات آماده خواندن و نوشتن است (${wsMs}ms).`,
        });
      } else {
        const pgCode = await extractSafePostgrestCode(wsResp);
        checks.push({
          id: 'supabase_workspaces_table',
          title: `اتصال به جدول ${cfg.tableName}`,
          ok: false,
          latencyMs: wsMs,
          detail:
            wsResp.status === 404
              ? 'جدول ایجاد نشده است؛ اسکریپت supabase/schema.sql را اجرا کنید.'
              : `خطای Supabase (${pgCode})`,
        });
        if (wsResp.status === 404 || pgCode.includes('42P01')) {
          remediations.push({
            id: 'missing_workspaces_table',
            severity: 'critical',
            title: `جدول ${cfg.tableName} در پایگاه داده ایجاد نشده است`,
            summary: 'اتصال شبکه به Supabase برقرار است اما ساختار جداول حسابداری هنوز اجرا نشده است.',
            steps: [
              'وارد Supabase Dashboard → SQL Editor شوید و یک Query جدید باز کنید.',
              'محتوای فایل supabase/schema.sql پروژه را کامل کپی کرده و اجرا (Run) کنید.',
              'پس از مشاهده پیام Success، تست خودکار را مجدداً اجرا نمایید.',
            ],
          });
        } else if (wsResp.status === 401 || wsResp.status === 403) {
          if (!hasInvalidAnonKey) {
            remediations.push({
              id: 'invalid_or_revoked_api_key',
              severity: 'critical',
              title: 'احراز هویت کلید API توسط Supabase رد شد (HTTP 401/403)',
              summary: 'کلید تنظیم‌شده ممکن است منقضی، باطل (Revoked) یا متعلق به پروژه دیگری باشد.',
              envKeyHint: 'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
              steps: [
                'اطمینان حاصل کنید SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY هر دو متعلق به یک پروژه واحد در Supabase هستند.',
                'در بخش API Keys بررسی کنید کلید Secret فعال (Active) و بدون فاصله اضافی در ابتدا/انتها کپی شده باشد.',
              ],
            });
          }
        }
      }
    } catch {
      checks.push({
        id: 'supabase_workspaces_table',
        title: `اتصال به جدول ${cfg.tableName}`,
        ok: false,
        latencyMs: Math.max(1, Date.now() - tWs),
        detail: 'پاسخی از سرور Supabase دریافت نشد (تایم‌اوت یا خطای شبکه).',
      });
      remediations.push({
        id: 'network_timeout_or_paused',
        severity: 'critical',
        title: 'ارتباط شبکه با سرور Supabase برقرار نشد',
        summary: 'درخواست HTTPS به Supabase با تایم‌اوت یا خطای دسترسی شبکه مواجه شد.',
        envKeyHint: 'SUPABASE_URL',
        steps: [
          'بررسی کنید پروژه Supabase در حالت Paused (متوقف‌شده به‌دلیل عدم استفاده) نباشد و از داشبورد Supabase آن را Restore کنید.',
          'صحت دامنه در SUPABASE_URL را بررسی کنید (باید دقیقاً با https:// شروع شده و به .supabase.co ختم شود).',
          'اتصال اینترنت، DNS یا فایروال شبکه سرور را بررسی و دوباره تست بگیرید.',
        ],
      });
    }

    // 4. Audit log table live probe
    let auditReady = false;
    const tAud = Date.now();
    try {
      const audResp = await fetch(
        `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.auditTableName)}?select=id&limit=1`,
        {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(6000),
        }
      );
      networkReachable = true;
      const audMs = Math.max(1, Date.now() - tAud);
      auditReady = audResp.ok;
      checks.push({
        id: 'supabase_audit_table',
        title: `اتصال به جدول ممیزی ${cfg.auditTableName}`,
        ok: audResp.ok,
        latencyMs: audMs,
        detail: audResp.ok
          ? `جدول گزارش ممیزی آماده ثبت رویدادهای پشتیبان‌گیری است (${audMs}ms).`
          : `جدول ممیزی پاسخ نداد (کد HTTP ${audResp.status}).`,
      });
      if (!audResp.ok && audResp.status === 404 && !remediations.some((r) => r.id === 'missing_workspaces_table')) {
        remediations.push({
          id: 'missing_audit_table',
          severity: 'warning',
          title: `جدول ممیزی ${cfg.auditTableName} یافت نشد`,
          summary: 'برای ثبت تاریخچه ممیزی و تست نوشتن سرور، اجرای بخش ممیزی در supabase/schema.sql لازم است.',
          steps: [
            'اسکریپت supabase/schema.sql را مجدداً در SQL Editor پروژه Supabase اجرا کنید (ایمن و Idempotent است).',
          ],
        });
      }
    } catch {
      checks.push({
        id: 'supabase_audit_table',
        title: `اتصال به جدول ممیزی ${cfg.auditTableName}`,
        ok: false,
        latencyMs: Math.max(1, Date.now() - tAud),
        detail: 'بررسی جدول ممیزی با خطای شبکه مواجه شد.',
      });
    }

    // 5. Independent Session + Live Revision & Write Probe
    const verified = await resolveSupabaseActor(req);
    let serverRevision = 0;
    let backupCount = 0;
    let writeVerified = false;

    if (!verified || !isValidSafeId(verified.uid)) {
      checks.push({
        id: 'supabase_session',
        title: 'نشست مستقل فضای کاری (بدون وابستگی به Firebase)',
        ok: false,
        latencyMs: 1,
        detail:
          'هنوز فضای کاری مستقل Supabase متصل نشده است. در همین بخش شناسه فضای کاری و رمز عبور را وارد کرده و روی «ایجاد یا ورود مستقل» کلیک کنید.',
      });
      if (!hasInvalidAnonKey && tableReady) {
        remediations.push({
          id: 'activate_independent_workspace',
          severity: 'info',
          title: 'سرور آماده است — اکنون فضای کاری مستقل را فعال کنید',
          summary: 'تمام پیش‌نیازهای شبکه، کلید API و جداول PostgreSQL سالم هستند و فقط ورود/ایجاد فضای کاری باقی مانده است.',
          steps: [
            'یک شناسه فضای کاری انگلیسی (مثلاً atlasris_main) و رمز عبور حداقل ۶ کاراکتری وارد کنید.',
            'روی دکمه «ایجاد و راه‌اندازی مستقل Supabase» کلیک کنید تا نسخه #۱ فوراً ذخیره شود.',
          ],
        });
      }
    } else if (tableReady) {
      const tSess = Date.now();
      try {
        const [curResp, bakResult] = await Promise.all([
          fetch(
            `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&select=revision,updated_at,last_device_label&limit=1`,
            {
              method: 'GET',
              headers: buildSupabaseHeaders(cfg),
              signal: AbortSignal.timeout(6000),
            }
          ),
          listAndPruneSupabaseBackups(cfg, verified.uid),
        ]);
        const sessMs = Math.max(1, Date.now() - tSess);
        if (curResp.ok) {
          const rows = (await curResp.json().catch(() => [])) as {
            revision?: number;
            updated_at?: string;
            last_device_label?: string;
          }[];
          if (rows?.[0]) {
            serverRevision = Number(rows[0].revision) || 0;
          }
        }
        backupCount = bakResult.backups.length;

        // Safe write-capability verification on audit log (does not alter accounting snapshots)
        if (auditReady && !hasInvalidAnonKey) {
          try {
            const wResp = await fetch(
              `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.auditTableName)}`,
              {
                method: 'POST',
                headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
                body: JSON.stringify({
                  owner_id: verified.uid,
                  device_id: 'server_test',
                  device_label: 'تست زنده سرور',
                  action: 'connectivity_test',
                  conflict_policy: 'last_write_wins',
                  client_revision: serverRevision,
                  server_revision: serverRevision,
                  outcome: 'ok',
                  details: 'Live read/write server diagnostics test succeeded',
                }),
                signal: AbortSignal.timeout(5000),
              }
            );
            writeVerified = wResp.ok;
          } catch {
            writeVerified = false;
          }
        }

        checks.push({
          id: 'supabase_session',
          title: 'نشست مستقل و تست خواندن/نوشتن Supabase',
          ok: !hasInvalidAnonKey,
          latencyMs: sessMs,
          detail: `فضای کاری «${verified.workspaceId || verified.uid}» فعال است · نسخه فعلی سرور: #${serverRevision} · پشتیبان‌های نگهداری‌شده: ${backupCount}/${MAX_SUPABASE_CLOUD_BACKUPS}${writeVerified ? ' · تست نوشتن PostgreSQL تایید شد' : ''}.`,
        });
      } catch {
        checks.push({
          id: 'supabase_session',
          title: 'نشست مستقل و تست خواندن/نوشتن Supabase',
          ok: false,
          latencyMs: Math.max(1, Date.now() - tSess),
          detail: 'خطا در خواندن نسخه فعلی فضای کاری از Supabase.',
        });
      }
    }

    const rlsWriteReady = !hasInvalidAnonKey && tableReady && (workspaceHttpStatus === 200 || writeVerified);
    const allCoreOk = checks
      .filter((c) => c.id !== 'supabase_session')
      .every((c) => c.ok);

    res.json({
      ok: allCoreOk,
      testedAt: new Date().toISOString(),
      totalLatencyMs: Math.max(1, Date.now() - startedAt),
      projectRef: cfg.projectRef,
      serverRevision,
      backupCount,
      authSource: verified ? verified.authSource : 'disconnected',
      keyRole: cfg.keyRole,
      networkReachable,
      rlsWriteReady,
      remediations,
      checks,
    });
  });

  const MAX_SUPABASE_CLOUD_BACKUPS = 3;
  const isValidSafeId = (val: string) => /^[a-zA-Z0-9_-]{4,180}$/.test(val);

  interface SupabaseBackupRowMeta {
    owner_id: string;
    revision?: number;
    company_name?: string;
    fiscal_year?: string;
    last_device_label?: string;
    voucher_count?: number;
    invoice_count?: number;
    product_count?: number;
    updated_at?: string;
    created_at?: string;
  }

  function mapSupabaseBackupMeta(row: SupabaseBackupRowMeta) {
    return {
      id: row.owner_id,
      provider: 'supabase' as const,
      revision: Number(row.revision) || 1,
      savedAt: row.created_at || row.updated_at || new Date().toISOString(),
      deviceLabel: row.last_device_label || 'دستگاه کاری',
      companyName: row.company_name || '',
      fiscalYear: row.fiscal_year || '1405',
      voucherCount: Number(row.voucher_count) || 0,
      invoiceCount: Number(row.invoice_count) || 0,
      productCount: Number(row.product_count) || 0,
    };
  }

  async function listAndPruneSupabaseBackups(
    cfg: ValidatedSupabaseConfig,
    ownerUid: string
  ): Promise<{ backups: ReturnType<typeof mapSupabaseBackupMeta>[]; prunedCount: number }> {
    if (!isValidSafeId(ownerUid)) return { backups: [], prunedCount: 0 };
    const prefix = `${ownerUid}__bak__`;
    const listUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=like.${encodeURIComponent(prefix + '*')}&select=owner_id,revision,company_name,fiscal_year,last_device_label,voucher_count,invoice_count,product_count,updated_at,created_at&order=created_at.desc&limit=30`;

    const resp = await fetch(listUrl, {
      method: 'GET',
      headers: buildSupabaseHeaders(cfg),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return { backups: [], prunedCount: 0 };

    const rawRows = (await resp.json().catch(() => [])) as SupabaseBackupRowMeta[];
    // Strict prefix check in code so PostgreSQL LIKE underscore wildcards can never cross-match
    const ownedRows = rawRows
      .filter((r) => typeof r.owner_id === 'string' && r.owner_id.startsWith(prefix))
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));

    const toKeep = ownedRows.slice(0, MAX_SUPABASE_CLOUD_BACKUPS);
    const toDelete = ownedRows.slice(MAX_SUPABASE_CLOUD_BACKUPS);

    let prunedCount = 0;
    for (const oldRow of toDelete) {
      try {
        const delUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(oldRow.owner_id)}`;
        const delResp = await fetch(delUrl, {
          method: 'DELETE',
          headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
          signal: AbortSignal.timeout(5000),
        });
        if (delResp.ok) prunedCount += 1;
      } catch {
        // Continue pruning remaining stale backups
      }
    }

    return {
      backups: toKeep.map(mapSupabaseBackupMeta),
      prunedCount,
    };
  }

  // List current workspace revision metadata + up to 3 retained Supabase cloud backups (lightweight, no snapshot_json)
  app.get('/api/supabase/backups', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }

    const verified = await resolveSupabaseActor(req);
    if (!verified || !isValidSafeId(verified.uid)) {
      res.status(401).json({ error: 'برای مشاهده پشتیبان‌های Supabase ابتدا فضای کاری مستقل Supabase را متصل کنید.' });
      return;
    }

    try {
      const currentUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&select=revision,last_device_id,last_device_label,updated_at&limit=1`;
      const [currentResp, backupResult] = await Promise.all([
        fetch(currentUrl, {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(7000),
        }),
        listAndPruneSupabaseBackups(cfg, verified.uid),
      ]);

      let currentRevision = 0;
      let currentUpdatedAt: string | null = null;
      let currentDeviceId = '';
      let currentDeviceLabel = '';

      if (currentResp.ok) {
        const rows = (await currentResp.json().catch(() => [])) as {
          revision?: number;
          last_device_id?: string;
          last_device_label?: string;
          updated_at?: string;
        }[];
        if (rows?.[0]) {
          currentRevision = Number(rows[0].revision) || 0;
          currentUpdatedAt = rows[0].updated_at || null;
          currentDeviceId = rows[0].last_device_id || '';
          currentDeviceLabel = rows[0].last_device_label || '';
        }
      }

      res.json({
        maxBackups: MAX_SUPABASE_CLOUD_BACKUPS,
        currentRevision,
        currentUpdatedAt,
        currentDeviceId,
        currentDeviceLabel,
        prunedCount: backupResult.prunedCount,
        backups: backupResult.backups,
      });
    } catch {
      res.status(502).json({ error: 'خطا در دریافت لیست نسخه‌های پشتیبان Supabase.' });
    }
  });

  // Owner-scoped Supabase Cloud Storage Reset (deletes current snapshot, rolling backups, and/or audit logs for the authenticated workspace ONLY)
  app.post('/api/supabase/reset', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }

    if (isReadOnlySupabaseKey(cfg)) {
      res.status(403).json({
        error:
          'کلید فعلی Supabase از نوع عمومی (Publishable/Anon) است و اجازه حذف داده‌ها را ندارد. ابتدا کلید Secret را تنظیم کنید.',
        code: 'INVALID_ANON_KEY',
      });
      return;
    }

    const verified = await resolveSupabaseActor(req);
    if (!verified || !isValidSafeId(verified.uid)) {
      res.status(401).json({
        error: 'برای پاکسازی فضای ابری Supabase ابتدا باید به فضای کاری مستقل خود متصل باشید.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const body = (req.body || {}) as {
      clearWorkspace?: boolean;
      clearBackups?: boolean;
      clearAuditLogs?: boolean;
    };
    const clearWorkspace = body.clearWorkspace !== false;
    const clearBackups = body.clearBackups !== false;
    const clearAuditLogs = body.clearAuditLogs !== false;

    let deletedBackups = 0;
    let deletedWorkspace = false;
    let deletedAuditLogs = false;

    try {
      if (clearBackups) {
        const prefix = `${verified.uid}__bak__`;
        const listUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=like.${encodeURIComponent(prefix + '*')}&select=owner_id&limit=100`;
        const listResp = await fetch(listUrl, {
          method: 'GET',
          headers: buildSupabaseHeaders(cfg),
          signal: AbortSignal.timeout(7000),
        });
        if (listResp.ok) {
          const rows = (await listResp.json().catch(() => [])) as { owner_id?: string }[];
          const ownedIds = rows
            .map((r) => r.owner_id)
            .filter((id): id is string => typeof id === 'string' && id.startsWith(prefix));
          for (const bakId of ownedIds) {
            const delResp = await fetch(
              `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(bakId)}`,
              {
                method: 'DELETE',
                headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
                signal: AbortSignal.timeout(5000),
              }
            );
            if (delResp.ok) deletedBackups += 1;
          }
        }
      }

      if (clearWorkspace) {
        const delWsResp = await fetch(
          `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}`,
          {
            method: 'DELETE',
            headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
            signal: AbortSignal.timeout(7000),
          }
        );
        deletedWorkspace = delWsResp.ok;
      }

      if (clearAuditLogs) {
        const delAudResp = await fetch(
          `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.auditTableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}`,
          {
            method: 'DELETE',
            headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
            signal: AbortSignal.timeout(7000),
          }
        );
        deletedAuditLogs = delAudResp.ok;
      }

      res.json({
        ok: true,
        workspaceId: verified.workspaceId || verified.uid,
        deletedWorkspace,
        deletedBackups,
        deletedAuditLogs,
        resetAt: new Date().toISOString(),
      });
    } catch {
      res.status(502).json({
        error: 'خطا در پاکسازی داده‌های Supabase. لطفاً اتصال شبکه را بررسی کنید.',
        code: 'SUPABASE_RESET_FAILED',
      });
    }
  });

  // Delete a specific owner-scoped Supabase backup version
  app.delete('/api/supabase/backups/:backupId', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }

    const verified = await resolveSupabaseActor(req);
    if (!verified || !isValidSafeId(verified.uid)) {
      res.status(401).json({ error: 'احراز هویت مستقل Supabase الزامی است.' });
      return;
    }

    const backupId = String(req.params.backupId || '').trim();
    const requiredPrefix = `${verified.uid}__bak__`;
    if (!isValidSafeId(backupId) || !backupId.startsWith(requiredPrefix)) {
      res.status(403).json({ error: 'شناسه نسخه پشتیبان معتبر نیست یا متعلق به این حساب نمی‌باشد.' });
      return;
    }

    try {
      const delUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(backupId)}`;
      const delResp = await fetch(delUrl, {
        method: 'DELETE',
        headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
        signal: AbortSignal.timeout(7000),
      });
      if (!delResp.ok) {
        res.status(delResp.status).json({ error: 'خطا در حذف نسخه پشتیبان از Supabase.' });
        return;
      }
      const updated = await listAndPruneSupabaseBackups(cfg, verified.uid);
      res.json({ ok: true, backups: updated.backups });
    } catch {
      res.status(502).json({ error: 'ارتباط با سرور Supabase برقرار نشد.' });
    }
  });

  // Pull latest workspace snapshot (or a specific retained backup via ?backupId=...) from Supabase PostgreSQL
  app.get('/api/supabase/pull', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }

    const verified = await resolveSupabaseActor(req);
    if (!verified || !isValidSafeId(verified.uid)) {
      res.status(401).json({ error: 'برای خواندن از Supabase ابتدا اتصال مستقل Supabase را فعال کنید.' });
      return;
    }

    const requestedBackupId = typeof req.query.backupId === 'string' ? req.query.backupId.trim() : '';
    let targetOwnerKey = verified.uid;
    if (requestedBackupId) {
      const requiredPrefix = `${verified.uid}__bak__`;
      if (!isValidSafeId(requestedBackupId) || !requestedBackupId.startsWith(requiredPrefix)) {
        res.status(403).json({ error: 'دسترسی به این نسخه پشتیبان مجاز نیست.' });
        return;
      }
      targetOwnerKey = requestedBackupId;
    }

    try {
      const url = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(targetOwnerKey)}&limit=1`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) {
        res.status(resp.status).json({ error: 'خطا در بازیابی اطلاعات از Supabase.' });
        return;
      }

      const rows = (await resp.json()) as {
        revision?: number;
        conflict_policy?: string;
        last_device_id?: string;
        last_device_label?: string;
        updated_at?: string;
        snapshot_json?: unknown;
      }[];

      const row = rows?.[0];
      if (!row || !row.snapshot_json) {
        res.json({ found: false, revision: 0 });
        return;
      }

      res.json({
        found: true,
        backupId: requestedBackupId || undefined,
        revision: Number(row.revision) || 1,
        conflictPolicy: row.conflict_policy || 'last_write_wins',
        lastDeviceId: row.last_device_id || '',
        lastDeviceLabel: row.last_device_label || '',
        updatedAt: row.updated_at || new Date().toISOString(),
        snapshotJson:
          typeof row.snapshot_json === 'string'
            ? row.snapshot_json
            : JSON.stringify(row.snapshot_json),
      });
    } catch {
      res.status(502).json({ error: 'ارتباط با سرور Supabase برقرار نشد.' });
    }
  });

  // Sync workspace snapshot to Supabase PostgreSQL + retain strictly last 3 cloud backups with automatic pruning
  app.post('/api/supabase/sync', async (req: Request, res: Response) => {
    const cfg = getValidatedSupabaseConfig();
    if (!cfg) {
      res.status(503).json({ error: 'Supabase در تنظیمات سرور پیکربندی نشده است.', code: 'NOT_CONFIGURED' });
      return;
    }

    const verified = await resolveSupabaseActor(req);
    if (!verified || !isValidSafeId(verified.uid)) {
      res.status(401).json({ error: 'احراز هویت مستقل Supabase برای همگام‌سازی الزامی است.' });
      return;
    }

    const body = req.body as {
      operationId?: unknown;
      deviceId?: unknown;
      deviceLabel?: unknown;
      conflictPolicy?: unknown;
      clientRevision?: unknown;
      clientUpdatedAt?: unknown;
      companyName?: unknown;
      fiscalYear?: unknown;
      voucherCount?: unknown;
      invoiceCount?: unknown;
      productCount?: unknown;
      snapshotJson?: unknown;
    };

    const rawOpId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    const operationId = isValidOperationId(rawOpId) ? rawOpId : '';
    const conflictPolicy: 'last_write_wins' | 'first_write_wins' =
      body.conflictPolicy === 'first_write_wins' ? 'first_write_wins' : 'last_write_wins';
    const deviceId = String(body.deviceId || 'unknown').slice(0, 64);
    const deviceLabel = String(body.deviceLabel || 'دستگاه کاری').slice(0, 80);
    const clientRevision = Math.max(0, Math.floor(Number(body.clientRevision) || 0));
    const clientUpdatedAt =
      typeof body.clientUpdatedAt === 'string' && !Number.isNaN(Date.parse(body.clientUpdatedAt))
        ? body.clientUpdatedAt
        : new Date().toISOString();

    if (typeof body.snapshotJson !== 'string' || body.snapshotJson.length === 0) {
      res.status(400).json({ error: 'محتوای اسنپ‌شات برای همگام‌سازی خالی است.' });
      return;
    }
    if (body.snapshotJson.length > 6_000_000) {
      res.status(413).json({ error: 'حجم داده بیش از حد مجاز است.' });
      return;
    }

    // Fast in-memory idempotent replay guard
    if (operationId) {
      const cacheKey = `${verified.uid}:${operationId}`;
      const cachedOp = recentSyncedOps.get(cacheKey);
      if (cachedOp) {
        const backupState = await listAndPruneSupabaseBackups(cfg, verified.uid);
        res.json({
          status: 'idempotent_replay',
          idempotentReplay: true,
          operationId,
          serverRevision: cachedOp.serverRevision,
          conflictPolicy,
          syncedAt: cachedOp.syncedAt,
          retainedBackups: backupState.backups,
          prunedBackupsCount: 0,
        });
        return;
      }
    }

    let parsedSnapshot: Record<string, unknown>;
    try {
      const rawParsed = JSON.parse(body.snapshotJson, (k, v) =>
        k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v
      );
      if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
        throw new Error('Invalid object');
      }
      parsedSnapshot = rawParsed as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: 'فرمت JSON اسنپ‌شات نامعتبر است.' });
      return;
    }

    try {
      // 1. Read existing server row to evaluate idempotency & concurrent edit conflicts
      const existingUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&limit=1`;
      const existingResp = await fetch(existingUrl, {
        method: 'GET',
        headers: buildSupabaseHeaders(cfg),
        signal: AbortSignal.timeout(8000),
      });

      if (!existingResp.ok) {
        res.status(existingResp.status).json({
          error:
            existingResp.status === 404
              ? 'جدول holoo_apex_workspaces در Supabase ایجاد نشده است (فایل supabase/schema.sql را اجرا کنید).'
              : 'خطا در بررسی نسخه فعلی روی Supabase.',
          code: existingResp.status === 404 ? 'TABLE_MISSING' : 'READ_ERROR',
        });
        return;
      }

      const existingRows = (await existingResp.json()) as {
        revision?: number;
        last_device_id?: string;
        last_device_label?: string;
        updated_at?: string;
        snapshot_json?: Record<string, unknown> | string;
      }[];
      const existing = existingRows?.[0];
      const serverRev = Number(existing?.revision) || 0;

      // Durable idempotent replay check against persisted _syncMeta.lastOperationId
      if (operationId && existing?.snapshot_json) {
        const existingObj =
          typeof existing.snapshot_json === 'string'
            ? (JSON.parse(existing.snapshot_json) as Record<string, unknown>)
            : existing.snapshot_json;
        const lastOp = (existingObj?._syncMeta as { lastOperationId?: string } | undefined)
          ?.lastOperationId;
        if (lastOp && lastOp === operationId) {
          const backupState = await listAndPruneSupabaseBackups(cfg, verified.uid);
          res.json({
            status: 'idempotent_replay',
            idempotentReplay: true,
            operationId,
            serverRevision: serverRev,
            conflictPolicy,
            syncedAt: existing.updated_at || new Date().toISOString(),
            retainedBackups: backupState.backups,
            prunedBackupsCount: 0,
          });
          return;
        }
      }

      const hasRemoteConflict = Boolean(existing) && hasSupabaseRevisionConflict(serverRev, clientRevision);

      const writeAuditLog = async (outcome: string, nextRev: number, details: string) => {
        try {
          await fetch(`${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.auditTableName)}`, {
            method: 'POST',
            headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
            body: JSON.stringify({
              owner_id: verified.uid,
              device_id: deviceId,
              device_label: deviceLabel,
              action: 'workspace_sync',
              conflict_policy: conflictPolicy,
              client_revision: clientRevision,
              server_revision: nextRev,
              outcome,
              details: details.slice(0, 300),
            }),
            signal: AbortSignal.timeout(4000),
          });
        } catch {
          // Non-blocking audit log insert
        }
      };

      // 2. Enforce First-Write-Wins when a conflicting newer remote commit exists
      if (hasRemoteConflict && conflictPolicy === 'first_write_wins') {
        await writeAuditLog(
          'conflict_kept_remote',
          serverRev,
          `First-Write-Wins preserved rev ${serverRev} from ${existing?.last_device_label || 'another device'}`
        );
        const backupState = await listAndPruneSupabaseBackups(cfg, verified.uid);
        res.json({
          status: 'conflict_kept_remote',
          serverRevision: serverRev,
          conflictPolicy,
          remoteDeviceLabel: existing?.last_device_label || 'دستگاه دیگر',
          syncedAt: existing?.updated_at || new Date().toISOString(),
          retainedBackups: backupState.backups,
          prunedBackupsCount: backupState.prunedCount,
          remoteSnapshotJson:
            typeof existing?.snapshot_json === 'string'
              ? existing.snapshot_json
              : JSON.stringify(existing?.snapshot_json),
        });
        return;
      }

      // 3. Upsert or Atomic Compare-And-Swap (CAS) update to prevent concurrent lost updates
      const nextRevision = Math.max(serverRev, clientRevision) + 1;
      const nowIso = new Date().toISOString();
      const snapshotWithSyncMeta = operationId
        ? {
            ...parsedSnapshot,
            _syncMeta: {
              lastOperationId: operationId,
              revision: nextRevision,
              deviceId,
              syncedAt: nowIso,
            },
          }
        : parsedSnapshot;
      const upsertPayload = {
        owner_id: verified.uid,
        owner_email: verified.email.slice(0, 200),
        company_name: String(body.companyName || '').slice(0, 160),
        fiscal_year: String(body.fiscalYear || '1405').slice(0, 16),
        revision: nextRevision,
        conflict_policy: conflictPolicy,
        last_device_id: deviceId,
        last_device_label: deviceLabel,
        voucher_count: Math.max(0, Math.floor(Number(body.voucherCount) || 0)),
        invoice_count: Math.max(0, Math.floor(Number(body.invoiceCount) || 0)),
        product_count: Math.max(0, Math.floor(Number(body.productCount) || 0)),
        snapshot_json: snapshotWithSyncMeta,
        client_updated_at: clientUpdatedAt,
        updated_at: nowIso,
      };

      if (existing && conflictPolicy === 'first_write_wins') {
        // Atomic CAS PATCH: only succeeds if server revision has not changed since our read
        const casUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?owner_id=eq.${encodeURIComponent(verified.uid)}&revision=eq.${serverRev}`;
        const casResp = await fetch(casUrl, {
          method: 'PATCH',
          headers: buildSupabaseHeaders(cfg, {
            Prefer: 'return=representation',
          }),
          body: JSON.stringify(upsertPayload),
          signal: AbortSignal.timeout(10000),
        });

        if (!casResp.ok) {
          const pgCode = await extractSafePostgrestCode(casResp);
          res.status(casResp.status).json({
            error: `خطا در ثبت همزمان نسخه روی Supabase (${pgCode}).`,
            code: pgCode,
          });
          return;
        }

        const updatedRows = (await casResp.json().catch(() => [])) as unknown[];
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
          // Concurrent write won the race — re-fetch authoritative winning row and preserve it
          const latestResp = await fetch(existingUrl, {
            method: 'GET',
            headers: buildSupabaseHeaders(cfg),
            signal: AbortSignal.timeout(6000),
          });
          const latestRows = latestResp.ok
            ? ((await latestResp.json().catch(() => [])) as typeof existingRows)
            : [];
          const winner = latestRows?.[0] || existing;
          const winnerRev = Number(winner?.revision) || serverRev;
          await writeAuditLog(
            'conflict_kept_remote',
            winnerRev,
            `Atomic CAS prevented overwrite of concurrent rev ${winnerRev}`
          );
          const backupState = await listAndPruneSupabaseBackups(cfg, verified.uid);
          res.json({
            status: 'conflict_kept_remote',
            serverRevision: winnerRev,
            conflictPolicy,
            remoteDeviceLabel: winner?.last_device_label || 'دستگاه دیگر',
            syncedAt: winner?.updated_at || nowIso,
            retainedBackups: backupState.backups,
            prunedBackupsCount: backupState.prunedCount,
            remoteSnapshotJson:
              typeof winner?.snapshot_json === 'string'
                ? winner.snapshot_json
                : JSON.stringify(winner?.snapshot_json),
          });
          return;
        }
      } else {
        const upsertUrl = `${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}?on_conflict=owner_id`;
        const upsertResp = await fetch(upsertUrl, {
          method: 'POST',
          headers: buildSupabaseHeaders(cfg, {
            Prefer: 'resolution=merge-duplicates,return=minimal',
          }),
          body: JSON.stringify(upsertPayload),
          signal: AbortSignal.timeout(10000),
        });

        if (!upsertResp.ok) {
          const pgCode = await extractSafePostgrestCode(upsertResp);
          res.status(upsertResp.status).json({
            error: `خطا در ذخیره نسخه روی Supabase (${pgCode}).`,
            code: pgCode,
          });
          return;
        }
      }

      // 4. Rolling 3-Version Cloud Backup Retention: store versioned backup & auto-prune older versions (> 3)
      const backupKey = `${verified.uid}__bak__${Date.now()}_${nextRevision}`;
      let retainedBackups: ReturnType<typeof mapSupabaseBackupMeta>[] = [];
      let prunedBackupsCount = 0;
      try {
        await fetch(`${cfg.baseUrl}/rest/v1/${encodeURIComponent(cfg.tableName)}`, {
          method: 'POST',
          headers: buildSupabaseHeaders(cfg, { Prefer: 'return=minimal' }),
          body: JSON.stringify({
            ...upsertPayload,
            owner_id: backupKey,
            created_at: nowIso,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const pruned = await listAndPruneSupabaseBackups(cfg, verified.uid);
        retainedBackups = pruned.backups;
        prunedBackupsCount = pruned.prunedCount;
      } catch {
        // Non-blocking rolling backup cleanup
      }

      const outcome = hasRemoteConflict ? 'conflict_overwrote_remote' : 'synced';
      if (operationId) {
        recentSyncedOps.set(`${verified.uid}:${operationId}`, {
          serverRevision: nextRevision,
          syncedAt: nowIso,
          status: outcome,
        });
        if (recentSyncedOps.size > 2000) {
          const oldestKey = recentSyncedOps.keys().next().value;
          if (oldestKey) recentSyncedOps.delete(oldestKey);
        }
      }
      await writeAuditLog(
        outcome,
        nextRevision,
        hasRemoteConflict
          ? `Last-Write-Wins resolved conflict over rev ${serverRev} (retained ${retainedBackups.length}/${MAX_SUPABASE_CLOUD_BACKUPS}, pruned ${prunedBackupsCount})`
          : `Synced rev ${nextRevision} from ${deviceLabel} (retained ${retainedBackups.length}/${MAX_SUPABASE_CLOUD_BACKUPS}, pruned ${prunedBackupsCount})`
      );

      res.json({
        status: outcome,
        operationId: operationId || undefined,
        serverRevision: nextRevision,
        conflictPolicy,
        syncedAt: nowIso,
        retainedBackups,
        prunedBackupsCount,
      });
    } catch {
      res.status(502).json({ error: 'ارتباط با سرور Supabase برقرار نشد.' });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    // Prevent Vite 8's @vite/client from opening a failing WebSocket to port 24678
    // behind Cloud Run's single-port proxy while keeping CSS injection & HMR stubs working.
    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay extends HTMLElement {}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (
            filePath.endsWith('sw.js') ||
            filePath.endsWith('registerSW.js') ||
            filePath.endsWith('manifest.webmanifest')
          ) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
          if (filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          }
        },
      })
    );
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Holoo Corporate Apex ERP running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
