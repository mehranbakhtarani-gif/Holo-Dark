import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Info,
  Network,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import { PeerMeshSyncButton } from './PeerMeshSyncButton';
import {
  listMeshSyncEventLogs,
  MESH_DEVICES,
  type MeshSyncEventLog,
  type MeshSyncEventType,
} from '../lib/localFolderDexieDb';
import { formatShamsiFromIso } from '../lib/dualCloudSync';
import { toPersianDigits } from '../lib/format';

type StatusFilter = 'all' | 'success' | 'failed' | 'info';

function eventTypeLabel(t: MeshSyncEventType): string {
  switch (t) {
    case 'vector_hello':
      return 'تبادل بردار نسخه';
    case 'state_pull':
      return 'دریافت و ادغام LWW';
    case 'state_push':
      return 'ارسال بسته وضعیت';
    case 'relay_forwarded':
      return 'ارسال رله سه‌دستگاهی';
    case 'ack_received':
      return 'تایید تحویل (ACK)';
    case 'auth_rejected':
      return 'رد احراز هویت شبکه';
    case 'peer_error':
      return 'خطای اتصال همتا';
    case 'connection_open':
      return 'برقراری اتصال P2P';
    case 'connection_close':
      return 'قطع اتصال P2P';
    default:
      return t;
  }
}

function formatVectorClock(clock?: Record<string, number>): string {
  if (!clock || Object.keys(clock).length === 0) return '—';
  return Object.entries(clock)
    .map(([k, v]) => {
      const short = MESH_DEVICES.find((d) => d.peerId === k)?.shortLabel || k.replace('holoo-mesh-mehran-', '');
      return `${short}: ${toPersianDigits(v)}`;
    })
    .join(' | ');
}

