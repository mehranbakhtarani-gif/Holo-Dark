import React, { useMemo, useState } from 'react';
import {
  ArrowUpLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Compass,
  Database,
  FolderOpen,
  HelpCircle,
  Keyboard,
  Layers,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import type { ActiveModule } from '../types/accounting';
import type { LocalFirstMeshController } from '../hooks/useLocalFirstMeshSync';
import type { DualCloudSyncController } from '../hooks/useDualCloudSync';
import {
  MODULE_GUIDES,
  OFFLINE_TROUBLESHOOTING_SCENARIOS,
  searchOfflineGuide,
  SYNC_ARCHITECTURE_GUIDES,
  type SyncGuideActionId,
} from '../lib/offlineSmartGuideData';
import { toPersianDigits } from '../lib/format';

type GuideTab = 'smart' | 'menus' | 'sync' | 'faq';

export const OfflineSmartGuideDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  activeModule: ActiveModule;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  localMesh: LocalFirstMeshController;
  dualCloud: DualCloudSyncController;
  onOpenQueueMonitor: () => void;
}> = ({
  open,
  onClose,
  activeModule,
  onNavigate,
  localMesh,
  dualCloud,
  onOpenQueueMonitor,
}) => {
  const [activeTab, setActiveTab] = useState<GuideTab>('smart');
  const [query, setQuery] = useState('');
  const [expandedMenuId, setExpandedMenuId] = useState<string | null>(null);
  const [expandedFaqId, setExpandedFaqId] = useState<string | null>('scen-3-devices');

  const currentModuleGuide = useMemo(
    () =>
      MODULE_GUIDES.find((g) => g.modules.includes(activeModule)) || MODULE_GUIDES[0],
    [activeModule]
  );

  const searchResults = useMemo(() => searchOfflineGuide(query), [query]);
  const hasSearch = query.trim().length > 0;
  const totalSearchHits =
    searchResults.modules.length +
    searchResults.syncMethods.length +
    searchResults.scenarios.length;

  if (!open) return null;

  const runSyncAction = (actionId: SyncGuideActionId) => {
    onClose();
    switch (actionId) {
      case 'open_local_mesh_settings':
        onNavigate('settings', 'local-folder-mesh', 'tool-settings');
        break;
      case 'open_queue_monitor':
        onOpenQueueMonitor();
        break;
      case 'open_audit_p2p_log':
        onNavigate('audit', 'p2p_mesh_log', 'audit-center');
        break;
      case 'open_dual_cloud_settings':
        onNavigate('settings', undefined, 'tool-settings');
        break;
      case 'open_mesh_wizard':
        localMesh.setNeedsInitialSetup(true);
        break;
    }
  };

  const jumpTo = (mod: ActiveModule, intent?: string, subKey?: string) => {
    onClose();
    onNavigate(mod, intent, subKey);
  };

  // Live status map for the 6 sync layers so user sees real device state inside the guide
  const syncLiveStatus: Record<string, { label: string; active: boolean }> = {
    dexie_indexeddb: {
      label: localMesh.storagePersistence.persisted
        ? 'فعال و محافظت‌شده'
        : `فعال (${toPersianDigits(localMesh.dexieRecordCount)} رکورد)`,
      active: true,
    },
    local_folder: {
      label:
        localMesh.localFolderStatus.configured &&
        localMesh.localFolderStatus.permission === 'granted'
          ? `متصل (${localMesh.localFolderStatus.folderName})`
          : localMesh.localFolderStatus.permission === 'prompt'
            ? 'نیازمند تایید مجوز'
            : 'انتخاب نشده',
      active:
        localMesh.localFolderStatus.configured &&
        localMesh.localFolderStatus.permission === 'granted',
    },
    p2p_mesh: {
      label: localMesh.selectedPeerId
        ? `${localMesh.selectedDeviceProfile?.shortLabel || ''} · ${toPersianDigits(localMesh.connectedPeerCount)}/۲ متصل`
        : 'نقش دستگاه تنظیم نشده',
      active: localMesh.meshSelfOnline || localMesh.connectedPeerCount > 0,
    },
    offline_outbox: {
      label:
        localMesh.pendingOutboxCount + dualCloud.pendingQueueCount > 0
          ? `${toPersianDigits(localMesh.pendingOutboxCount + dualCloud.pendingQueueCount)} مورد در صف`
          : 'صف خالی و همگام',
      active: true,
    },
    supabase_cloud: {
      label: dualCloud.isSupabaseAuthenticated
        ? 'متصل (مستقل)'
        : dualCloud.supabaseStatus.configured
          ? 'آماده ورود مستقل'
          : 'غیرفعال',
      active: dualCloud.isSupabaseAuthenticated,
    },
    firebase_cloud: {
      label: dualCloud.firebaseBackups.length > 0 ? 'دارای پشتیبان' : 'اختیاری',
      active: dualCloud.firebaseBackups.length > 0,
    },
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/55 backdrop-blur-xs no-print"
      role="dialog"
      aria-modal="true"
      aria-label="منوی راهنمای هوشمند آفلاین"
    >
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-3xl bg-white dark:bg-slate-950 h-full shadow-2xl border-r border-slate-200 dark:border-slate-800 flex flex-col text-right">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-gradient-to-l from-teal-700/8 via-transparent to-transparent">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-teal-600/12 dark:bg-teal-500/15 border border-teal-500/25 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-teal-700 dark:text-teal-300" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  منوی راهنمای هوشمند آفلاین هلو اپکس ۹.۶
                </h2>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300">
                  <WifiOff className="w-3 h-3" />
                  ۱۰۰٪ بدون اینترنت
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                آموزش گام‌به‌گام تمامی منوها، روش‌های همگام‌سازی (پوشه محلی، P2P سه‌دستگاهی، Supabase و Firebase) و عیب‌یابی فوری
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="بستن راهنما"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Instant Offline Search + Navigation Tabs */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50/70 dark:bg-slate-900/50">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی هوشمند آفلاین (مثلاً: چک صیادی، همگام‌سازی ۳ دستگاه، پوشه محلی، کاردکس، Supabase، صف آفلاین)..."
              className="w-full pr-9 pl-9 py-2 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="پاک کردن جستجو"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {!hasSearch && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'smart', label: 'راهنمای هوشمند و صفحه فعلی', icon: Compass },
                  { id: 'menus', label: 'آموزش همه منوها (۱۱ بخش)', icon: Layers },
                  { id: 'sync', label: 'انواع همگام‌سازی و ذخیره (۶ لایه)', icon: Network },
                  { id: 'faq', label: 'عیب‌یابی و سوالات رایج', icon: HelpCircle },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'bg-teal-700 text-white'
                        : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* LIVE SEARCH RESULTS VIEW */}
          {hasSearch ? (
            <div className="space-y-5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  نتایج جستجوی آفلاین برای «<strong className="text-slate-900 dark:text-white">{query}</strong>»
                </span>
                <span className="font-code">{toPersianDigits(totalSearchHits)} نتیجه یافت شد</span>
              </div>

              {totalSearchHits === 0 && (
                <div className="py-12 text-center space-y-2">
                  <Search className="w-9 h-9 text-slate-300 mx-auto" />
                  <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                    نتیجه‌ای با این عبارت یافت نشد
                  </div>
                  <p className="text-xs text-slate-500">
                    کلمات ساده‌تری مثل «فاکتور»، «چک»، «انبار»، «P2P»، «پوشه» یا «Supabase» را جستجو کنید.
                  </p>
                </div>
              )}

              {searchResults.syncMethods.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold text-teal-700 dark:text-teal-400">
                    روش‌های همگام‌سازی و ذخیره‌سازی ({toPersianDigits(searchResults.syncMethods.length)})
                  </h3>
                  {searchResults.syncMethods.map((s) => (
                    <div
                      key={s.id}
                      className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-bold text-slate-900 dark:text-white">{s.title}</div>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-teal-50 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300">
                          {s.offlineCapable}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-5">{s.bestFor}</p>
                      <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-200 pr-4 list-disc leading-5">
                        {s.howItWorks.map((st, idx) => (
                          <li key={idx}>{st}</li>
                        ))}
                      </ul>
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => runSyncAction(s.actionId)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                        >
                          <span>{s.actionLabel}</span>
                          <ArrowUpLeft className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {searchResults.modules.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold text-teal-700 dark:text-teal-400">
                    منوها و ماژول‌ها ({toPersianDigits(searchResults.modules.length)})
                  </h3>
                  {searchResults.modules.map((m) => (
                    <div
                      key={m.id}
                      className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-bold text-slate-900 dark:text-white">{m.title}</div>
                        <button
                          type="button"
                          onClick={() =>
                            jumpTo(m.primaryTarget.module, m.primaryTarget.intent, m.primaryTarget.subKey)
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-semibold"
                        >
                          <span>باز کردن بخش</span>
                          <ArrowUpLeft className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-5">{m.summary}</p>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {m.quickLinks.map((ql) => (
                          <button
                            key={ql.label}
                            type="button"
                            onClick={() => jumpTo(ql.module, ql.intent, ql.subKey)}
                            className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-700 dark:text-slate-200 hover:border-teal-500"
                          >
                            {ql.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {searchResults.scenarios.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold text-teal-700 dark:text-teal-400">
                    عیب‌یابی و سوالات رایج ({toPersianDigits(searchResults.scenarios.length)})
                  </h3>
                  {searchResults.scenarios.map((sc) => (
                    <div
                      key={sc.id}
                      className="p-4 rounded-xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/60 space-y-2"
                    >
                      <div className="text-xs font-bold text-slate-900 dark:text-white">{sc.question}</div>
                      <p className="text-xs text-slate-700 dark:text-slate-300 leading-5">{sc.answer}</p>
                      {sc.actionId && sc.actionLabel && (
                        <button
                          type="button"
                          onClick={() => runSyncAction(sc.actionId!)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                        >
                          <span>{sc.actionLabel}</span>
                          <ArrowUpLeft className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'smart' ? (
            /* TAB 1: CONTEXT-AWARE CURRENT SCREEN GUIDE + QUICK SYNC SUMMARY */
            <div className="space-y-5">
              {/* Context-Aware Current Module Card */}
              <div className="p-4 rounded-2xl bg-teal-50/75 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800/70 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-teal-700 dark:text-teal-300" />
                    <span className="text-xs font-bold text-teal-900 dark:text-teal-200">
                      راهنمای صفحه فعلی شما: {currentModuleGuide.title}
                    </span>
                  </div>
                  {currentModuleGuide.shortcut && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white dark:bg-slate-900 border border-teal-200 dark:border-teal-800 text-[10px] font-code text-teal-800 dark:text-teal-300">
                      <Keyboard className="w-3 h-3" />
                      {currentModuleGuide.shortcut}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-200 leading-5">
                  {currentModuleGuide.summary}
                </p>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-bold text-slate-800 dark:text-slate-100">
                    نحوه کار گام‌به‌گام در این بخش:
                  </div>
                  <ol className="space-y-1.5 text-xs text-slate-700 dark:text-slate-200 pr-4 list-decimal leading-5">
                    {currentModuleGuide.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                </div>

                <div className="flex flex-wrap gap-1.5 pt-1">
                  {currentModuleGuide.quickLinks.map((ql) => (
                    <button
                      key={ql.label}
                      type="button"
                      onClick={() => jumpTo(ql.module, ql.intent, ql.subKey)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-teal-200 dark:border-teal-800 text-[11px] font-semibold text-teal-800 dark:text-teal-300 hover:bg-teal-100/60"
                    >
                      <span>{ql.label}</span>
                      <ArrowUpLeft className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Live 6-Layer Sync & Storage Overview */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>وضعیت زنده لایه‌های ذخیره و همگام‌سازی روی این دستگاه</span>
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sync')}
                    className="text-[11px] font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                  >
                    آموزش کامل همه ۶ روش ←
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {SYNC_ARCHITECTURE_GUIDES.map((s) => {
                    const live = syncLiveStatus[s.id];
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => runSyncAction(s.actionId)}
                        className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-teal-400 dark:hover:border-teal-600 text-right transition-colors space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                            {s.title}
                          </span>
                          <span
                            className={`shrink-0 px-2 py-0.5 rounded-md text-[10px] font-bold ${
                              live?.active
                                ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                            }`}
                          >
                            {live?.label}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-4">
                          {s.subtitle}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Essential Keyboard Shortcuts Strip */}
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                  <Keyboard className="w-4 h-4 text-indigo-600" />
                  <span>کلیدهای میانبر سریع هلو اپکس ۹.۶</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                  {[
                    { k: 'Alt+G', v: 'راهنمای هوشمند آفلاین' },
                    { k: 'F1', v: 'فهرست میانبرها' },
                    { k: 'F2', v: 'فاکتور فروش جدید' },
                    { k: 'F3', v: 'سند حسابداری جدید' },
                    { k: 'F4', v: 'فاکتور خرید جدید' },
                    { k: 'F5', v: 'طرف‌حساب‌ها' },
                    { k: 'F6', v: 'انبار و کالاها' },
                    { k: 'F7', v: 'چک صیادی و خزانه' },
                    { k: 'Ctrl+K', v: 'جستجو و فرمان سریع' },
                  ].map((sc) => (
                    <div
                      key={sc.k}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
                    >
                      <span className="text-slate-600 dark:text-slate-300 truncate">{sc.v}</span>
                      <kbd className="font-code text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                        {sc.k}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : activeTab === 'menus' ? (
            /* TAB 2: COMPLETE GUIDE TO ALL 11 MENUS */
            <div className="space-y-2.5">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                روی هر منو کلیک کنید تا آموزش گام‌به‌گام، نکات کاربردی و دکمه‌های ورود مستقیم به زیرمنوهای آن نمایش داده شود.
              </p>
              {MODULE_GUIDES.map((m) => {
                const isOpen = expandedMenuId === m.id;
                const isCurrent = m.modules.includes(activeModule);
                return (
                  <div
                    key={m.id}
                    className={`rounded-xl border transition-colors overflow-hidden ${
                      isCurrent
                        ? 'border-teal-400 dark:border-teal-700 bg-teal-50/30 dark:bg-teal-950/20'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedMenuId(isOpen ? null : m.id)}
                      className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-right hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-slate-900 dark:text-white">
                            {m.title}
                          </span>
                          {isCurrent && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-teal-700 text-white">
                              صفحه فعلی
                            </span>
                          )}
                          {m.shortcut && (
                            <span className="font-code text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {m.shortcut}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                          {m.summary}
                        </p>
                      </div>
                      {isOpen ? (
                        <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-3">
                        <div className="space-y-1.5">
                          <div className="text-[11px] font-bold text-teal-800 dark:text-teal-300">
                            گام‌های کار با این بخش:
                          </div>
                          <ol className="space-y-1 text-xs text-slate-700 dark:text-slate-200 pr-4 list-decimal leading-5">
                            {m.steps.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ol>
                        </div>

                        {m.tips.length > 0 && (
                          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 space-y-1">
                            <div className="text-[11px] font-bold text-slate-800 dark:text-slate-200">
                              نکات حرفه‌ای:
                            </div>
                            <ul className="space-y-1 text-[11px] text-slate-600 dark:text-slate-300 pr-4 list-disc leading-5">
                              {m.tips.map((t, idx) => (
                                <li key={idx}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {m.quickLinks.map((ql) => (
                            <button
                              key={ql.label}
                              type="button"
                              onClick={() => jumpTo(ql.module, ql.intent, ql.subKey)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-semibold"
                            >
                              <span>{ql.label}</span>
                              <ArrowUpLeft className="w-3 h-3" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : activeTab === 'sync' ? (
            /* TAB 3: COMPLETE GUIDE TO ALL 6 SYNC & STORAGE METHODS */
            <div className="space-y-4">
              {/* Quick Decision Matrix */}
              <div className="p-4 rounded-xl bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 space-y-2 text-xs">
                <div className="font-bold text-teal-900 dark:text-teal-200 flex items-center gap-1.5">
                  <Layers className="w-4 h-4" />
                  <span>چرا چند روش همگام‌سازی وجود دارد و بهترین ترکیب کدام است؟</span>
                </div>
                <p className="text-slate-700 dark:text-slate-200 leading-5">
                  هر ۶ لایه به‌صورت مکمل و بدون تداخل کنار هم کار می‌کنند: <strong>حافظه داخلی Dexie</strong> همیشه فعال است؛{' '}
                  <strong>پوشه محلی</strong> فایل واقعی روی هارد شما می‌سازد؛ <strong>شبکه ۳ دستگاه P2P</strong> لپ‌تاپ و ۲ موبایل را مستقیم بدون سرور سینک می‌کند؛ و{' '}
                  <strong>Supabase / Firebase</strong> پشتیبان ابری ۳ نسخه‌ای برای بازیابی روی دستگاه جدید فراهم می‌آورند.
                </p>
              </div>

              {SYNC_ARCHITECTURE_GUIDES.map((sync) => {
                const live = syncLiveStatus[sync.id];
                const Icon =
                  sync.id === 'local_folder'
                    ? FolderOpen
                    : sync.id === 'p2p_mesh'
                      ? Network
                      : sync.id === 'supabase_cloud' || sync.id === 'firebase_cloud'
                        ? Cloud
                        : Database;

                return (
                  <div
                    key={sync.id}
                    className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800 flex items-center justify-center shrink-0 mt-0.5">
                          <Icon className="w-4 h-4 text-teal-700 dark:text-teal-300" />
                        </div>
                        <div>
                          <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                            {sync.title}
                          </h3>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {sync.subtitle}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {sync.offlineCapable}
                        </span>
                        {live && (
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                              live.active
                                ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                                : 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300'
                            }`}
                          >
                            وضعیت: {live.label}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-xs text-slate-700 dark:text-slate-200 leading-5">
                      <strong className="text-slate-900 dark:text-white">مناسب برای:</strong>{' '}
                      {sync.bestFor}
                    </div>

                    <ol className="space-y-1 text-xs text-slate-700 dark:text-slate-200 pr-4 list-decimal leading-5">
                      {sync.howItWorks.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        <strong className="text-slate-700 dark:text-slate-200">حل تعارض:</strong>{' '}
                        {sync.conflictPolicy}
                      </div>
                      <button
                        type="button"
                        onClick={() => runSyncAction(sync.actionId)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-semibold shrink-0"
                      >
                        <span>{sync.actionLabel}</span>
                        <ArrowUpLeft className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* TAB 4: OFFLINE TROUBLESHOOTING & FAQ */
            <div className="space-y-2.5">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                پاسخ سریع و راه‌حل عملی برای رایج‌ترین سناریوهای کار آفلاین، پوشه محلی و همگام‌سازی بین دستگاه‌ها:
              </p>
              {OFFLINE_TROUBLESHOOTING_SCENARIOS.map((sc) => {
                const isOpen = expandedFaqId === sc.id;
                return (
                  <div
                    key={sc.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedFaqId(isOpen ? null : sc.id)}
                      className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-right hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-teal-50 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300">
                          {sc.badge}
                        </span>
                        <span className="text-xs font-bold text-slate-900 dark:text-white">
                          {sc.question}
                        </span>
                      </div>
                      {isOpen ? (
                        <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                        <p className="text-xs text-slate-700 dark:text-slate-200 leading-5">
                          {sc.answer}
                        </p>
                        <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 pr-4 list-disc leading-5">
                          {sc.steps.map((s, idx) => (
                            <li key={idx}>{s}</li>
                          ))}
                        </ul>
                        {sc.actionId && sc.actionLabel && (
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={() => runSyncAction(sc.actionId!)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-semibold"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>{sc.actionLabel}</span>
                              <ArrowUpLeft className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
