import React, { useMemo, useState } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth } from '../lib/firebase';

type MigrationStatus = 'idle' | 'copying' | 'verifying' | 'verified';
type StepResult = { status: MigrationStatus; copied?: number; verified?: number; collection?: string | null };

export const WorkspaceMigrationPanel: React.FC = () => {
  const functions = useMemo(() => getFunctions(auth.app, 'us-central1'), []);
  const [status, setStatus] = useState<MigrationStatus>('idle');
  const [collection, setCollection] = useState('');
  const [lastCount, setLastCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const invoke = async <T,>(name: string) => {
    const callable = httpsCallable<Record<string, never>, T>(functions, name);
    return (await callable({})).data;
  };

  const begin = async () => {
    setBusy(true); setError('');
    try {
      const result = await invoke<{ status: MigrationStatus }>('beginWorkspaceDataMigration');
      setStatus(result.status);
      setLastCount(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'شروع آماده‌سازی مهاجرت ناموفق بود.');
    } finally { setBusy(false); }
  };

  const advance = async () => {
    setBusy(true); setError('');
    try {
      const result = status === 'copying'
        ? await invoke<StepResult>('migrateWorkspaceDataBatch')
        : await invoke<StepResult>('verifyWorkspaceDataMigration');
      setStatus(result.status);
      setCollection(result.collection || '');
      setLastCount(result.copied ?? result.verified ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'مرحله مهاجرت ناموفق بود.');
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-lg border border-amber-300 dark:border-amber-900 p-3 space-y-2">
      <div className="text-xs font-semibold">آماده‌سازی مهاجرت داده به Workspace</div>
      <p className="text-[11px] text-slate-600 dark:text-slate-400">
        این فرایند فقط نسخه staging از داده‌های مالک را در فضای جداگانه می‌سازد و SHA-256 آن‌ها را با مبدأ تطبیق می‌دهد. داده‌های قدیمی حذف یا تغییر نمی‌کنند؛ مسیر اصلی برنامه و Firestore Rules نیز تغییر نمی‌کنند.
      </p>
      <div className="text-[11px]">وضعیت: <strong>{status === 'idle' ? 'شروع‌نشده' : status === 'copying' ? 'کپی مرحله‌ای' : status === 'verifying' ? 'بررسی یکپارچگی' : 'تطبیق کامل'}</strong></div>
      {collection && <div className="text-[10px] text-slate-500" dir="ltr">{collection} · {lastCount} رکورد در آخرین صفحه</div>}
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      {status === 'idle'
        ? <button type="button" disabled={busy} onClick={() => void begin()} className="rounded bg-amber-700 text-white px-3 py-2 text-xs disabled:opacity-50">شروع کپی staging (بدون تغییر داده اصلی)</button>
        : status !== 'verified'
          ? <button type="button" disabled={busy} onClick={() => void advance()} className="rounded bg-indigo-700 text-white px-3 py-2 text-xs disabled:opacity-50">{busy ? 'در حال اجرا…' : status === 'copying' ? 'کپی صفحه بعدی' : 'بررسی صفحه بعدی'}</button>
          : <p className="text-xs text-emerald-700 dark:text-emerald-400">نسخه staging با مبدأ تطبیق داده شد. هنوز cutover یا دسترسی اعضا فعال نشده است.</p>}
    </section>
  );
};
