import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccounting } from '../context/AccountingContext';
import { useWorkspaceExtensions } from '../context/WorkspaceExtensionsContext';
import type { TrackedWarehouseTransfer } from '../lib/multiWarehouseEngine';
import { useOnlineStatus } from './usePWAInstall';
import {
  appendMeshSyncEventLog,
  clearAllDexieOutboxItems,
  clearMeshSyncEventLogs,
  clearStoredDirectoryHandle,
  clearSyncedDexieOutboxItems,
  enqueueDexieOutboxItem,
  isDirectoryPickerSupported,
  listDexieOutboxItems,
  listMeshSyncEventLogs,
  loadStoredDirectoryHandle,
  markDexieOutboxPeerDelivered,
  mergeWorkspacesDeterministicLWW,
  MESH_DEVICES,
  persistTaggedSnapshotToDexie,
  pickLocalStorageDirectory,
  queryDirectoryPermission,
  readMirrorFromSelectedFolder,
  requestDirectoryPermission,
  requestPersistentDeviceStorage,
  safeParseJsonObject,
  saveSnapshotFallbackToDownloads,
  tagSnapshotWithSyncMetadata,
  updateDexieOutboxItem,
  writeMirrorToSelectedFolder,
  type LocalFolderStatus,
  type MeshDevicePeerId,
  type MeshSyncEventLog,
  type MeshSyncOutboxItem,
  type StoragePersistenceInfo,
} from '../lib/localFolderDexieDb';
import {
  buildRelayEnvelopesFromOutbox,
  getOtherMeshPeerIds,
  loadMeshPassphrase,
  loadSelectedMeshPeerId,
  loadVectorClock,
  PeerMeshConnector,
  saveMeshPassphrase,
  saveSelectedMeshPeerId,
  saveVectorClock,
  type MeshPeerRuntimeState,
} from '../lib/p2pMeshSync';
import { playErrorTone, playSuccessChime, playWarningTone } from '../lib/audioFeedback';
import { toPersianDigits } from '../lib/format';
import {
  analyzeAccountingSnapshotConflict,
  loadSyncConflictDefaultMode,
  resolveConflictDecision,
  saveSyncConflictDefaultMode,
  type PendingSyncConflict,
  type SyncConflictResolutionChoice,
} from '../lib/syncConflictResolver';

const ONBOARDING_DISMISSED_KEY = 'holoo_apex_mesh_onboarding_dismissed_v1';

/** Fast deterministic FNV-1a payload fingerprint ignoring volatile exportedAt timestamp */
function computePayloadFingerprint(rawJson: string): string {
  const normalized = rawJson.replace(/"exportedAt"\s*:\s*"[^"]*"/g, '"exportedAt":""');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length}_${(hash >>> 0).toString(16)}`;
}

