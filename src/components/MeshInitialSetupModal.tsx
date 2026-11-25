import React, { useState } from 'react';
import {
  CheckCircle2,
  FolderOpen,
  HardDrive,
  KeyRound,
  Laptop,
  Network,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import { MESH_DEVICES, type MeshDevicePeerId } from '../lib/localFolderDexieDb';

export const MeshInitialSetupModal: React.FC<{
  localMesh: LocalFirstMeshController;
}> = ({ localMesh }) => {
  const [chosenPeer, setChosenPeer] = useState<MeshDevicePeerId>(
    localMesh.selectedPeerId || 'holoo-mesh-mehran-laptop'
  );
  const [passphraseInput, setPassphraseInput] = useState(localMesh.meshPassphrase);

  if (!localMesh.needsInitialSetup) return null;

  const handleConfirm = async (pickFolderAfter: boolean) => {
    if (passphraseInput.trim().length >= 4 && passphraseInput.trim() !== localMesh.meshPassphrase) {
      localMesh.updateMeshPassphrase(passphraseInput.trim());
    }
    localMesh.selectDevicePeerRole(chosenPeer);
    if (pickFolderAfter) {
      await localMesh.selectLocalFolder();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/65 backdrop-blur-xs no-print"
      role="dialog"
      aria-modal="true"
      aria-label="راه‌اندازی اولیه ذخیره‌سازی محلی و همگام‌سازی ۳ دستگاه"
    >
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-right">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-l from-teal-700 to-emerald-700 text-white flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Network className="w-5 h-5 shrink-0" />
            <div>
              <h2 className="text-sm font-bold">
                راه‌اندازی سریع همگام‌سازی ۳ دستگاه و پوشه محلی
              </h2>
              <p className="text-[11px] text-teal-100 mt-0.5">
                فقط یک‌بار نقش این دستگاه را انتخاب کنید تا همگام‌سازی خودکار PeerJS و ذخیره محلی فعال شود.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => localMesh.dismissInitialSetup()}
            className="p-1.5 rounded-lg hover:bg-white/15 text-white"
            aria-label="بستن"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Step 1: Pick Device Role */}
          <div className="space-y-2.5">
            <label className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <span>۱. این دستگاه کدام‌یک از ۳ ایستگاه شماست؟</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {MESH_DEVICES.map((dev) => {
                const selected = chosenPeer === dev.peerId;
                return (
                  <button
                    key={dev.peerId}
                    type="button"
                    onClick={() => setChosenPeer(dev.peerId)}
                    className={`p-3.5 rounded-xl border text-right transition-all ${
                      selected
                        ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/50 ring-2 ring-teal-500/20'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 hover:border-teal-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      {dev.deviceType === 'laptop' ? (
                        <Laptop
                          className={`w-5 h-5 ${selected ? 'text-teal-700 dark:text-teal-300' : 'text-slate-500'}`}
                        />
                      ) : (
                        <Smartphone
                          className={`w-5 h-5 ${selected ? 'text-teal-700 dark:text-teal-300' : 'text-slate-500'}`}
                        />
                      )}
                      {selected && <CheckCircle2 className="w-4 h-4 text-teal-600" />}
                    </div>
                    <div className="mt-2.5 text-xs font-bold text-slate-900 dark:text-white">
                      {dev.shortLabel}
                    </div>
                    <div className="mt-0.5 text-[10px] font-code text-slate-500 truncate">
                      {dev.peerId}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Step 2: Shared Private Passphrase */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-teal-600" />
              <span>۲. کلید امنیتی مشترک شبکه ۳ دستگاه (باید در هر ۳ دستگاه یکسان باشد)</span>
            </label>
            <input
              type="text"
              value={passphraseInput}
              onChange={(e) => setPassphraseInput(e.target.value)}
              dir="ltr"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-code text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              placeholder="holoo-apex-private-mesh"
            />
          </div>

          {/* Step 3: Local Folder Explanation */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 space-y-1.5 leading-5">
            <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>ذخیره‌سازی دوگانه دائمی (حافظه داخلی IndexedDB + پوشه انتخابی کاربر)</span>
            </div>
            <p>
              تمامی اسناد و فاکتورها به‌صورت دائمی روی این دستگاه ذخیره می‌شوند. با انتخاب یک پوشه محلی (مانند{' '}
              <span className="font-code font-semibold">Holoo_Data</span>)، فایل زنده{' '}
              <span className="font-code font-semibold">holoo_live_db.json</span> و بکاپ‌های روزانه نیز لحظه‌ای در همان پوشه آینه می‌شوند.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => void handleConfirm(false)}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <HardDrive className="w-4 h-4 text-teal-600" />
              <span>ادامه با حافظه داخلی دائمی IndexedDB</span>
            </button>
            {localMesh.localFolderStatus.supported && (
              <button
                type="button"
                onClick={() => void handleConfirm(true)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-xs font-bold text-white shadow-sm"
              >
                <FolderOpen className="w-4 h-4" />
                <span>تایید دستگاه و انتخاب پوشه محلی</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