export const PeerMeshSyncAuditTab: React.FC<{
  localMesh?: LocalFirstMeshController;
  onOpenQueueMonitor?: () => void;
}> = ({ localMesh, onOpenQueueMonitor }) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [peerFilter, setPeerFilter] = useState<string>('all');
  const [fallbackLogs, setFallbackLogs] = useState<MeshSyncEventLog[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const logs = localMesh ? localMesh.syncEventLogs : fallbackLogs;

  useEffect(() => {
    if (!localMesh) {
      void listMeshSyncEventLogs(200).then(setFallbackLogs);
    }
  }, [localMesh]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      if (localMesh) {
        await localMesh.refreshOutboxAndLogs();
      } else {
        setFallbackLogs(await listMeshSyncEventLogs(200));
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const stats = useMemo(() => {
    const total = logs.length;
    const succeeded = logs.filter((l) => l.status === 'success').length;
    const failed = logs.filter((l) => l.status === 'failed').length;
    const vectorExchanges = logs.filter(
      (l) => l.eventType === 'vector_hello' || l.eventType === 'state_pull'
    ).length;
    return { total, succeeded, failed, vectorExchanges };
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (statusFilter !== 'all' && l.status !== statusFilter) return false;
      if (peerFilter !== 'all' && l.peerId !== peerFilter) return false;
      return true;
    });
  }, [logs, statusFilter, peerFilter]);

  return (
    <div className="space-y-5">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>کل رویدادهای PeerJS Mesh</span>
            <Network className="w-4 h-4 text-teal-600" />
          </div>
          <div className="mt-2 text-2xl font-bold font-code tabular-nums text-slate-900 dark:text-white">
            {toPersianDigits(stats.total)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {toPersianDigits(stats.vectorExchanges)} تبادل بردار نسخه و ادغام
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>همگام‌سازی‌های موفق</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-bold font-code tabular-nums text-emerald-700 dark:text-emerald-400">
            {toPersianDigits(stats.succeeded)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">تاییدشده با بردار نسخه و ACK</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>رویدادهای ناموفق / خطا</span>
            <XCircle className="w-4 h-4 text-rose-600" />
          </div>
          <div className="mt-2 text-2xl font-bold font-code tabular-nums text-rose-700 dark:text-rose-400">
            {toPersianDigits(stats.failed)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">آفلاین بودن همتا یا خطای کلید</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>همتاهای متصل اکنون</span>
            <ShieldAlert className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="mt-2 text-2xl font-bold font-code tabular-nums text-slate-900 dark:text-white">
            {toPersianDigits(localMesh?.connectedPeerCount ?? 0)} از ۲
          </div>
          <div className="mt-1 text-[11px] text-slate-500 truncate">
            {localMesh?.selectedDeviceProfile
              ? `دستگاه فعلی: ${localMesh.selectedDeviceProfile.shortLabel}`
              : 'نقش دستگاه هنوز انتخاب نشده'}
          </div>
        </div>
      </div>

      {/* Controls & Filters */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(
              [
                { id: 'all', label: 'همه رویدادها' },
                { id: 'success', label: 'موفق' },
                { id: 'failed', label: 'ناموفق / خطا' },
                { id: 'info', label: 'اطلاع‌رسانی' },
              ] as { id: StatusFilter; label: string }[]
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  statusFilter === f.id
                    ? 'bg-teal-700 text-white'
                    : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <select
            value={peerFilter}
            onChange={(e) => setPeerFilter(e.target.value)}
            aria-label="فیلتر بر اساس دستگاه"
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200"
          >
            <option value="all">همه دستگاه‌ها</option>
            {MESH_DEVICES.map((d) => (
              <option key={d.peerId} value={d.peerId}>
                {d.shortLabel} ({d.peerId})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {localMesh && (
            <PeerMeshSyncButton
              variant="action"
              isMeshActive={localMesh.meshSelfOnline || localMesh.connectedPeerCount > 0}
              isSyncing={localMesh.isP2PSyncing}
              label="تبادل فوری بردار نسخه"
              onClick={() => void localMesh.triggerP2PSyncNow()}
            />
          )}
          {onOpenQueueMonitor && (
            <button
              type="button"
              onClick={onOpenQueueMonitor}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 text-xs font-semibold"
            >
              <span>مانیتور صف sync_outbox</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 text-xs font-medium"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>بروزرسانی</span>
          </button>
          {localMesh && logs.length > 0 && (
            <button
              type="button"
              onClick={() => void localMesh.clearSyncEventLogs()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-xs font-medium"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>پاکسازی لاگ</span>
            </button>
          )}
        </div>
      </div>

      {/* Readable Event Log Feed */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            گزارش خوانای رویدادهای تبادل بردار نسخه و همگام‌سازی PeerJS Mesh
          </h3>
          <span className="text-[11px] font-code text-slate-500">
            {toPersianDigits(filteredLogs.length)} رویداد ثبت‌شده در Dexie
          </span>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <Network className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto" />
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              هنوز رویداد همگام‌سازی P2P در این فیلتر ثبت نشده است
            </div>
            <p className="text-xs text-slate-500 max-w-md mx-auto leading-5">
              پس از انتخاب نقش دستگاه در بخش تنظیمات (لپ‌تاپ مهران / موبایل من / موبایل همکار)، هر اتصال، تبادل بردار نسخه، ادغام LWW یا خطای دسترسی همتا به‌صورت خودکار اینجا ثبت و نگهداری می‌شود.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {filteredLogs.map((evt) => {
              const isSuccess = evt.status === 'success';
              const isFailed = evt.status === 'failed';
              return (
                <div
                  key={evt.eventId}
                  className="p-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {isSuccess ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                          <CheckCircle2 className="w-3 h-3" />
                          موفق
                        </span>
                      ) : isFailed ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                          <XCircle className="w-3 h-3" />
                          ناموفق
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                          <Info className="w-3 h-3" />
                          اطلاعات
                        </span>
                      )}

                      <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300">
                        {eventTypeLabel(evt.eventType)}
                      </span>

                      <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-800 dark:text-slate-100">
                        {evt.direction === 'inbound' ? (
                          <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                        ) : evt.direction === 'outbound' ? (
                          <ArrowUpRight className="w-3.5 h-3.5 text-sky-600" />
                        ) : null}
                        <span>{evt.peerLabel}</span>
                      </span>

                      <span className="text-[10px] font-code text-slate-400">{evt.peerId}</span>
                    </div>

                    <div className="inline-flex items-center gap-1 text-[11px] font-code text-slate-500">
                      <Clock className="w-3 h-3" />
                      <span>{formatShamsiFromIso(evt.timestamp)}</span>
                    </div>
                  </div>

                  <p className="text-xs text-slate-700 dark:text-slate-200 leading-5">
                    {evt.summary}
                  </p>

                  {/* Vector Clock & Merge Details */}
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="font-code">
                      بردار نسخه محلی: <strong className="text-slate-700 dark:text-slate-200">{formatVectorClock(evt.localVectorClock)}</strong>
                    </span>
                    {evt.remoteVectorClock && Object.keys(evt.remoteVectorClock).length > 0 && (
                      <span className="font-code">
                        بردار نسخه همتا: <strong className="text-teal-700 dark:text-teal-300">{formatVectorClock(evt.remoteVectorClock)}</strong>
                      </span>
                    )}
                    {typeof evt.recordsMerged === 'number' && evt.recordsMerged > 0 && (
                      <span className="px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold">
                        {toPersianDigits(evt.recordsMerged)} رکورد ادغام‌شده
                      </span>
                    )}
                    {typeof evt.conflictsResolved === 'number' && evt.conflictsResolved > 0 && (
                      <span className="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold">
                        {toPersianDigits(evt.conflictsResolved)} تعارض LWW حل‌شده
                      </span>
                    )}
                  </div>

                  {evt.errorDetail && (
                    <div className="flex items-center gap-1.5 text-[11px] font-code text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-2.5 py-1">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span dir="ltr">{evt.errorDetail}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