export function useLocalFirstMeshSync() {
  const {
    profile,
    accounts,
    vouchers,
    invoices,
    products,
    parties,
    cheques,
    employees,
    assets,
    costCenters,
    currencies,
    exchangeRates,
    importDossiers,
    salesOrders,
    subcontractJobs,
    rbacOperators,
    deviceId,
    setDeviceLabel,
    exportBackupJson,
    importBackupJson,
    logActivity,
    showToast,
  } = useAccounting();

  const {
    trackedWarehouseTransfers,
    updateExtensions,
  } = useWorkspaceExtensions();
  const latestTrackedTransfersRef = useRef(trackedWarehouseTransfers);
  latestTrackedTransfersRef.current = trackedWarehouseTransfers;

  const isOnline = useOnlineStatus();

  // ---- Persistent Device Storage (navigator.storage.persist) ----
  const [storagePersistence, setStoragePersistence] = useState<StoragePersistenceInfo>({
    supported: typeof navigator !== 'undefined' && Boolean(navigator.storage),
    persisted: false,
    usageBytes: 0,
    quotaBytes: 0,
  });

  // ---- User-Selectable Local Storage Folder (File System Access API + Fallback) ----
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const [localFolderStatus, setLocalFolderStatus] = useState<LocalFolderStatus>({
    supported: isDirectoryPickerSupported(),
    configured: false,
    folderName: null,
    permission: isDirectoryPickerSupported() ? 'unconfigured' : 'unsupported',
    lastMirroredAt: null,
    lastDailySnapshotFile: null,
    lastError: null,
    fallbackMode: !isDirectoryPickerSupported(),
  });
  const [isFolderBusy, setIsFolderBusy] = useState(false);
  const [dexieRecordCount, setDexieRecordCount] = useState(0);

  // ---- 3-Device PeerJS Mesh State ----
  const [selectedPeerId, setSelectedPeerIdState] = useState<MeshDevicePeerId | null>(() =>
    loadSelectedMeshPeerId()
  );
  const [meshPassphrase, setMeshPassphraseState] = useState<string>(() => loadMeshPassphrase());
  const [meshSelfOnline, setMeshSelfOnline] = useState(false);
  const [meshSelfError, setMeshSelfError] = useState<string | null>(null);
  const [peerStates, setPeerStates] = useState<MeshPeerRuntimeState[]>(() => {
    const myId = loadSelectedMeshPeerId();
    return MESH_DEVICES.filter((d) => d.peerId !== myId).map((d) => ({
      ...d,
      status: 'offline',
      lastSeenAt: null,
      lastSyncedAt: null,
      lastError: null,
    }));
  });
  const [isP2PSyncing, setIsP2PSyncing] = useState(false);

  // ---- First-Launch Setup Wizard ----
  const [needsInitialSetup, setNeedsInitialSetup] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const savedPeer = loadSelectedMeshPeerId();
    if (savedPeer) return false;
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_KEY) !== '1';
    } catch {
      return true;
    }
  });

  // ---- Dexie Outbox & PeerJS Audit Event Logs ----
  const [dexieOutbox, setDexieOutbox] = useState<MeshSyncOutboxItem[]>([]);
  const [syncEventLogs, setSyncEventLogs] = useState<MeshSyncEventLog[]>([]);
  const [vectorClock, setVectorClock] = useState<Record<string, number>>(() => loadVectorClock());
  const [pendingMeshConflict, setPendingMeshConflict] = useState<PendingSyncConflict | null>(null);
  const [isResolvingMeshConflict, setIsResolvingMeshConflict] = useState(false);

  // Refs to prevent stale closures & echo loops
  const connectorRef = useRef<PeerMeshConnector | null>(null);
  const isRemoteUpdateRef = useRef(false);
  const lastObservedFingerprintRef = useRef<string>('');
  const didBootMirrorRef = useRef(false);
  const vectorClockRef = useRef<Record<string, number>>(vectorClock);
  vectorClockRef.current = vectorClock;

  const latestExportRef = useRef(exportBackupJson);
  latestExportRef.current = exportBackupJson;

  const latestImportRef = useRef(importBackupJson);
  latestImportRef.current = importBackupJson;

  const latestCountsRef = useRef({
    vouchers: vouchers.length,
    invoices: invoices.length,
    products: products.length,
  });
  latestCountsRef.current = {
    vouchers: vouchers.length,
    invoices: invoices.length,
    products: products.length,
  };

  const activeDeviceIdentity = selectedPeerId || deviceId || 'holoo-local-device';

  const refreshOutboxAndLogs = useCallback(async () => {
    const [outboxRows, logRows] = await Promise.all([
      listDexieOutboxItems(),
      listMeshSyncEventLogs(200),
    ]);
    setDexieOutbox(outboxRows);
    setSyncEventLogs(logRows);
  }, []);

  const recordSyncEvent = useCallback(async (event: Omit<MeshSyncEventLog, 'id'>) => {
    const saved = await appendMeshSyncEventLog(event);
    setSyncEventLogs((prev) => [saved, ...prev].slice(0, 200));
  }, []);

  // ---- Boot Effect: Persistent Storage + Restore Stored Folder Handle + Load Outbox/Logs ----
  useEffect(() => {
    let active = true;
    void (async () => {
      const persistInfo = await requestPersistentDeviceStorage();
      if (!active) return;
      setStoragePersistence(persistInfo);

      const stored = await loadStoredDirectoryHandle();
      if (!active) return;
      if (stored?.handle) {
        dirHandleRef.current = stored.handle;
        const perm = await queryDirectoryPermission(stored.handle);
        if (!active) return;
        setLocalFolderStatus({
          supported: isDirectoryPickerSupported(),
          configured: true,
          folderName: stored.folderName,
          permission: perm,
          lastMirroredAt: stored.lastMirroredAt,
          lastDailySnapshotFile: stored.lastDailySnapshotFile,
          lastError: null,
          fallbackMode: false,
        });
      }

      await refreshOutboxAndLogs();
    })();
    return () => {
      active = false;
    };
  }, [refreshOutboxAndLogs]);

  // ---- Helper: Build tagged local snapshot ----
  const buildTaggedSnapshot = useCallback(() => {
    const accountingSnapshot = safeParseJsonObject(latestExportRef.current()) || {};
    const raw = JSON.stringify({
      ...accountingSnapshot,
      trackedWarehouseTransfers: latestTrackedTransfersRef.current,
    });
    const nowIso = new Date().toISOString();
    const tagged = tagSnapshotWithSyncMetadata(raw, activeDeviceIdentity, nowIso);
    const payloadHash = computePayloadFingerprint(raw);
    return {
      snapshotJson: tagged,
      rawJson: raw,
      payloadHash,
      updatedAt: nowIso,
      vectorClock: vectorClockRef.current,
    };
  }, [activeDeviceIdentity]);

  // ---- Helper: Mirror snapshot into selected local folder ----
  const writeSnapshotToLocalFolder = useCallback(
    async (taggedJson: string, payloadHash: string, enqueueOnPrompt = true): Promise<boolean> => {
      const handle = dirHandleRef.current;
      if (!handle) return false;
      const result = await writeMirrorToSelectedFolder(handle, taggedJson);
      if (result.ok) {
        setLocalFolderStatus((prev) => ({
          ...prev,
          permission: 'granted',
          lastMirroredAt: result.mirroredAt || new Date().toISOString(),
          lastDailySnapshotFile: result.dailySnapshotFile || prev.lastDailySnapshotFile,
          lastError: null,
        }));
        return true;
      }

      if (result.permissionNeeded) {
        setLocalFolderStatus((prev) => ({
          ...prev,
          permission: 'prompt',
          lastError: result.error || 'نیاز به تایید مجدد دسترسی پوشه انتخابی است.',
        }));
        if (enqueueOnPrompt) {
          await enqueueDexieOutboxItem({
            operationId: `folder_${payloadHash}`,
            target: 'local_folder',
            originDeviceId: activeDeviceIdentity,
            summary: 'در انتظار تایید مجدد مجوز برای نوشتن holoo_live_db.json در پوشه محلی',
            payloadHash,
            snapshotJson: taggedJson,
            deliveredToPeers: [],
            requiredPeers: [],
            status: 'pending',
            retryCount: 0,
            errorMessage: result.error || null,
            voucherCount: latestCountsRef.current.vouchers,
            invoiceCount: latestCountsRef.current.invoices,
            productCount: latestCountsRef.current.products,
          });
          await refreshOutboxAndLogs();
        }
      } else {
        setLocalFolderStatus((prev) => ({
          ...prev,
          lastError: result.error || 'خطا در نوشتن فایل در پوشه محلی',
        }));
      }
      return false;
    },
    [activeDeviceIdentity, refreshOutboxAndLogs]
  );

  // ---- PeerJS 3-Device Mesh Lifecycle ("On-Open" + Visibility + Online Reconnect) ----
  useEffect(() => {
    if (!selectedPeerId) {
      if (connectorRef.current) {
        connectorRef.current.stop();
        connectorRef.current = null;
      }
      setMeshSelfOnline(false);
      setPeerStates(
        MESH_DEVICES.map((d) => ({
          ...d,
          status: 'offline',
          lastSeenAt: null,
          lastSyncedAt: null,
          lastError: null,
        }))
      );
      return;
    }

    const connector = new PeerMeshConnector(selectedPeerId, meshPassphrase, {
      getLocalSnapshot: () => {
        const built = buildTaggedSnapshot();
        return {
          snapshotJson: built.snapshotJson,
          payloadHash: built.payloadHash,
          updatedAt: built.updatedAt,
          vectorClock: built.vectorClock,
        };
      },
      getPendingRelayEnvelopes: async () => {
        const items = await listDexieOutboxItems();
        const built = buildTaggedSnapshot();
        return buildRelayEnvelopesFromOutbox(items, built.snapshotJson);
      },
      onRemoteStateReceived: async ({
        fromPeerId,
        snapshotJson,
        vectorClock: remoteClock,
        relayEnvelopes,
        batchedOperationIds,
      }) => {
        setIsP2PSyncing(true);
        try {
          const localBuilt = buildTaggedSnapshot();
          let currentMergedJson = localBuilt.snapshotJson;
          let totalAdded = 0;
          let totalUpdated = 0;
          let totalDeleted = 0;
          let totalConflicts = 0;
          let anyChanged = false;

          // 1) Merge primary remote workspace snapshot via deterministic field-level LWW
          const primaryMerge = mergeWorkspacesDeterministicLWW(
            currentMergedJson,
            snapshotJson,
            selectedPeerId
          );
          currentMergedJson = primaryMerge.mergedSnapshotJson;
          totalAdded += primaryMerge.addedCount;
          totalUpdated += primaryMerge.updatedCount;
          totalDeleted += primaryMerge.deletedCount;
          totalConflicts += primaryMerge.conflictsResolved;
          if (primaryMerge.changed) anyChanged = true;

          // 2) Merge & store relay envelopes for the 3rd device (True 3-Device Mesh Relay!)
          const ackedOpIdSet = new Set<string>(
            Array.isArray(batchedOperationIds) ? batchedOperationIds : []
          );
          const otherPeers = getOtherMeshPeerIds(selectedPeerId);
          for (const env of relayEnvelopes) {
            if (!env?.operationId) continue;
            ackedOpIdSet.add(env.operationId);

            if (env.snapshotJson && env.snapshotJson.length > 2) {
              const relayMerge = mergeWorkspacesDeterministicLWW(
                currentMergedJson,
                env.snapshotJson,
                selectedPeerId
              );
              currentMergedJson = relayMerge.mergedSnapshotJson;
              totalAdded += relayMerge.addedCount;
              totalUpdated += relayMerge.updatedCount;
              totalDeleted += relayMerge.deletedCount;
              totalConflicts += relayMerge.conflictsResolved;
              if (relayMerge.changed) anyChanged = true;
            }

            // If a 3rd device still hasn't received this envelope, queue it in our Dexie outbox to relay later
            const deliveredSet = new Set([...(env.deliveredToPeers || []), selectedPeerId, fromPeerId]);
            const stillNeededForOthers = (env.requiredPeers || otherPeers).filter(
              (p) => p !== selectedPeerId && !deliveredSet.has(p)
            );
            if (stillNeededForOthers.length > 0) {
              await enqueueDexieOutboxItem({
                operationId: env.operationId,
                target: 'p2p_mesh',
                originDeviceId: env.originDeviceId || fromPeerId,
                summary: `رله سه‌دستگاهی از ${MESH_DEVICES.find((d) => d.peerId === fromPeerId)?.shortLabel || fromPeerId}: ${env.summary}`,
                payloadHash: env.payloadHash,
                snapshotJson: env.snapshotJson || currentMergedJson,
                deliveredToPeers: Array.from(deliveredSet),
                requiredPeers: stillNeededForOthers,
                status: 'pending',
                retryCount: 0,
                errorMessage: null,
                voucherCount: latestCountsRef.current.vouchers,
                invoiceCount: latestCountsRef.current.invoices,
                productCount: latestCountsRef.current.products,
              });
            }
          }
          const ackedOpIds = Array.from(ackedOpIdSet);

          const peerLabel =
            MESH_DEVICES.find((d) => d.peerId === fromPeerId)?.shortLabel || fromPeerId;

          // Respect interactive or saved-default conflict resolution when concurrent edits collide
          let autoConflictNote: string | null = null;
          if (totalConflicts > 0) {
            const savedMode = loadSyncConflictDefaultMode();
            const decision = resolveConflictDecision(savedMode);
            const conflictSummary = analyzeAccountingSnapshotConflict(
              localBuilt.snapshotJson,
              snapshotJson
            );

            if (!decision.autoResolved && conflictSummary.hasConflicts) {
              setPendingMeshConflict({
                id: `mesh_conflict_${Date.now()}`,
                source: 'p2p_mesh',
                sourceLabel: 'همگام‌سازی سه‌دستگاهی PeerJS Mesh',
                remoteDeviceLabel: peerLabel,
                detectedAt: new Date().toISOString(),
                localRevision: vectorClockRef.current[selectedPeerId] || 0,
                remoteRevision: Number(remoteClock?.[fromPeerId]) || 0,
                localSnapshotJson: localBuilt.snapshotJson,
                remoteSnapshotJson: snapshotJson,
                mergedSnapshotJson: currentMergedJson,
                summary: conflictSummary,
              });
              playWarningTone();
              showToast(
                `تداخل در ${toPersianDigits(conflictSummary.totalConflictingDocs)} سند حسابداری با «${peerLabel}» شناسایی شد؛ لطفاً نسخه نهایی را انتخاب کنید.`
              );
              await recordSyncEvent({
                eventId: `mevt_conflict_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                timestamp: new Date().toISOString(),
                peerId: fromPeerId,
                peerLabel,
                eventType: 'state_pull',
                status: 'info',
                direction: 'inbound',
                localVectorClock: { ...vectorClockRef.current },
                remoteVectorClock: { ...(remoteClock || {}) },
                recordsMerged: 0,
                conflictsResolved: 0,
                summary: `تداخل در ${toPersianDigits(conflictSummary.totalConflictingDocs)} سند با «${peerLabel}» شناسایی شد و در انتظار تصمیم کاربر قرار گرفت.`,
              });
              await refreshOutboxAndLogs();
              return [];
            }

            if (decision.autoResolved && decision.choice === 'keep_local') {
              anyChanged = false;
              autoConflictNote = `تداخل با «${peerLabel}» به‌صورت خودکار حل شد (پیش‌فرض ذخیره‌شده: حفظ آخرین تغییر محلی).`;
              logActivity('همگام‌سازی P2P (Mesh)', 'حل خودکار تداخل (حفظ محلی)', autoConflictNote);
              playSuccessChime();
              showToast(autoConflictNote);
            } else if (decision.autoResolved && decision.choice === 'restore_remote') {
              currentMergedJson = snapshotJson;
              anyChanged = true;
              autoConflictNote = `تداخل با «${peerLabel}» به‌صورت خودکار حل شد (پیش‌فرض ذخیره‌شده: بازگردانی نسخه همتا).`;
            }
          }

          // 3) Advance vector clock deterministically
          const nextClock: Record<string, number> = { ...vectorClockRef.current };
          for (const [k, v] of Object.entries(remoteClock || {})) {
            const num = Number(v) || 0;
            if (num > (nextClock[k] || 0)) {
              nextClock[k] = num;
            }
          }
          vectorClockRef.current = nextClock;
          setVectorClock(nextClock);
          saveVectorClock(nextClock);

          if (anyChanged) {
            // Anti-loop guard: suppress local mutation echo during remote import
            isRemoteUpdateRef.current = true;
            try {
              const ok = latestImportRef.current(currentMergedJson);
              if (ok) {
                const mergedSnapshot = safeParseJsonObject(currentMergedJson);
                if (mergedSnapshot && Array.isArray(mergedSnapshot.trackedWarehouseTransfers)) {
                  const safeTransfers = mergedSnapshot.trackedWarehouseTransfers.filter((item): item is TrackedWarehouseTransfer => {
                    if (!item || typeof item !== 'object') return false;
                    const transfer = item as Partial<TrackedWarehouseTransfer>;
                    return typeof transfer.id === 'string'
                      && transfer.id.length > 0
                      && typeof transfer.productId === 'string'
                      && transfer.productId.length > 0
                      && typeof transfer.transferNumber === 'string'
                      && typeof transfer.fromWarehouse === 'string'
                      && typeof transfer.toWarehouse === 'string'
                      && Number.isFinite(Number(transfer.qty))
                      && Number(transfer.qty) > 0
                      && Number.isFinite(Number(transfer.transferredCostIrr))
                      && Number(transfer.transferredCostIrr) >= 0
                      && Array.isArray(transfer.transferredLayers)
                      && (transfer.status === 'in_transit' || transfer.status === 'received' || transfer.status === 'cancelled');
                  }).slice(-100);
                  updateExtensions((prev) => ({
                    ...prev,
                    trackedWarehouseTransfers: safeTransfers,
                  }));
                }
                lastObservedFingerprintRef.current = computePayloadFingerprint(currentMergedJson);
                const savedCount = await persistTaggedSnapshotToDexie(
                  currentMergedJson,
                  selectedPeerId
                );
                setDexieRecordCount(savedCount);
                // Real-time mirror newly pulled P2P state into user's selected local folder too!
                await writeSnapshotToLocalFolder(
                  currentMergedJson,
                  computePayloadFingerprint(currentMergedJson),
                  false
                );

                playSuccessChime();
                const mergedTotal = totalAdded + totalUpdated + totalDeleted;
                showToast(
                  autoConflictNote ||
                    `همگام‌سازی P2P با «${peerLabel}» انجام شد (${toPersianDigits(mergedTotal)} تغییر ادغام و در پوشه محلی ثبت گردید).`
                );
                logActivity(
                  'همگام‌سازی P2P (Mesh)',
                  autoConflictNote ? 'حل خودکار تداخل (نسخه همتا)' : 'دریافت و ادغام خودکار LWW',
                  autoConflictNote ||
                    `تغییرات از «${peerLabel}» دریافت شد (جدید: ${totalAdded}، بروزرسانی: ${totalUpdated}، حذف: ${totalDeleted}، حل تعارض: ${totalConflicts}).`
                );
              }
            } finally {
              window.setTimeout(() => {
                isRemoteUpdateRef.current = false;
              }, 1600);
            }
          }

          await recordSyncEvent({
            eventId: `mevt_pull_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            peerId: fromPeerId,
            peerLabel,
            eventType: 'state_pull',
            status: 'success',
            direction: 'inbound',
            localVectorClock: { ...nextClock },
            remoteVectorClock: { ...(remoteClock || {}) },
            recordsMerged: anyChanged ? totalAdded + totalUpdated + totalDeleted : 0,
            conflictsResolved: totalConflicts,
            summary:
              autoConflictNote ||
              (anyChanged
                ? `دریافت و ادغام LWW از «${peerLabel}» با موفقیت انجام شد (${toPersianDigits(totalAdded)} جدید، ${toPersianDigits(totalUpdated)} بروزرسانی، ${toPersianDigits(totalConflicts)} تعارض حل‌شده).`
                : `بسته وضعیت از «${peerLabel}» بررسی شد؛ تغییری جدیدتر از نسخه محلی وجود نداشت.`),
          });

          await refreshOutboxAndLogs();
          return ackedOpIds;
        } finally {
          setIsP2PSyncing(false);
        }
      },
      onPeerAckReceived: async ({ fromPeerId, receivedOperationIds }) => {
        for (const opId of receivedOperationIds) {
          await markDexieOutboxPeerDelivered(opId, fromPeerId);
        }
        // Also mark any pending p2p_mesh items whose payload is older than or equal to now as delivered to this peer
        const currentItems = await listDexieOutboxItems();
        for (const item of currentItems) {
          if (
            item.target === 'p2p_mesh' &&
            item.status !== 'synced' &&
            !item.deliveredToPeers.includes(fromPeerId)
          ) {
            await markDexieOutboxPeerDelivered(item.operationId, fromPeerId);
          }
        }
        await refreshOutboxAndLogs();
      },
      onStatusChange: (peers, selfOnline, selfError) => {
        setPeerStates(peers);
        setMeshSelfOnline(selfOnline);
        setMeshSelfError(selfError);
      },
      onSyncEvent: (evt) => {
        void recordSyncEvent(evt);
      },
    });

    connectorRef.current = connector;
    if (isOnline) {
      connector.start();
    }

    const handleVisibility = () => {
      if (!connectorRef.current) return;
      if (document.visibilityState === 'visible' && navigator.onLine) {
        connectorRef.current.connectToAllPeers();
      } else if (document.visibilityState === 'hidden' && navigator.onLine) {
        // Flush any buffered small transaction updates before the tab backgrounds
        void connectorRef.current.flushBatchedUpdates(false);
      }
    };
    const handlePageHide = () => {
      if (connectorRef.current && navigator.onLine) {
        void connectorRef.current.flushBatchedUpdates(false);
      }
    };
    const handleOnline = () => {
      if (!connectorRef.current) return;
      connectorRef.current.start();
      window.setTimeout(() => {
        connectorRef.current?.connectToAllPeers();
      }, 1200);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('online', handleOnline);
      connector.stop();
      if (connectorRef.current === connector) {
        connectorRef.current = null;
      }
    };
  }, [
    selectedPeerId,
    meshPassphrase,
    isOnline,
    buildTaggedSnapshot,
    writeSnapshotToLocalFolder,
    refreshOutboxAndLogs,
    recordSyncEvent,
    logActivity,
    showToast,
  ]);

  // ---- Real-Time Mutation Observer: Dexie Mirror + Local Folder Mirror + P2P Outbox Broadcast ----
  const stateRevisionSignal = useMemo(
    () =>
      [
        profile.companyName,
        profile.fiscalYear,
        profile.currencyUnit,
        accounts.length,
        vouchers.length,
        vouchers[0]?.id || '',
        invoices.length,
        invoices[0]?.id || '',
        products.length,
        parties.length,
        cheques.length,
        employees.length,
        assets.length,
        costCenters.length,
        currencies.length,
        exchangeRates.length,
        importDossiers.length,
        salesOrders.length,
        subcontractJobs.length,
        rbacOperators.length,
        trackedWarehouseTransfers.length,
        JSON.stringify(trackedWarehouseTransfers),
      ].join('|'),
    [
      profile.companyName,
      profile.fiscalYear,
      profile.currencyUnit,
      accounts,
      vouchers,
      invoices,
      products,
      parties,
      cheques,
      employees,
      assets,
      costCenters,
      currencies,
      exchangeRates,
      importDossiers,
      salesOrders,
      subcontractJobs,
      rbacOperators,
      trackedWarehouseTransfers,
    ]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        const built = buildTaggedSnapshot();

        // First boot: seed Dexie liveRecords silently without creating a bogus outbox mutation
        if (!didBootMirrorRef.current) {
          didBootMirrorRef.current = true;
          lastObservedFingerprintRef.current = built.payloadHash;
          const count = await persistTaggedSnapshotToDexie(built.snapshotJson, activeDeviceIdentity);
          setDexieRecordCount(count);
          return;
        }

        if (isRemoteUpdateRef.current) return;
        if (built.payloadHash === lastObservedFingerprintRef.current) return;
        lastObservedFingerprintRef.current = built.payloadHash;

        // 1) Persist tagged entities in Dexie IndexedDB
        const count = await persistTaggedSnapshotToDexie(built.snapshotJson, activeDeviceIdentity);
        setDexieRecordCount(count);

        // 2) Increment local vector clock
        const nextClock = {
          ...vectorClockRef.current,
          [activeDeviceIdentity]: (vectorClockRef.current[activeDeviceIdentity] || 0) + 1,
        };
        vectorClockRef.current = nextClock;
        setVectorClock(nextClock);
        saveVectorClock(nextClock);

        // 3) Real-time mirror to user-selected local folder (holoo_live_db.json + rolling daily)
        if (dirHandleRef.current) {
          await writeSnapshotToLocalFolder(built.snapshotJson, built.payloadHash, true);
        }

        // 4) Queue P2P Mesh outbox operation for the other 2 devices & broadcast immediately if connected
        if (selectedPeerId) {
          const requiredPeers = getOtherMeshPeerIds(selectedPeerId);
          const opId = `p2p_${Date.now()}_${built.payloadHash.slice(0, 8)}`;
          await enqueueDexieOutboxItem({
            operationId: opId,
            target: 'p2p_mesh',
            originDeviceId: selectedPeerId,
            summary: `تغییر حسابداری (${toPersianDigits(vouchers.length)} سند، ${toPersianDigits(invoices.length)} فاکتور، ${toPersianDigits(products.length)} کالا)`,
            payloadHash: built.payloadHash,
            snapshotJson: built.snapshotJson,
            deliveredToPeers: [],
            requiredPeers,
            status: 'pending',
            retryCount: 0,
            errorMessage: null,
            voucherCount: vouchers.length,
            invoiceCount: invoices.length,
            productCount: products.length,
          });
          await refreshOutboxAndLogs();

          if (isOnline && connectorRef.current) {
            // Coalesce consecutive small transaction updates into fewer lightweight version-vector exchanges
            connectorRef.current.queueLocalUpdate(opId);
          }
        }
      })();
    }, 1100);

    return () => window.clearTimeout(timer);
  }, [
    stateRevisionSignal,
    trackedWarehouseTransfers,
    accounts,
    vouchers,
    invoices,
    products,
    parties,
    cheques,
    activeDeviceIdentity,
    selectedPeerId,
    isOnline,
    buildTaggedSnapshot,
    writeSnapshotToLocalFolder,
    refreshOutboxAndLogs,
    trackedWarehouseTransfers,
  ]);

  // ==================== USER ACTIONS ====================

  const selectLocalFolder = useCallback(async () => {
    setIsFolderBusy(true);
    try {
      const res = await pickLocalStorageDirectory();
      if (!res.ok || !res.handle) {
        setLocalFolderStatus((prev) => ({
          ...prev,
          permission: res.permission,
          fallbackMode: Boolean(res.fallbackRequired),
          lastError: res.error || null,
        }));
        if (res.error) {
          playWarningTone();
          showToast(res.error);
        }
        return false;
      }

      dirHandleRef.current = res.handle;
      const built = buildTaggedSnapshot();
      const writeRes = await writeMirrorToSelectedFolder(res.handle, built.snapshotJson);

      setLocalFolderStatus({
        supported: true,
        configured: true,
        folderName: res.folderName || res.handle.name || 'Holoo_Data',
        permission: 'granted',
        lastMirroredAt: writeRes.mirroredAt || new Date().toISOString(),
        lastDailySnapshotFile: writeRes.dailySnapshotFile || null,
        lastError: writeRes.ok ? null : writeRes.error || null,
        fallbackMode: false,
      });

      // Mark any pending local_folder outbox items as synced
      const items = await listDexieOutboxItems();
      for (const item of items) {
        if (item.target === 'local_folder' && item.status !== 'synced') {
          await updateDexieOutboxItem(item.operationId, { status: 'synced', errorMessage: null });
        }
      }
      await refreshOutboxAndLogs();

      playSuccessChime();
      showToast(
        `پوشه محلی «${res.folderName || res.handle.name}» با موفقیت متصل و فایل holoo_live_db.json نوشته شد.`
      );
      logActivity(
        'ذخیره‌سازی محلی',
        'انتخاب پوشه محلی کاربر',
        `پوشه «${res.folderName || res.handle.name}» به‌عنوان مسیر آینه‌ای زنده انتخاب و ثبت شد.`
      );
      return true;
    } finally {
      setIsFolderBusy(false);
    }
  }, [buildTaggedSnapshot, logActivity, refreshOutboxAndLogs, showToast]);

  const regrantFolderPermission = useCallback(async () => {
    const handle = dirHandleRef.current;
    if (!handle) {
      return selectLocalFolder();
    }
    setIsFolderBusy(true);
    try {
      const perm = await requestDirectoryPermission(handle);
      if (perm !== 'granted') {
        setLocalFolderStatus((prev) => ({
          ...prev,
          permission: perm,
          lastError: 'مجوز نوشتن در پوشه انتخابی تأیید نشد.',
        }));
        playErrorTone();
        showToast('مجوز دسترسی به پوشه انتخابی تأیید نشد.');
        return false;
      }
      const built = buildTaggedSnapshot();
      const ok = await writeSnapshotToLocalFolder(built.snapshotJson, built.payloadHash, false);
      if (ok) {
        const items = await listDexieOutboxItems();
        for (const item of items) {
          if (item.target === 'local_folder' && item.status !== 'synced') {
            await updateDexieOutboxItem(item.operationId, { status: 'synced', errorMessage: null });
          }
        }
        await refreshOutboxAndLogs();
        playSuccessChime();
        showToast('مجوز پوشه انتخابی فعال و فایل زنده holoo_live_db.json بروزرسانی شد.');
      }
      return ok;
    } finally {
      setIsFolderBusy(false);
    }
  }, [
    selectLocalFolder,
    buildTaggedSnapshot,
    writeSnapshotToLocalFolder,
    refreshOutboxAndLogs,
    showToast,
  ]);

  const mirrorNowToFolder = useCallback(async () => {
    if (!dirHandleRef.current) {
      return selectLocalFolder();
    }
    setIsFolderBusy(true);
    try {
      const built = buildTaggedSnapshot();
      const ok = await writeSnapshotToLocalFolder(built.snapshotJson, built.payloadHash, true);
      if (ok) {
        playSuccessChime();
        showToast('نسخه زنده holoo_live_db.json و اسنپ‌شات روزانه در پوشه انتخابی ذخیره شد.');
      } else {
        playWarningTone();
        showToast('برای نوشتن در پوشه انتخابی، روی «تایید مجدد مجوز» کلیک کنید.');
      }
      return ok;
    } finally {
      setIsFolderBusy(false);
    }
  }, [selectLocalFolder, buildTaggedSnapshot, writeSnapshotToLocalFolder, showToast]);

  const restoreFromSelectedFolder = useCallback(async () => {
    let handle = dirHandleRef.current;
    if (!handle) {
      const picked = await pickLocalStorageDirectory();
      if (!picked.ok || !picked.handle) {
        if (picked.error) showToast(picked.error);
        return false;
      }
      handle = picked.handle;
      dirHandleRef.current = handle;
      setLocalFolderStatus((prev) => ({
        ...prev,
        configured: true,
        folderName: picked.folderName || handle!.name || 'Holoo_Data',
        permission: 'granted',
        fallbackMode: false,
      }));
    }

    setIsFolderBusy(true);
    try {
      let readRes = await readMirrorFromSelectedFolder(handle);
      if (readRes.permissionNeeded) {
        const perm = await requestDirectoryPermission(handle);
        if (perm === 'granted') {
          readRes = await readMirrorFromSelectedFolder(handle);
        }
      }
      if (!readRes.ok || !readRes.snapshotJson) {
        playErrorTone();
        showToast(readRes.error || 'خواندن فایل از پوشه انتخابی ناموفق بود.');
        return false;
      }

      const localBuilt = buildTaggedSnapshot();
      const merged = mergeWorkspacesDeterministicLWW(
        localBuilt.snapshotJson,
        readRes.snapshotJson,
        activeDeviceIdentity
      );

      isRemoteUpdateRef.current = true;
      try {
        const imported = latestImportRef.current(merged.mergedSnapshotJson);
        if (!imported) {
          playErrorTone();
          showToast('ساختار فایل داخل پوشه انتخابی برای بازیابی معتبر نیست.');
          return false;
        }
        lastObservedFingerprintRef.current = computePayloadFingerprint(merged.mergedSnapshotJson);
        const count = await persistTaggedSnapshotToDexie(
          merged.mergedSnapshotJson,
          activeDeviceIdentity
        );
        setDexieRecordCount(count);
        playSuccessChime();
        showToast(
          `بازیابی و ادغام LWW از پوشه «${localFolderStatus.folderName || handle.name}» با موفقیت انجام شد (جدید: ${toPersianDigits(merged.addedCount)}، بروزرسانی: ${toPersianDigits(merged.updatedCount)}).`
        );
        logActivity(
          'ذخیره‌سازی محلی',
          'بازیابی از پوشه انتخابی',
          `فایل holoo_live_db.json از پوشه محلی خوانده و با الگوریتم LWW ادغام شد.`
        );
        return true;
      } finally {
        window.setTimeout(() => {
          isRemoteUpdateRef.current = false;
        }, 1600);
      }
    } finally {
      setIsFolderBusy(false);
    }
  }, [
    buildTaggedSnapshot,
    activeDeviceIdentity,
    localFolderStatus.folderName,
    logActivity,
    showToast,
  ]);

  const saveFallbackToDownloads = useCallback(async () => {
    setIsFolderBusy(true);
    try {
      const built = buildTaggedSnapshot();
      const res = await saveSnapshotFallbackToDownloads(built.snapshotJson);
      if (res.ok) {
        playSuccessChime();
        showToast(`فایل پشتیبان زنده «${res.fileName}» در پوشه دانلودها ذخیره شد.`);
      } else if (res.error) {
        playWarningTone();
        showToast(res.error);
      }
      return res.ok;
    } finally {
      setIsFolderBusy(false);
    }
  }, [buildTaggedSnapshot, showToast]);

  const disconnectLocalFolder = useCallback(async () => {
    dirHandleRef.current = null;
    await clearStoredDirectoryHandle();
    setLocalFolderStatus({
      supported: isDirectoryPickerSupported(),
      configured: false,
      folderName: null,
      permission: isDirectoryPickerSupported() ? 'unconfigured' : 'unsupported',
      lastMirroredAt: null,
      lastDailySnapshotFile: null,
      lastError: null,
      fallbackMode: !isDirectoryPickerSupported(),
    });
    showToast('اتصال پوشه انتخابی قطع شد؛ ذخیره در حافظه داخلی دائمی IndexedDB ادامه دارد.');
  }, [showToast]);

  const selectDevicePeerRole = useCallback(
    (peerId: MeshDevicePeerId) => {
      saveSelectedMeshPeerId(peerId);
      setSelectedPeerIdState(peerId);
      const profileMeta = MESH_DEVICES.find((d) => d.peerId === peerId);
      if (profileMeta) {
        setDeviceLabel(profileMeta.shortLabel);
      }
      try {
        localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
      } catch {
        // ignore
      }
      setNeedsInitialSetup(false);
      playSuccessChime();
      showToast(
        `نقش دستگاه روی «${profileMeta?.shortLabel || peerId}» تنظیم شد؛ همگام‌سازی خودکار P2P با ۲ دستگاه دیگر فعال گردید.`
      );
      logActivity(
        'همگام‌سازی P2P (Mesh)',
        'تنظیم شناسه ثابت دستگاه',
        `شناسه P2P این دستگاه روی ${peerId} (${profileMeta?.shortLabel || ''}) ذخیره شد.`
      );
    },
    [setDeviceLabel, logActivity, showToast]
  );

  const updateMeshPassphrase = useCallback(
    (passphrase: string) => {
      const clean = passphrase.trim();
      if (clean.length < 4) {
        playWarningTone();
        showToast('کلید امنیتی شبکه ۳ دستگاه باید حداقل ۴ کاراکتر باشد.');
        return false;
      }
      saveMeshPassphrase(clean);
      setMeshPassphraseState(clean);
      playSuccessChime();
      showToast('کلید امنیتی مشترک شبکه ۳ دستگاه بروزرسانی و شبکه مجدداً متصل شد.');
      return true;
    },
    [showToast]
  );

  const triggerP2PSyncNow = useCallback(async () => {
    if (!selectedPeerId) {
      setNeedsInitialSetup(true);
      playWarningTone();
      showToast('ابتدا نقش این دستگاه (لپ‌تاپ، موبایل من یا موبایل همکار) را انتخاب کنید.');
      return;
    }
    if (!isOnline) {
      playWarningTone();
      showToast('دستگاه آفلاین است؛ تمام تغییرات در صف sync_outbox ذخیره شده‌اند و پس از اتصال خودکار ارسال می‌شوند.');
      return;
    }
    setIsP2PSyncing(true);
    try {
      if (!connectorRef.current) return;
      connectorRef.current.connectToAllPeers();
      const sent = await connectorRef.current.flushBatchedUpdates(true);
      if (sent > 0) {
        playSuccessChime();
        showToast(`بسته همگام‌سازی و بردار نسخه به ${toPersianDigits(sent)} دستگاه متصل ارسال شد.`);
      } else {
        showToast('درخواست اتصال به ۲ دستگاه دیگر ارسال شد؛ به محض آنلاین شدن، تبادل بردار نسخه خودکار انجام می‌شود.');
      }
    } finally {
      window.setTimeout(() => setIsP2PSyncing(false), 700);
    }
  }, [selectedPeerId, isOnline, showToast]);

  const dismissInitialSetup = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
    setNeedsInitialSetup(false);
  }, []);

  const retryOutboxItem = useCallback(
    async (operationId: string) => {
      const items = await listDexieOutboxItems();
      const target = items.find((i) => i.operationId === operationId);
      if (!target) return;

      await updateDexieOutboxItem(operationId, {
        status: 'retrying',
        retryCount: (target.retryCount || 0) + 1,
      });
      await refreshOutboxAndLogs();

      if (target.target === 'local_folder') {
        const ok = await regrantFolderPermission();
        if (!ok) {
          await updateDexieOutboxItem(operationId, {
            status: 'pending',
            errorMessage: 'مجوز پوشه محلی هنوز تأیید نشده است.',
          });
        }
      } else if (target.target === 'p2p_mesh') {
        if (!isOnline || !connectorRef.current) {
          await updateDexieOutboxItem(operationId, {
            status: 'pending',
            errorMessage: 'دستگاه آفلاین است یا نقش P2P انتخاب نشده است.',
          });
          playWarningTone();
          showToast('امکان ارسال P2P در حالت آفلاین وجود ندارد؛ آیتم در صف محفوظ ماند.');
        } else {
          connectorRef.current.connectToAllPeers();
          const sent = await connectorRef.current.broadcastStateToConnectedPeers();
          await updateDexieOutboxItem(operationId, {
            status: sent > 0 ? 'retrying' : 'pending',
            errorMessage:
              sent > 0 ? null : 'هیچ‌یک از ۲ دستگاه همتا هم‌اکنون آنلاین نیستند؛ در صف رله باقی ماند.',
          });
          if (sent > 0) {
            playSuccessChime();
            showToast('تلاش مجدد برای ارسال بسته P2P به دستگاه‌های متصل انجام شد.');
          } else {
            playWarningTone();
            showToast('دستگاه‌های همتا آنلاین نیستند؛ به محض باز شدن برنامه روی دستگاه بعدی خودکار تحویل می‌شود.');
          }
        }
      }
      await refreshOutboxAndLogs();
    },
    [isOnline, regrantFolderPermission, refreshOutboxAndLogs, showToast]
  );

  const retryAllPendingOutbox = useCallback(async () => {
    const items = await listDexieOutboxItems();
    const pendingFolder = items.some((i) => i.target === 'local_folder' && i.status !== 'synced');
    const pendingP2P = items.some((i) => i.target === 'p2p_mesh' && i.status !== 'synced');

    if (pendingFolder) {
      await regrantFolderPermission();
    }
    if (pendingP2P && isOnline && connectorRef.current) {
      connectorRef.current.connectToAllPeers();
      await connectorRef.current.broadcastStateToConnectedPeers();
    }
    await refreshOutboxAndLogs();
  }, [isOnline, regrantFolderPermission, refreshOutboxAndLogs]);

  const clearSyncedOutbox = useCallback(async () => {
    await clearSyncedDexieOutboxItems();
    await refreshOutboxAndLogs();
    showToast('آیتم‌های تحویل‌شده از صف آفلاین پاکسازی شدند.');
  }, [refreshOutboxAndLogs, showToast]);

  const clearAllOutbox = useCallback(async () => {
    await clearAllDexieOutboxItems();
    await refreshOutboxAndLogs();
    showToast('تمام صف محلی sync_outbox پاکسازی شد.');
  }, [refreshOutboxAndLogs, showToast]);

  const clearSyncEventLogs = useCallback(async () => {
    await clearMeshSyncEventLogs();
    setSyncEventLogs([]);
    showToast('تاریخچه رویدادهای همگام‌سازی PeerJS پاکسازی شد.');
  }, [showToast]);

  const resolvePendingMeshConflict = useCallback(
    async (
      choice: SyncConflictResolutionChoice,
      rememberAsDefault: boolean
    ): Promise<boolean> => {
      if (!pendingMeshConflict) return false;
      setIsResolvingMeshConflict(true);
      try {
        if (rememberAsDefault) {
          saveSyncConflictDefaultMode(choice);
        }
        const defaultSuffix = rememberAsDefault
          ? ' و به‌عنوان پیش‌فرض حل تداخلات آینده ذخیره شد'
          : '';

        if (choice === 'restore_remote') {
          isRemoteUpdateRef.current = true;
          try {
            const ok = latestImportRef.current(pendingMeshConflict.remoteSnapshotJson);
            if (!ok) {
              playErrorTone();
              showToast('بازگردانی نسخه همتا ناموفق بود.');
              return false;
            }
            const fp = computePayloadFingerprint(pendingMeshConflict.remoteSnapshotJson);
            lastObservedFingerprintRef.current = fp;
            const savedCount = await persistTaggedSnapshotToDexie(
              pendingMeshConflict.remoteSnapshotJson,
              activeDeviceIdentity
            );
            setDexieRecordCount(savedCount);
            await writeSnapshotToLocalFolder(pendingMeshConflict.remoteSnapshotJson, fp, false);
          } finally {
            window.setTimeout(() => {
              isRemoteUpdateRef.current = false;
            }, 1600);
          }

          setPendingMeshConflict(null);
          playSuccessChime();
          const note = `نسخه دریافتی از «${pendingMeshConflict.remoteDeviceLabel}» بازگردانی شد${defaultSuffix}.`;
          logActivity('همگام‌سازی P2P (Mesh)', 'حل تداخل توسط کاربر (نسخه همتا)', note);
          showToast(note);
          return true;
        }

        // choice === 'keep_local': retain local state and propagate to peers
        const built = buildTaggedSnapshot();
        const nextClock = {
          ...vectorClockRef.current,
          [activeDeviceIdentity]: (vectorClockRef.current[activeDeviceIdentity] || 0) + 1,
        };
        vectorClockRef.current = nextClock;
        setVectorClock(nextClock);
        saveVectorClock(nextClock);

        if (selectedPeerId) {
          const opId = `p2p_keep_local_${Date.now()}`;
          await enqueueDexieOutboxItem({
            operationId: opId,
            target: 'p2p_mesh',
            originDeviceId: selectedPeerId,
            summary: 'ارسال نسخه محلی تاییدشده پس از حل تداخل اسناد',
            payloadHash: built.payloadHash,
            snapshotJson: built.snapshotJson,
            deliveredToPeers: [],
            requiredPeers: getOtherMeshPeerIds(selectedPeerId),
            status: 'pending',
            retryCount: 0,
            errorMessage: null,
            voucherCount: latestCountsRef.current.vouchers,
            invoiceCount: latestCountsRef.current.invoices,
            productCount: latestCountsRef.current.products,
          });
          await refreshOutboxAndLogs();
          if (isOnline && connectorRef.current) {
            connectorRef.current.queueLocalUpdate(opId);
            await connectorRef.current.flushBatchedUpdates(true);
          }
        }

        setPendingMeshConflict(null);
        playSuccessChime();
        const note = `آخرین تغییر محلی حفظ و برای دستگاه‌های همتا ارسال شد${defaultSuffix}.`;
        logActivity('همگام‌سازی P2P (Mesh)', 'حل تداخل توسط کاربر (حفظ محلی)', note);
        showToast(note);
        return true;
      } finally {
        setIsResolvingMeshConflict(false);
      }
    },
    [
      pendingMeshConflict,
      activeDeviceIdentity,
      writeSnapshotToLocalFolder,
      buildTaggedSnapshot,
      selectedPeerId,
      isOnline,
      refreshOutboxAndLogs,
      logActivity,
      showToast,
    ]
  );

  const dismissPendingMeshConflict = useCallback(() => {
    setPendingMeshConflict(null);
  }, []);

  // Derived metrics
  const connectedPeerCount = useMemo(
    () => peerStates.filter((p) => p.status === 'connected').length,
    [peerStates]
  );
  const pendingOutboxCount = useMemo(
    () => dexieOutbox.filter((i) => i.status !== 'synced').length,
    [dexieOutbox]
  );
  const selectedDeviceProfile = useMemo(
    () => MESH_DEVICES.find((d) => d.peerId === selectedPeerId) || null,
    [selectedPeerId]
  );

  return {
    // Persistent storage & Dexie
    storagePersistence,
    dexieRecordCount,
    // Local folder
    localFolderStatus,
    isFolderBusy,
    selectLocalFolder,
    regrantFolderPermission,
    mirrorNowToFolder,
    restoreFromSelectedFolder,
    saveFallbackToDownloads,
    disconnectLocalFolder,
    // 3-Device PeerJS Mesh
    selectedPeerId,
    selectedDeviceProfile,
    meshPassphrase,
    meshSelfOnline,
    meshSelfError,
    peerStates,
    connectedPeerCount,
    isP2PSyncing,
    vectorClock,
    selectDevicePeerRole,
    updateMeshPassphrase,
    triggerP2PSyncNow,
    // First-launch setup modal
    needsInitialSetup,
    setNeedsInitialSetup,
    dismissInitialSetup,
    // Offline Outbox & PeerJS Audit Event Logs
    dexieOutbox,
    pendingOutboxCount,
    syncEventLogs,
    retryOutboxItem,
    retryAllPendingOutbox,
    clearSyncedOutbox,
    clearAllOutbox,
    refreshOutboxAndLogs,
    clearSyncEventLogs,
    // Interactive & Saved-Default Sync Conflict Resolution
    pendingMeshConflict,
    isResolvingMeshConflict,
    resolvePendingMeshConflict,
    dismissPendingMeshConflict,
  };
}

export type LocalFirstMeshController = ReturnType<typeof useLocalFirstMeshSync>;
