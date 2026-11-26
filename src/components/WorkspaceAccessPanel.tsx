import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { User, getIdTokenResult } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

type WorkspaceRole = 'finance_manager' | 'accountant' | 'warehouse_keeper' | 'sales_officer' | 'treasurer' | 'auditor_readonly';
type Member = { uid: string; email: string; role: WorkspaceRole | 'owner'; active: boolean; createdAt?: string };
const ROLE_LABELS: Record<WorkspaceRole, string> = {
  finance_manager: 'مدیر مالی',
  accountant: 'حسابدار',
  warehouse_keeper: 'انباردار',
  sales_officer: 'کارشناس فروش',
  treasurer: 'خزانه‌دار',
  auditor_readonly: 'حسابرس (فقط خواندنی)',
};

export const WorkspaceAccessPanel: React.FC<{ user: User | null }> = ({ user }) => {
  const [status, setStatus] = useState('در حال بررسی هویت و فضای کاری…');
  const [isOwner, setIsOwner] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('accountant');
  const [inviteToken, setInviteToken] = useState('');
  const [issuedToken, setIssuedToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const functions = useMemo(() => user ? getFunctions(user.app, 'us-central1') : null, [user]);
  const call = useCallback(async <T,>(name: string, data?: Record<string, unknown>) => {
    if (!functions) throw new Error('ابتدا وارد حساب Firebase شوید.');
    const callable = httpsCallable<Record<string, unknown>, T>(functions, name);
    return (await callable(data || {})).data;
  }, [functions]);

  const refreshMembers = useCallback(async () => {
    const result = await call<{ members: Member[] }>('listWorkspaceMembers');
    setMembers(result.members || []);
  }, [call]);

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      if (!user) { setStatus('برای مدیریت فضای کاری ابتدا با Firebase وارد شوید.'); return; }
      if (!user.emailVerified) { setStatus('برای فعال‌سازی مدیریت امن کاربران، ابتدا ایمیل حساب Google را تأیید کنید.'); return; }
      try {
        const token = await getIdTokenResult(user, true);
        const workspaceId = token.claims.workspaceId;
        const workspaceRole = token.claims.workspaceRole;
        if (typeof workspaceId === 'string' && workspaceRole !== 'owner') {
          if (alive) setStatus('این حساب عضو یک فضای کاری است. برای دسترسی به اطلاعات مالک، مهاجرت داده و قوانین دسترسی هنوز فعال نشده‌اند.');
          return;
        }
        await call('bootstrapWorkspace');
        await user.getIdToken(true);
        if (!alive) return;
        setIsOwner(true);
        await refreshMembers();
        if (alive) setStatus('فضای کاری فعال است؛ مدیریت عضویت از طریق Firebase Functions انجام می‌شود.');
      } catch (e) {
        if (alive) setStatus(e instanceof Error ? e.message : 'راه‌اندازی فضای کاری ناموفق بود.');
      }
    };
    void initialize();
    return () => { alive = false; };
  }, [user, call, refreshMembers]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : 'عملیات ناموفق بود.'); }
    finally { setBusy(false); }
  };

  const createInvitation = () => run(async () => {
    if (!email.trim()) throw new Error('ایمیل دعوت‌شونده را وارد کنید.');
    const result = await call<{ invitationToken: string; expiresAt: string }>('createWorkspaceInvitation', {
      email: email.trim(), role,
    });
    setIssuedToken(result.invitationToken);
    setEmail('');
  });

  const acceptInvitation = () => run(async () => {
    if (!inviteToken.trim()) throw new Error('توکن دعوت‌نامه را وارد کنید.');
    await call('acceptWorkspaceInvitation', { invitationToken: inviteToken.trim() });
    await user?.getIdToken(true);
    setInviteToken('');
    setStatus('دعوت‌نامه پذیرفته شد. دسترسی به داده‌های workspace تا تکمیل مهاجرت عمداً بسته است.');
  });

  const changeRole = (uid: string, nextRole: WorkspaceRole) => run(async () => {
    await call('setWorkspaceMemberRole', { uid, role: nextRole });
    await refreshMembers();
  });

  const revoke = (uid: string) => run(async () => {
    if (!window.confirm('عضویت این حساب لغو شود؟')) return;
    await call('revokeWorkspaceMember', { uid });
    await refreshMembers();
  });

  return (
    <section className="rounded-xl border border-indigo-200 dark:border-indigo-900 bg-white dark:bg-slate-950 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-sm text-slate-900 dark:text-white">مدیریت اعضای واقعی فضای کاری (Firebase RBAC)</h3>
        <span className="text-[10px] rounded-full px-2 py-1 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">سمت سرور</span>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">{status}</p>
      {!user && <p className="text-xs text-amber-700">ورود Firebase لازم است.</p>}
      {user && !user.emailVerified && <p className="text-xs text-amber-700">ایمیل تأییدنشده اجازه ایجاد یا پذیرش عضویت ندارد.</p>}
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      {isOwner && <>
        <form onSubmit={(e) => { e.preventDefault(); void createInvitation(); }} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ایمیل دعوت‌شونده" dir="ltr" className="min-w-0 rounded-lg border px-3 py-2 text-xs dark:bg-slate-900 dark:border-slate-700" />
          <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className="rounded-lg border px-3 py-2 text-xs dark:bg-slate-900 dark:border-slate-700">
            {Object.entries(ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <button disabled={busy} className="rounded-lg bg-indigo-700 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50">ساخت دعوت‌نامه</button>
        </form>
        {issuedToken && <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
          <p className="text-xs font-semibold">توکن یک‌بارمصرف؛ فقط همین بار نمایش داده می‌شود. آن را از کانال امن برای کاربر ارسال کنید.</p>
          <div className="flex gap-2">
            <code dir="ltr" className="break-all text-xs flex-1 select-all">{issuedToken}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(issuedToken)} className="text-xs underline">کپی</button>
          </div>
          <button type="button" onClick={() => setIssuedToken('')} className="text-xs underline">پنهان کردن توکن</button>
        </div>}
        <div className="space-y-2">
          <div className="text-xs font-semibold">اعضای ثبت‌شده</div>
          {members.map((member) => <div key={member.uid} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 dark:border-slate-800">
            <div className="min-w-0"><div className="text-xs font-medium" dir="ltr">{member.email}</div><div className="text-[10px] text-slate-500" dir="ltr">{member.uid}</div></div>
            {member.role === 'owner' ? <span className="text-xs font-semibold">مالک</span> : <div className="flex gap-2 items-center">
              <select value={member.role} onChange={(e) => void changeRole(member.uid, e.target.value as WorkspaceRole)} disabled={busy || !member.active} className="text-xs rounded border px-2 py-1 dark:bg-slate-900 dark:border-slate-700">
                {Object.entries(ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <button type="button" disabled={busy || !member.active} onClick={() => void revoke(member.uid)} className="text-xs text-rose-600 underline disabled:opacity-40">لغو عضویت</button>
            </div>}
          </div>)}
        </div>
      </>}
      {!isOwner && user && <form onSubmit={(e) => { e.preventDefault(); void acceptInvitation(); }} className="flex flex-col sm:flex-row gap-2">
        <input value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} placeholder="توکن دعوت‌نامه" dir="ltr" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs dark:bg-slate-900 dark:border-slate-700" />
        <button disabled={busy || !user.emailVerified} className="rounded-lg bg-indigo-700 text-white px-3 py-2 text-xs disabled:opacity-50">پذیرش دعوت‌نامه</button>
      </form>}
      <p className="text-[10px] text-slate-500">این بخش جایگزین هویت اپراتور محلی نیست. تا پایان مهاجرت tenant-scoped، Rules فقط مالک فعلی را مجاز می‌دانند و عضو دعوت‌شده به داده‌های حسابداری دسترسی ندارد.</p>
    </section>
  );
};
