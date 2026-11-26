const GENERIC_RUNTIME_ERROR = 'خطای غیرمنتظره رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.';

/** Prevent credentials and oversized backend payloads from reaching the UI. */
export function getSafeRuntimeErrorMessage(
  error: unknown,
  isProduction: boolean = import.meta.env?.PROD === true,
): string {
  if (isProduction) return GENERIC_RUNTIME_ERROR;

  const raw = error instanceof Error ? error.message : String(error ?? '');
  const sanitized = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .slice(0, 500);

  return sanitized || GENERIC_RUNTIME_ERROR;
}
