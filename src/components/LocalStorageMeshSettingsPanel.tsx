import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FolderOpen,
  FolderSync,
  HardDrive,
  KeyRound,
  Laptop,
  Network,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Unlink,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import { PeerMeshSyncButton } from './PeerMeshSyncButton';
import { LIVE_DB_FILENAME, MESH_DEVICES } from '../lib/localFolderDexieDb';
import { formatShamsiFromIso } from '../lib/dualCloudSync';
import { toPersianDigits } from '../lib/format';

export const LocalStorageMeshSettingsPanel: React.FC<{
  localMesh: LocalFirstMeshController;
  dualCloud?: DualCloudSyncController;
  highlighted?: boolean;
  onOpenQueueMonitor?: () => void;
}> = ({ localMesh, dualCloud, highlighted = false, onOpenQueueMonitor }) => {
  const [passphraseDraft, setPassphraseDraft] = useState(localMesh.meshPassphrase);
  const { localFolderStatus, storagePersistence } = localMesh;
  const totalPending = localMesh.pendingOutboxCount + (dualCloud?.pendingQueueCount || 0);

  return (
    <div
      className={`bg-white dark:bg-slate-900 border rounded-xl p-5 space-y-6 transition-all ${
        highlighted
          ? 'border-teal-500 ring-2 ring-teal-500/20'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* Top Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-teal-600/12 dark:bg-teal-500/15 border border-teal-500/25 flex items-center justify-center shrink-0">
            <FolderSync className="w-5 h-5 text-teal-700 dark:text-teal-300" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              تنظیمات مسیر ذخیره‌سازی محلی و همگام‌سازی خودکار P2P بین ۳ دستگاه
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-5">
              ذخیره‌سازی دائمی روی دستگاه (Dexie IndexedDB + پوشه انتخابی کاربر) به همراه همگام‌سازی مستقیم WebRTC / PeerJS با رله سه‌دستگاهی و ادغام قطعی LWW.
            </p>
          </div>
        </div>

        {onOpenQueueMonitor && (
          <button
            type="button"
            onClick={onOpenQueueMonitor}
            className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/60 text-xs font-semibold"
          >
            <Database className="w-4 h-4" />
            <span>مانیتور صف آفلاین</span>
            {totalPending > 0 && (
              <span className="px-1.5 py-0.5 rounded-md bg-amber-500 text-white font-code text-[10px]">
                {toPersianDigits(totalPending)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* SECTION A: User-Selectable Local Storage Directory (File System Access API + Smart Fallback) */}
      <div className="p-4 rounded-xl bg-slate-50/90 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-teal-600 dark:text-teal-400" />
            <span className="text-xs font-bold text-slate-900 dark:text-white">
              ۱. مسیر ذخیره‌سازی محلی (File System Access API + حالت جایگزین موبایل)
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span
              className={`px-2.5 py-0.5 rounded-md font-semibold border ${
                storagePersistence.persisted
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                  : 'bg-sky-50 dark:bg-sky-950/50 border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300'
              }`}
            >
              حافظه داخلی Dexie: {storagePersistence.persisted ? 'دائمی و محافظت‌شده' : 'فعال'} (
              {toPersianDigits(localMesh.dexieRecordCount)} رکورد)
            </span>
            {localFolderStatus.configured ? (
              <span
                className={`px-2.5 py-0.5 rounded-md font-semibold border ${
                  localFolderStatus.permission === 'granted'
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                }`}
              >
                پوشه: {localFolderStatus.folderName}{' '}
                {localFolderStatus.permission === 'granted' ? '✅ فعال' : '⚠️ نیازمند تایید مجوز'}
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-md font-semibold border bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">
                پوشه انتخاب نشده
              </span>
            )}
          </div>
        </div>

        {/* Folder metadata strip */}
        {localFolderStatus.configured && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-[11px]">
            <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-400">فایل زنده آینه‌ای</div>
              <div className="font-code font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                {localFolderStatus.folderName}/{LIVE_DB_FILENAME}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-400">آخرین ذخیره خودکار</div>
              <div className="font-code font-semibold text-slate-800 dark:text-slate-100 mt-0.5">
                {localFolderStatus.lastMirroredAt
                  ? formatShamsiFromIso(localFolderStatus.lastMirroredAt)
                  : 'هنوز نوشته نشده'}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-400">آخرین اسنپ‌شات روزانه (حداکثر ۱۴ روز)</div>
              <div className="font-code font-semibold text-slate-800 dark:text-slate-100 mt-0.5 truncate">
                {localFolderStatus.lastDailySnapshotFile || 'خودکار هنگام اولین ثبت'}
              </div>
            </div>
          </div>
        )}

        {localFolderStatus.lastError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{localFolderStatus.lastError}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void localMesh.selectLocalFolder()}
            disabled={localMesh.isFolderBusy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            <span>
              {localFolderStatus.configured
                ? 'تغییر پوشه ذخیره‌سازی محلی'
                : 'انتخاب پوشه ذخیره‌سازی محلی'}
            </span>
          </button>

          {localFolderStatus.configured && localFolderStatus.permission === 'prompt' && (
            <button
              type="button"
              onClick={() => void localMesh.regrantFolderPermission()}
              disabled={localMesh.isFolderBusy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>تایید مجدد مجوز پوشه (۱ کلیک)</span>
            </button>
          )}

          {localFolderStatus.configured && (
            <button
              type="button"
              onClick={() => void localMesh.mirrorNowToFolder()}
              disabled={localMesh.isFolderBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold disabled:opacity-50"
            >
              <HardDrive className="w-3.5 h-3.5 text-teal-600" />
              <span>نوشتن فوری holoo_live_db.json</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void localMesh.restoreFromSelectedFolder()}
            disabled={localMesh.isFolderBusy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-xs font-semibold disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>بازیابی از پوشه انتخابی (LWW)</span>
          </button>

          <button
            type="button"
            onClick={() => void localMesh.saveFallbackToDownloads()}
            disabled={localMesh.isFolderBusy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-indigo-600" />
            <span>ذخیره در پوشه دانلودها (جایگزین موبایل)</span>
          </button>

          {localFolderStatus.configured && (
            <button
              type="button"
              onClick={() => void localMesh.disconnectLocalFolder()}
              className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
            >
              <Unlink className="w-3.5 h-3.5" />
              <span>قطع اتصال پوشه</span>
            </button>
          )}
        </div>
      </div>

      {/* SECTION B: 3-Device Automatic PeerJS Mesh */}
      <div className="p-4 rounded-xl bg-slate-50/90 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-teal-600 dark:text-teal-400" />
            <span className="text-xs font-bold text-slate-900 dark:text-white">
              ۲. همگام‌سازی خودکار «در لحظه باز شدن» بین ۳ دستگاه (PeerJS Mesh + Relay)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-semibold border ${
                localMesh.meshSelfOnline
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              {localMesh.meshSelfOnline ? (
                <Wifi className="w-3.5 h-3.5" />
              ) : (
                <WifiOff className="w-3.5 h-3.5" />
              )}
              <span>
                {localMesh.meshSelfOnline
                  ? `گره آنلاین (${toPersianDigits(localMesh.connectedPeerCount)} از ۲ همتا متصل)`
                  : localMesh.selectedPeerId
                    ? 'در انتظار اتصال سیگنالینگ P2P'
                    : 'نقش دستگاه انتخاب نشده'}
              </span>
            </span>
            <PeerMeshSyncButton
              variant="action"
              isMeshActive={localMesh.meshSelfOnline || localMesh.connectedPeerCount > 0}
              isSyncing={localMesh.isP2PSyncing}
              label="همگام‌سازی فوری P2P"
              onClick={() => void localMesh.triggerP2PSyncNow()}
            />
          </div>
        </div>

        {/* Device Role Selector (3 Fixed Peer IDs) */}
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            انتخاب شناسه ثابت این دستگاه (هر دستگاه یک شناسه منحصربه‌فرد انتخاب کند):
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {MESH_DEVICES.map((dev) => {
              const isMine = localMesh.selectedPeerId === dev.peerId;
              const runtimePeer = localMesh.peerStates.find((p) => p.peerId === dev.peerId);
              return (
                <button
                  key={dev.peerId}
                  type="button"
                  onClick={() => localMesh.selectDevicePeerRole(dev.peerId)}
                  className={`p-3 rounded-xl border text-right transition-all ${
                    isMine
                      ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/50 ring-2 ring-teal-500/20'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-teal-400'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {dev.deviceType === 'laptop' ? (
                        <Laptop className="w-4 h-4 text-teal-700 dark:text-teal-300" />
                      ) : (
                        <Smartphone className="w-4 h-4 text-teal-700 dark:text-teal-300" />
                      )}
                      <span className="text-xs font-bold text-slate-900 dark:text-white">
                        {dev.shortLabel}
                      </span>
                    </div>
                    {isMine ? (
                      <span className="px-2 py-0.5 rounded-md bg-teal-700 text-white text-[10px] font-bold">
                        دستگاه فعلی
                      </span>
                    ) : (
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                          runtimePeer?.status === 'connected'
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                            : runtimePeer?.status === 'connecting'
                              ? 'bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300'
                              : runtimePeer?.status === 'error'
                                ? 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                        }`}
                      >
                        {runtimePeer?.status === 'connected'
                          ? 'متصل'
                          : runtimePeer?.status === 'connecting'
                            ? 'در حال اتصال'
                            : runtimePeer?.status === 'error'
                              ? 'خطای کلید'
                              : 'آفلاین'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 text-[10px] font-code text-slate-500 truncate">
                    {dev.peerId}
                  </div>
                  {!isMine && runtimePeer?.lastSyncedAt && (
                    <div className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>آخرین همگام‌سازی: {formatShamsiFromIso(runtimePeer.lastSyncedAt)}</span>
                    </div>
                  )}
                  {!isMine && runtimePeer?.lastError && (
                    <div className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">
                      {runtimePeer.lastError}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Shared Mesh Passphrase */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="flex-1 space-y-1">
            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-teal-600" />
              <span>کلید امنیتی مشترک شبکه خصوصی ۳ دستگاه (Auth Passphrase)</span>
            </label>
            <input
              type="text"
              value={passphraseDraft}
              onChange={(e) => setPassphraseDraft(e.target.value)}
              dir="ltr"
              className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-code text-slate-900 dark:text-white"
            />
          </div>
          <button
            type="button"
            onClick={() => localMesh.updateMeshPassphrase(passphraseDraft)}
            className="px-3.5 py-2 rounded-lg border border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 hover:bg-teal-100 text-xs font-semibold whitespace-nowrap"
          >
            ذخیره کلید شبکه
          </button>
        </div>

        {localMesh.meshSelfError && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{localMesh.meshSelfError}</span>
          </div>
        )}
      </div>
    </div>
  );
};
