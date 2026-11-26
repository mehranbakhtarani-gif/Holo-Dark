import Peer, { type DataConnection } from 'peerjs';
import {
  MESH_DEVICES,
  type MeshDevicePeerId,
  type MeshSyncEventLog,
  type MeshSyncOutboxItem,
} from './localFolderDexieDb';

// ==================== TYPES ====================

export type PeerLinkStatus = 'connected' | 'connecting' | 'offline' | 'error';

/** Return operation IDs that may be ACKed only after their state was accepted locally. */
export function getAcknowledgableMeshOperationIds(
  operationIds: readonly string[],
  stateApplied: boolean
): string[] | null {
  if (!stateApplied) return null;
  return Array.from(new Set(operationIds.filter((id) => typeof id === 'string' && id.trim().length > 0)));
}

export interface MeshPeerRuntimeState {
  peerId: MeshDevicePeerId;
  shortLabel: string;
  fullLabel: string;
  deviceType: 'laptop' | 'phone';
  status: PeerLinkStatus;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface MeshRelayEnvelope {
  operationId: string;
  originDeviceId: string;
  payloadHash: string;
  snapshotJson: string;
  deliveredToPeers: string[];
  requiredPeers: string[];
  createdAt: string;
  summary: string;
}

/** Replaces compacted relay metadata with a self-consistent full merged snapshot before forwarding. */
export function hydrateCompactedRelayPayload<T extends { snapshotJson?: string; payloadHash: string }>(
  item: T,
  fallbackSnapshotJson: string,
  fallbackPayloadHash: string
): T {
  if (item.snapshotJson && item.snapshotJson.length > 2) return item;
  return {
    ...item,
    snapshotJson: fallbackSnapshotJson,
    payloadHash: fallbackPayloadHash,
  };
}

export interface MeshBatchConfig {
  /** Quiet window (ms) to coalesce consecutive small updates into a single version-vector exchange */
  batchWindowMs: number;
  /** Flush immediately once this many small updates accumulate in the current batch */
  maxBatchSize: number;
  /** Maximum delay (ms) from first queued update before forcing a flush during sustained bursts */
  maxBatchDelayMs: number;
  /** Minimum interval (ms) between duplicate mesh:hello messages with identical hash to the same peer */
  helloMinIntervalMs: number;
}

export const DEFAULT_MESH_BATCH_CONFIG: MeshBatchConfig = {
  batchWindowMs: 3500,
  maxBatchSize: 5,
  maxBatchDelayMs: 10000,
  helloMinIntervalMs: 1500,
};

export interface BatchedUpdateFlushPayload {
  batchedCount: number;
  operationIds: string[];
}

/**
 * Pure adaptive update coalescer that batches rapid small transaction mutations
 * into fewer version-vector exchanges while bounding maximum latency.
 */
export class MeshUpdateBatcher {
  private readonly config: MeshBatchConfig;
  private readonly onFlush: (payload: BatchedUpdateFlushPayload) => void | Promise<void>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOpIds = new Set<string>();
  private pendingCount = 0;
  private disposed = false;

  constructor(
    onFlush: (payload: BatchedUpdateFlushPayload) => void | Promise<void>,
    config?: Partial<MeshBatchConfig>
  ) {
    this.onFlush = onFlush;
    this.config = { ...DEFAULT_MESH_BATCH_CONFIG, ...(config || {}) };
  }

  public enqueue(operationId?: string): void {
    if (this.disposed) return;
    this.pendingCount += 1;
    if (operationId) {
      this.pendingOpIds.add(operationId);
    }

    if (this.pendingCount >= this.config.maxBatchSize) {
      void this.flushNow();
      return;
    }

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flushNow();
    }, this.config.batchWindowMs);

    if (this.maxDelayTimer === null) {
      this.maxDelayTimer = setTimeout(() => {
        void this.flushNow();
      }, this.config.maxBatchDelayMs);
    }
  }

  public flushNow(): BatchedUpdateFlushPayload | null {
    this.clearTimers();
    if (this.disposed || this.pendingCount === 0) return null;
    const payload: BatchedUpdateFlushPayload = {
      batchedCount: this.pendingCount,
      operationIds: Array.from(this.pendingOpIds),
    };
    this.pendingCount = 0;
    this.pendingOpIds.clear();
    void this.onFlush(payload);
    return payload;
  }

  public getPendingCount(): number {
    return this.pendingCount;
  }

  public clear(): void {
    this.clearTimers();
    this.pendingCount = 0;
    this.pendingOpIds.clear();
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxDelayTimer !== null) {
      clearTimeout(this.maxDelayTimer);
      this.maxDelayTimer = null;
    }
  }
}

/**
 * Compacts relay envelopes for a specific remote peer:
 * - Excludes envelopes already delivered to that peer.
 * - Strips redundant full snapshotJson copies when the main payloadHash or a newer envelope
 *   from the same origin already carries that state, keeping only operation metadata for ACKs & relay tracking.
 */
export function compactRelayEnvelopesForPeer(
  envelopes: MeshRelayEnvelope[],
  targetPeerId: MeshDevicePeerId,
  mainPayloadHash: string
): MeshRelayEnvelope[] {
  const undelivered = envelopes.filter(
    (env) => !(env.deliveredToPeers || []).includes(targetPeerId)
  );
  if (undelivered.length === 0) return [];

  // Track the single newest envelope per originDeviceId that still needs an explicit snapshotJson
  const newestIndexByOrigin = new Map<string, number>();
  for (let i = 0; i < undelivered.length; i++) {
    const env = undelivered[i];
    const prevIdx = newestIndexByOrigin.get(env.originDeviceId);
    if (prevIdx === undefined) {
      newestIndexByOrigin.set(env.originDeviceId, i);
    } else if ((env.createdAt || '') > (undelivered[prevIdx].createdAt || '')) {
      newestIndexByOrigin.set(env.originDeviceId, i);
    }
  }

  return undelivered.map((env, idx) => {
    const isNewestForOrigin = newestIndexByOrigin.get(env.originDeviceId) === idx;
    const coveredByMainSnapshot = env.payloadHash === mainPayloadHash;
    // Only keep snapshotJson if this is the newest envelope for a different origin AND not already identical to main payload
    const keepSnapshot = isNewestForOrigin && !coveredByMainSnapshot;
    return {
      ...env,
      snapshotJson: keepSnapshot ? env.snapshotJson : '',
    };
  });
}

export interface VectorExchangeDecision {
  inSync: boolean;
  shouldRequestRemoteState: boolean;
  shouldSendLocalState: boolean;
}

/**
 * Deterministic handshake evaluator that prevents redundant bidirectional full-state pushes
 * when two peers exchange version vectors (`mesh:hello`).
 */
export function evaluateVectorExchangeDecision(params: {
  localClock: Record<string, number>;
  remoteClock: Record<string, number>;
  localHash: string;
  remoteHash: string;
  localPeerId: MeshDevicePeerId;
  remotePeerId: MeshDevicePeerId;
  remotePendingRelayIds: string[];
  localPendingRelayCountForRemote: number;
}): VectorExchangeDecision {
  const {
    localClock,
    remoteClock,
    localHash,
    remoteHash,
    localPeerId,
    remotePeerId,
    remotePendingRelayIds,
    localPendingRelayCountForRemote,
  } = params;

  const allKeys = new Set([
    ...Object.keys(localClock || {}),
    ...Object.keys(remoteClock || {}),
  ]);

  let remoteStrictlyNewer = false;
  let localStrictlyNewer = false;

  for (const key of allKeys) {
    const lv = Number(localClock?.[key] || 0);
    const rv = Number(remoteClock?.[key] || 0);
    if (rv > lv) remoteStrictlyNewer = true;
    if (lv > rv) localStrictlyNewer = true;
  }

  const hashesDiffer = Boolean(localHash && remoteHash && localHash !== remoteHash);
  const remoteHasRelays = remotePendingRelayIds.length > 0;
  const localHasRelays = localPendingRelayCountForRemote > 0;

  if (!hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && !remoteHasRelays && !localHasRelays) {
    return { inSync: true, shouldRequestRemoteState: false, shouldSendLocalState: false };
  }

  // If hashes differ with equal clocks, use deterministic peerId tie-break to avoid double-pushing simultaneously
  const tieBreakLocalInitiates =
    hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && localPeerId < remotePeerId;
  const tieBreakRemoteInitiates =
    hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && remotePeerId < localPeerId;

  return {
    inSync: false,
    shouldRequestRemoteState: remoteStrictlyNewer || remoteHasRelays || tieBreakRemoteInitiates,
    shouldSendLocalState: localStrictlyNewer || localHasRelays || tieBreakLocalInitiates,
  };
}

type MeshWireMessage =
  | {
      type: 'mesh:hello';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      nonce: string;
      issuedAt: string;
      updatedAt: string;
      payloadHash: string;
      vectorClock: Record<string, number>;
      pendingRelayIds: string[];
      batchedCount?: number;
    }
  | {
      type: 'mesh:request_state';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      nonce: string;
      issuedAt: string;
    }
  | {
      type: 'mesh:state_payload';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      nonce: string;
      issuedAt: string;
      updatedAt: string;
      payloadHash: string;
      vectorClock: Record<string, number>;
      snapshotJson: string;
      relayEnvelopes: MeshRelayEnvelope[];
      batchedOperationIds?: string[];
    }
  | {
      type: 'mesh:ack';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      nonce: string;
      issuedAt: string;
      receivedOperationIds: string[];
      payloadHash: string;
      syncedAt: string;
    };

type MeshAuthRecord = Record<string, unknown>;
const MESH_MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const MESH_REPLAY_CACHE_KEY = 'holoo_apex_mesh_replay_nonces_v2';

function createMeshNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isFreshMeshWireMessage(message: MeshAuthRecord, nowMs = Date.now()): boolean {
  if (typeof message.nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(message.nonce)) return false;
  if (typeof message.issuedAt !== 'string') return false;
  const issuedAtMs = Date.parse(message.issuedAt);
  return Number.isFinite(issuedAtMs) && Math.abs(nowMs - issuedAtMs) <= MESH_MAX_MESSAGE_AGE_MS;
}

function loadMeshReplayNonces(): Partial<Record<MeshDevicePeerId, string[]>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MESH_REPLAY_CACHE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Partial<Record<MeshDevicePeerId, string[]>> = {};
    for (const peerId of MESH_DEVICES.map((device) => device.peerId)) {
      const values = (parsed as Record<string, unknown>)[peerId];
      if (Array.isArray(values)) {
        result[peerId] = values.filter((value): value is string =>
          typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)
        ).slice(-256);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistMeshReplayNonce(peerId: MeshDevicePeerId, nonce: string): void {
  try {
    const stored = loadMeshReplayNonces();
    stored[peerId] = [...(stored[peerId] || []).filter((value) => value !== nonce), nonce].slice(-256);
    localStorage.setItem(MESH_REPLAY_CACHE_KEY, JSON.stringify(stored));
  } catch {
    // In-memory replay protection remains active when storage is unavailable.
  }
}


function stableMeshAuthSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableMeshAuthSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableMeshAuthSerialize(record[key])}`).join(',')}}`;
}

export async function deriveMeshAuthKey(passphrase: string): Promise<CryptoKey> {
  const clean = passphrase.trim();
  if (clean.length < 16) throw new Error('Mesh passphrase must contain at least 16 characters.');
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto is unavailable; secure mesh authentication is disabled.');
  const material = await cryptoApi.subtle.importKey(
    'raw', new TextEncoder().encode(clean), 'PBKDF2', false, ['deriveKey']
  );
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('holoo-mesh-p2p-auth-v2'), iterations: 310000, hash: 'SHA-256' },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

export async function signMeshWireMessage(message: MeshAuthRecord, key: CryptoKey): Promise<string> {
  const body = { ...message };
  delete body.authTag;
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(stableMeshAuthSerialize(body))
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyMeshWireMessage(message: MeshAuthRecord, key: CryptoKey): Promise<boolean> {
  const tag = message.authTag;
  if (typeof tag !== 'string' || !/^[0-9a-f]{64}$/i.test(tag)) return false;
  const body = { ...message };
  delete body.authTag;
  const signature = new Uint8Array(tag.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  return globalThis.crypto.subtle.verify(
    'HMAC', key, signature, new TextEncoder().encode(stableMeshAuthSerialize(body))
  );
}

const DEVICE_ROLE_STORAGE_KEY = 'holoo_apex_mesh_device_peer_id_v1';
const MESH_PASSPHRASE_KEY = 'holoo_apex_mesh_passphrase_v1';
const MESH_CLOCK_STORAGE_KEY = 'holoo_apex_mesh_vector_clock_v1';

export function isValidMeshPeerId(val: unknown): val is MeshDevicePeerId {
  return (
    val === 'holoo-mesh-mehran-laptop' ||
    val === 'holoo-mesh-mehran-phone1' ||
    val === 'holoo-mesh-mehran-phone2'
  );
}

export function loadSelectedMeshPeerId(): MeshDevicePeerId | null {
  try {
    const raw = localStorage.getItem(DEVICE_ROLE_STORAGE_KEY);
    return isValidMeshPeerId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveSelectedMeshPeerId(peerId: MeshDevicePeerId): void {
  try {
    localStorage.setItem(DEVICE_ROLE_STORAGE_KEY, peerId);
  } catch {
    // ignore
  }
}

export function loadMeshPassphrase(): string {
  try {
    const raw = localStorage.getItem(MESH_PASSPHRASE_KEY);
    if (raw && raw.trim().length >= 16) return raw.trim();
  } catch {
    // ignore
  }
  return '';
}

export function saveMeshPassphrase(passphrase: string): void {
  try {
    const clean = passphrase.trim();
    if (clean.length >= 16) {
      localStorage.setItem(MESH_PASSPHRASE_KEY, clean);
    }
  } catch {
    // ignore
  }
}

export function loadVectorClock(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MESH_CLOCK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveVectorClock(clock: Record<string, number>): void {
  try {
    localStorage.setItem(MESH_CLOCK_STORAGE_KEY, JSON.stringify(clock));
  } catch {
    // ignore
  }
}

export function getOtherMeshPeerIds(myPeerId: MeshDevicePeerId): MeshDevicePeerId[] {
  return MESH_DEVICES.map((d) => d.peerId).filter((id) => id !== myPeerId);
}


// ==================== PEERJS 3-DEVICE MESH CONTROLLER ====================

export interface MeshSyncCallbacks {
  getLocalSnapshot: () => {
    snapshotJson: string;
    payloadHash: string;
    updatedAt: string;
    vectorClock: Record<string, number>;
  };
  getPendingRelayEnvelopes: () => Promise<MeshRelayEnvelope[]>;
  onRemoteStateReceived: (params: {
    fromPeerId: MeshDevicePeerId;
    snapshotJson: string;
    payloadHash: string;
    vectorClock: Record<string, number>;
    relayEnvelopes: MeshRelayEnvelope[];
    batchedOperationIds?: string[];
  }) => Promise<string[] | null>;
  onPeerAckReceived: (params: {
    fromPeerId: MeshDevicePeerId;
    receivedOperationIds: string[];
    syncedAt: string;
  }) => Promise<void>;
  onStatusChange: (peers: MeshPeerRuntimeState[], selfOnline: boolean, selfError: string | null) => void;
  onSyncEvent?: (event: Omit<MeshSyncEventLog, 'id'>) => void;
}

function resolvePeerShortLabel(peerId: string): string {
  const found = MESH_DEVICES.find((d) => d.peerId === peerId);
  return found ? found.shortLabel : peerId;
}

export class HolooPeerMeshManager {
  private peer: Peer | null = null;
  private connections = new Map<MeshDevicePeerId, DataConnection>();
  private peerStates = new Map<MeshDevicePeerId, MeshPeerRuntimeState>();
  private peerLastAckedHash = new Map<MeshDevicePeerId, string>();
  private peerLastHelloSent = new Map<MeshDevicePeerId, { hash: string; sentAt: number }>();
  private peerLastStateSent = new Map<MeshDevicePeerId, { hash: string; sentAt: number }>();
  private myPeerId: MeshDevicePeerId;
  private authKeyPromise: Promise<CryptoKey> | null;
  private seenMessageNonces = new Map<MeshDevicePeerId, Set<string>>();
  private callbacks: MeshSyncCallbacks;
  private batchConfig: MeshBatchConfig;
  private batcher: MeshUpdateBatcher;
  private lastFlushedBatchOpIds: string[] = [];
  private selfOnline = false;
  private selfError: string | null = null;
  private destroyed = false;
  private reconnectTimer: number | null = null;

  constructor(
    myPeerId: MeshDevicePeerId,
    passphrase: string,
    callbacks: MeshSyncCallbacks,
    batchConfig?: Partial<MeshBatchConfig>
  ) {
    this.myPeerId = myPeerId;
    this.authKeyPromise = passphrase.trim().length >= 16 ? deriveMeshAuthKey(passphrase) : null;
    const replayCache = loadMeshReplayNonces();
    for (const [peerId, nonces] of Object.entries(replayCache) as Array<[MeshDevicePeerId, string[]]>) {
      this.seenMessageNonces.set(peerId, new Set(nonces));
    }
    this.callbacks = callbacks;
    this.batchConfig = { ...DEFAULT_MESH_BATCH_CONFIG, ...(batchConfig || {}) };
    this.batcher = new MeshUpdateBatcher((batch) => {
      void this.announceBatchedVectorToPeers(batch);
    }, this.batchConfig);

    for (const dev of MESH_DEVICES) {
      if (dev.peerId === myPeerId) continue;
      this.peerStates.set(dev.peerId, {
        ...dev,
        status: 'offline',
        lastSeenAt: null,
        lastSyncedAt: null,
        lastError: null,
      });
    }
  }

  public start(): void {
    if (this.destroyed || typeof window === 'undefined') return;
    if (!this.authKeyPromise) {
      this.selfOnline = false;
      this.selfError = 'برای فعال‌سازی P2P، یک کلید مشترک تصادفی با حداقل ۱۶ نویسه در هر سه دستگاه تنظیم کنید.';
      this.emitStatus();
      return;
    }
    if (this.peer && !this.peer.destroyed) return;

    this.selfError = null;
    try {
      const peer = new Peer(this.myPeerId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
          ],
        },
      });

      this.peer = peer;

      peer.on('open', () => {
        if (this.destroyed) return;
        this.selfOnline = true;
        this.selfError = null;
        this.emitStatus();
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'connection_open',
          status: 'success',
          direction: 'local',
          summary: `گره P2P دستگاه «${resolvePeerShortLabel(this.myPeerId)}» به شبکه سیگنالینگ متصل شد؛ آغاز اتصال خودکار به ۲ دستگاه دیگر.`,
        });
        // Automatic "On-Open" P2P connect to the other 2 devices
        this.connectToAllPeers();
      });

      peer.on('connection', (conn) => {
        if (this.destroyed) {
          conn.close();
          return;
        }
        const remoteId = conn.peer;
        if (!isValidMeshPeerId(remoteId) || remoteId === this.myPeerId) {
          this.emitSyncEvent({
            peerId: remoteId || 'unknown',
            eventType: 'auth_rejected',
            status: 'failed',
            direction: 'inbound',
            summary: `اتصال ورودی از شناسه غیرمجاز «${remoteId || 'ناشناس'}» مسدود شد.`,
            errorDetail: 'شناسه در فهرست ۳ دستگاه مجاز شبکه نیست.',
          });
          conn.close();
          return;
        }
        this.attachConnection(remoteId, conn);
      });

      peer.on('disconnected', () => {
        if (this.destroyed) return;
        this.selfOnline = false;
        this.emitStatus();
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'connection_close',
          status: 'info',
          direction: 'local',
          summary: 'ارتباط با سرور سیگنالینگ PeerJS قطع شد؛ تلاش مجدد خودکار زمان‌بندی گردید.',
        });
        this.scheduleReconnect();
      });

      peer.on('error', (err) => {
        if (this.destroyed) return;
        const errType = (err as { type?: string; message?: string })?.type || 'unknown';
        const errMsg = (err as { message?: string })?.message || '';
        if (errType === 'peer-unavailable') {
          // Normal when one of the other 2 devices is currently asleep/offline
          const targetMatch = errMsg.match(/holoo-mesh-[a-z0-9-]+/i);
          const targetPeer = targetMatch ? targetMatch[0] : 'peer';
          this.emitSyncEvent({
            peerId: targetPeer,
            eventType: 'peer_error',
            status: 'failed',
            direction: 'outbound',
            summary: `دستگاه همتا «${resolvePeerShortLabel(targetPeer)}» در حال حاضر آفلاین یا خاموش است؛ تغییرات در صف sync_outbox برای تحویل بعدی (Mesh Relay) نگهداری می‌شوند.`,
            errorDetail: 'peer-unavailable',
          });
          return;
        }
        if (errType === 'unavailable-id') {
          this.selfError = 'این شناسه دستگاه در تب دیگری باز است.';
        } else if (errType === 'network' || errType === 'server-error' || errType === 'socket-error') {
          this.selfOnline = false;
          this.selfError = 'در انتظار اتصال سیگنالینگ P2P (دستگاه آفلاین است یا اینترنت محدود است).';
          this.scheduleReconnect();
        } else {
          this.selfError = `خطای P2P (${errType})`;
        }
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'peer_error',
          status: 'failed',
          direction: 'local',
          summary: this.selfError || `خطای شبکه PeerJS (${errType})`,
          errorDetail: errMsg || errType,
        });
        this.emitStatus();
      });
    } catch (err) {
      this.selfOnline = false;
      this.selfError = 'راه‌اندازی WebRTC P2P در این مرورگر ممکن نشد.';
      this.emitSyncEvent({
        peerId: this.myPeerId,
        eventType: 'peer_error',
        status: 'failed',
        direction: 'local',
        summary: this.selfError,
        errorDetail: err instanceof Error ? err.message : 'WebRTC init error',
      });
      this.emitStatus();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || !navigator.onLine) return;
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.restart();
        }
      } else if (!this.peer || this.peer.destroyed) {
        this.start();
      }
    }, 8000);
  }

  public restart(): void {
    this.stop(false);
    this.destroyed = false;
    this.start();
  }

  public connectToAllPeers(): void {
    if (this.destroyed || !this.peer || this.peer.destroyed || !this.selfOnline) return;
    for (const targetPeerId of getOtherMeshPeerIds(this.myPeerId)) {
      const existing = this.connections.get(targetPeerId);
      if (existing && existing.open) {
        void this.sendHello(existing);
        continue;
      }
      this.updatePeerState(targetPeerId, { status: 'connecting', lastError: null });
      try {
        const conn = this.peer.connect(targetPeerId, {
          reliable: true,
          serialization: 'json',
        });
        this.attachConnection(targetPeerId, conn);
      } catch {
        this.updatePeerState(targetPeerId, { status: 'offline' });
      }
    }
  }

  /**
   * Queues a small local transaction update into the adaptive batcher so rapid bursts
   * coalesce into a single lightweight version-vector (`mesh:hello`) exchange.
   */
  public queueLocalUpdate(operationId?: string): void {
    if (this.destroyed) return;
    this.batcher.enqueue(operationId);
  }

  /**
   * Immediately flushes any buffered transaction updates.
   * When `forceFullBroadcast` is false, sends only a lightweight coalesced version-vector (`mesh:hello`)
   * so peers pull full state only if they are actually behind.
   */
  public async flushBatchedUpdates(forceFullBroadcast = false): Promise<number> {
    if (this.destroyed) return 0;
    const flushed = this.batcher.flushNow();
    if (forceFullBroadcast) {
      return this.broadcastStateToConnectedPeers();
    }
    if (flushed) {
      return this.getConnectedPeerCount();
    }
    return this.announceBatchedVectorToPeers({ batchedCount: 1, operationIds: [] });
  }

  private getConnectedPeerCount(): number {
    let count = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.open) count += 1;
    }
    return count;
  }

  private async announceBatchedVectorToPeers(batch: BatchedUpdateFlushPayload): Promise<number> {
    if (this.destroyed) return 0;
    if (batch.operationIds.length > 0) {
      this.lastFlushedBatchOpIds = Array.from(
        new Set([...this.lastFlushedBatchOpIds, ...batch.operationIds])
      ).slice(-40);
    }

    const local = this.callbacks.getLocalSnapshot();
    const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    let notified = 0;

    for (const [remotePeerId, conn] of this.connections.entries()) {
      if (!conn.open) continue;
      const compactedRelays = compactRelayEnvelopesForPeer(
        pendingRelays,
        remotePeerId,
        local.payloadHash
      );
      const alreadyAcked =
        this.peerLastAckedHash.get(remotePeerId) === local.payloadHash &&
        compactedRelays.length === 0;
      if (alreadyAcked) continue;

      const sent = await this.sendHello(conn, {
        batchedCount: batch.batchedCount,
        force: batch.batchedCount > 1,
      });
      if (sent) notified += 1;
    }

    if (notified > 0 && batch.batchedCount > 1) {
      this.emitSyncEvent({
        peerId: this.myPeerId,
        eventType: 'vector_hello',
        status: 'success',
        direction: 'outbound',
        summary: `${batch.batchedCount} تغییر کوچک در ۱ تبادل بردار نسخه تجمیع (Batch) و به ${notified} همتا ارسال شد.`,
      });
    }

    return notified;
  }

  public async broadcastStateToConnectedPeers(): Promise<number> {
    if (this.destroyed) return 0;
    this.batcher.clear();
    let sent = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.open) {
        const pushed = await this.sendFullState(conn, true);
        if (pushed) sent += 1;
      }
    }
    return sent;
  }

  private async getAuthKey(): Promise<CryptoKey> {
    if (!this.authKeyPromise) throw new Error('Secure mesh passphrase is not configured.');
    return this.authKeyPromise;
  }

  private async createSignedMessage<T extends Record<string, unknown>>(
    body: T
  ): Promise<T & { authTag: string; nonce: string; issuedAt: string }> {
    const key = await this.getAuthKey();
    const signedBody = {
      ...body,
      nonce: createMeshNonce(),
      issuedAt: new Date().toISOString(),
    };
    return { ...signedBody, authTag: await signMeshWireMessage(signedBody, key) };
  }

  private acceptMessageNonce(peerId: MeshDevicePeerId, nonce: string): boolean {
    if (!isFreshMeshWireMessage({ nonce, issuedAt: new Date().toISOString() })) return false;
    const seen = this.seenMessageNonces.get(peerId) || new Set<string>();
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    while (seen.size > 256) {
      const oldest = seen.values().next().value as string | undefined;
      if (!oldest) break;
      seen.delete(oldest);
    }
    this.seenMessageNonces.set(peerId, seen);
    persistMeshReplayNonce(peerId, nonce);
    return true;
  }

  private attachConnection(remotePeerId: MeshDevicePeerId, conn: DataConnection): void {
    const prev = this.connections.get(remotePeerId);
    if (prev && prev !== conn && prev.open) {
      prev.close();
    }
    this.connections.set(remotePeerId, conn);

    conn.on('open', () => {
      if (this.destroyed) return;
      this.updatePeerState(remotePeerId, {
        status: 'connected',
        lastSeenAt: new Date().toISOString(),
        lastError: null,
      });
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'connection_open',
        status: 'success',
        direction: 'outbound',
        summary: `کانال مستقیم WebRTC با «${resolvePeerShortLabel(remotePeerId)}» برقرار شد؛ تبادل بردار نسخه آغاز گردید.`,
      });
      void this.sendHello(conn);
    });

    conn.on('data', (raw) => {
      if (this.destroyed) return;
      void this.handleMessage(remotePeerId, conn, raw);
    });

    conn.on('close', () => {
      if (this.connections.get(remotePeerId) === conn) {
        this.connections.delete(remotePeerId);
        this.updatePeerState(remotePeerId, { status: 'offline' });
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'connection_close',
          status: 'info',
          direction: 'local',
          summary: `اتصال مستقیم P2P با «${resolvePeerShortLabel(remotePeerId)}» بسته شد.`,
        });
      }
    });

    conn.on('error', (err) => {
      if (this.connections.get(remotePeerId) === conn) {
        this.connections.delete(remotePeerId);
        this.updatePeerState(remotePeerId, {
          status: 'offline',
          lastError: 'دستگاه همتا در دسترس نیست',
        });
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'peer_error',
          status: 'failed',
          direction: 'outbound',
          summary: `خطا در کانال ارتباطی با «${resolvePeerShortLabel(remotePeerId)}».`,
          errorDetail: err instanceof Error ? err.message : 'DataConnection error',
        });
      }
    });
  }

  private async sendHello(
    conn: DataConnection,
    opts?: { batchedCount?: number; force?: boolean }
  ): Promise<boolean> {
    if (!conn.open) return false;
    const remotePeerId = conn.peer as MeshDevicePeerId;
    const local = this.callbacks.getLocalSnapshot();
    const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    const relaysForPeer = compactRelayEnvelopesForPeer(
      pendingRelays,
      remotePeerId,
      local.payloadHash
    );

    const nowMs = Date.now();
    const prevHello = this.peerLastHelloSent.get(remotePeerId);
    if (
      !opts?.force &&
      prevHello &&
      prevHello.hash === local.payloadHash &&
      relaysForPeer.length === 0 &&
      nowMs - prevHello.sentAt < this.batchConfig.helloMinIntervalMs
    ) {
      return false;
    }

    const msg: MeshWireMessage = await this.createSignedMessage({
      type: 'mesh:hello',
      fromPeerId: this.myPeerId,
      updatedAt: local.updatedAt,
      payloadHash: local.payloadHash,
      vectorClock: local.vectorClock,
      pendingRelayIds: relaysForPeer.map((r) => r.operationId),
      batchedCount: opts?.batchedCount && opts.batchedCount > 1 ? opts.batchedCount : undefined,
    });
    try {
      conn.send(msg);
      this.peerLastHelloSent.set(remotePeerId, { hash: local.payloadHash, sentAt: nowMs });
      return true;
    } catch (err) {
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: 'vector_hello',
        status: 'failed',
        direction: 'outbound',
        summary: `ارسال بردار نسخه به «${resolvePeerShortLabel(conn.peer)}» ناموفق بود.`,
        errorDetail: err instanceof Error ? err.message : 'send failed',
      });
      return false;
    }
  }

  private async sendFullState(conn: DataConnection, force = false): Promise<boolean> {
    if (!conn.open) return false;
    const remotePeerId = conn.peer as MeshDevicePeerId;
    const local = this.callbacks.getLocalSnapshot();
    const allPendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    const relayEnvelopes = compactRelayEnvelopesForPeer(
      allPendingRelays,
      remotePeerId,
      local.payloadHash
    );

    const nowMs = Date.now();
    const prevSent = this.peerLastStateSent.get(remotePeerId);
    if (
      !force &&
      prevSent &&
      prevSent.hash === local.payloadHash &&
      relayEnvelopes.length === 0 &&
      nowMs - prevSent.sentAt < this.batchConfig.helloMinIntervalMs
    ) {
      return false;
    }

    const batchedOpIds = Array.from(
      new Set([
        ...this.lastFlushedBatchOpIds,
        ...relayEnvelopes.map((r) => r.operationId),
      ])
    );

    const msg: MeshWireMessage = await this.createSignedMessage({
      type: 'mesh:state_payload',
      fromPeerId: this.myPeerId,
      updatedAt: local.updatedAt,
      payloadHash: local.payloadHash,
      vectorClock: local.vectorClock,
      snapshotJson: local.snapshotJson,
      relayEnvelopes,
      batchedOperationIds: batchedOpIds.length > 0 ? batchedOpIds : undefined,
    });
    try {
      conn.send(msg);
      this.peerLastStateSent.set(remotePeerId, { hash: local.payloadHash, sentAt: nowMs });
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: relayEnvelopes.length > 0 ? 'relay_forwarded' : 'state_push',
        status: 'success',
        direction: 'outbound',
        summary:
          relayEnvelopes.length > 0
            ? `بسته وضعیت بهینه‌شده + ${relayEnvelopes.length} عملیات رله صف (Mesh Relay) به «${resolvePeerShortLabel(conn.peer)}» ارسال شد.`
            : `بسته وضعیت پایگاه داده (${batchedOpIds.length > 1 ? `${batchedOpIds.length} تغییر تجمیع‌شده` : 'نسخه جدید'}) به «${resolvePeerShortLabel(conn.peer)}» ارسال شد.`,
      });
      return true;
    } catch (err) {
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: 'state_push',
        status: 'failed',
        direction: 'outbound',
        summary: `ارسال بسته وضعیت به «${resolvePeerShortLabel(conn.peer)}» با خطا متوقف شد.`,
        errorDetail: err instanceof Error ? err.message : 'send state failed',
      });
      return false;
    }
  }

  private async handleMessage(
    remotePeerId: MeshDevicePeerId,
    conn: DataConnection,
    raw: unknown
  ): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as MeshWireMessage;

    // Verify every wire-message field with HMAC-SHA-256; fail closed on tampering.
    const authKey = await this.getAuthKey().catch(() => null);
    const authRecord = msg as unknown as MeshAuthRecord;
    const validSignature = authKey
      ? await verifyMeshWireMessage(authRecord, authKey).catch(() => false)
      : false;
    const freshMessage = isFreshMeshWireMessage(authRecord);
    const unseenNonce = freshMessage && this.acceptMessageNonce(remotePeerId, String(authRecord.nonce));
    if (!validSignature || !freshMessage || !unseenNonce || msg.fromPeerId !== remotePeerId) {
      this.updatePeerState(remotePeerId, {
        status: 'error',
        lastError: 'کلید امنیتی شبکه ۳ دستگاه مطابقت ندارد',
      });
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'auth_rejected',
        status: 'failed',
        direction: 'inbound',
        summary: `تأیید هویت شبکه با «${resolvePeerShortLabel(remotePeerId)}» رد شد — کلید امنیتی مشترک (Passphrase) در دستگاه‌ها یکسان نیست.`,
        errorDetail: 'authTag or peerId mismatch',
      });
      conn.close();
      return;
    }

    const nowIso = new Date().toISOString();
    this.updatePeerState(remotePeerId, { status: 'connected', lastSeenAt: nowIso, lastError: null });

    if (msg.type === 'mesh:hello') {
      const local = this.callbacks.getLocalSnapshot();
      const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
      const localRelaysForRemote = compactRelayEnvelopesForPeer(
        pendingRelays,
        remotePeerId,
        local.payloadHash
      );

      const decision = evaluateVectorExchangeDecision({
        localClock: local.vectorClock,
        remoteClock: msg.vectorClock || {},
        localHash: local.payloadHash,
        remoteHash: msg.payloadHash,
        localPeerId: this.myPeerId,
        remotePeerId,
        remotePendingRelayIds: Array.isArray(msg.pendingRelayIds) ? msg.pendingRelayIds : [],
        localPendingRelayCountForRemote: localRelaysForRemote.length,
      });

      const batchNote =
        msg.batchedCount && msg.batchedCount > 1
          ? ` (تجمیع ${msg.batchedCount} تغییر)`
          : '';

      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'vector_hello',
        status: 'success',
        direction: 'inbound',
        remoteVectorClock: msg.vectorClock || {},
        summary: decision.inSync
          ? `تبادل بردار نسخه با «${resolvePeerShortLabel(remotePeerId)}»${batchNote} موفق بود — هر دو دستگاه کاملاً همگام هستند (بدون ارسال داده اضافی).`
          : `تبادل بردار نسخه با «${resolvePeerShortLabel(remotePeerId)}»${batchNote} انجام شد — تفاوت نسخه شناسایی و همگام‌سازی هدفمند آغاز گردید.`,
      });

      if (decision.inSync) {
        this.peerLastAckedHash.set(remotePeerId, local.payloadHash);
        this.updatePeerState(remotePeerId, { lastSyncedAt: nowIso });
        return;
      }

      if (decision.shouldRequestRemoteState && conn.open) {
        conn.send(await this.createSignedMessage({
          type: 'mesh:request_state',
          fromPeerId: this.myPeerId,
        }));
      }

      if (decision.shouldSendLocalState) {
        await this.sendFullState(conn);
      }
      return;
    }

    if (msg.type === 'mesh:request_state') {
      await this.sendFullState(conn, true);
      return;
    }

    if (msg.type === 'mesh:state_payload') {
      try {
        const receivedOpIds = await this.callbacks.onRemoteStateReceived({
          fromPeerId: remotePeerId,
          snapshotJson: msg.snapshotJson,
          payloadHash: msg.payloadHash,
          vectorClock: msg.vectorClock || {},
          relayEnvelopes: Array.isArray(msg.relayEnvelopes) ? msg.relayEnvelopes : [],
          batchedOperationIds: Array.isArray(msg.batchedOperationIds)
            ? msg.batchedOperationIds
            : undefined,
        });
        if (receivedOpIds === null) {
          this.emitSyncEvent({
            peerId: remotePeerId,
            eventType: 'state_pull',
            status: 'failed',
            direction: 'inbound',
            remoteVectorClock: msg.vectorClock || {},
            summary: `وضعیت دریافتی از «${resolvePeerShortLabel(remotePeerId)}» پذیرفته نشد؛ ACK ارسال نشد و فرستنده باید عملیات را در صف نگه دارد.`,
            errorDetail: 'remote state was not applied',
          });
          return;
        }
        this.peerLastAckedHash.set(remotePeerId, msg.payloadHash);
        this.updatePeerState(remotePeerId, { lastSyncedAt: nowIso });
        if (conn.open) {
          conn.send(await this.createSignedMessage({
            type: 'mesh:ack',
            fromPeerId: this.myPeerId,
            receivedOperationIds: receivedOpIds,
            payloadHash: msg.payloadHash,
            syncedAt: nowIso,
          }));
        }
      } catch (err) {
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'state_pull',
          status: 'failed',
          direction: 'inbound',
          remoteVectorClock: msg.vectorClock || {},
          summary: `ادغام بسته دریافتی از «${resolvePeerShortLabel(remotePeerId)}» با خطا مواجه شد.`,
          errorDetail: err instanceof Error ? err.message : 'merge failed',
        });
      }
      return;
    }

    if (msg.type === 'mesh:ack') {
      if (msg.payloadHash) {
        this.peerLastAckedHash.set(remotePeerId, msg.payloadHash);
      }
      this.updatePeerState(remotePeerId, { lastSyncedAt: msg.syncedAt || nowIso });
      const opIds = Array.isArray(msg.receivedOperationIds) ? msg.receivedOperationIds : [];
      if (opIds.length > 0) {
        const ackedSet = new Set(opIds);
        this.lastFlushedBatchOpIds = this.lastFlushedBatchOpIds.filter((id) => !ackedSet.has(id));
      }
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'ack_received',
        status: 'success',
        direction: 'inbound',
        summary: `تایید تحویل (ACK) از «${resolvePeerShortLabel(remotePeerId)}» دریافت شد (${opIds.length} عملیات صف تسویه گردید).`,
      });
      await this.callbacks.onPeerAckReceived({
        fromPeerId: remotePeerId,
        receivedOperationIds: opIds,
        syncedAt: msg.syncedAt || nowIso,
      });
    }
  }

  private emitSyncEvent(
    partial: Omit<MeshSyncEventLog, 'id' | 'eventId' | 'timestamp' | 'peerLabel' | 'localVectorClock'> & {
      localVectorClock?: Record<string, number>;
    }
  ): void {
    if (!this.callbacks.onSyncEvent) return;
    const localClock = partial.localVectorClock || this.callbacks.getLocalSnapshot().vectorClock;
    this.callbacks.onSyncEvent({
      eventId: `mevt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      peerLabel: resolvePeerShortLabel(partial.peerId),
      localVectorClock: { ...localClock },
      ...partial,
    });
  }

  private updatePeerState(peerId: MeshDevicePeerId, patch: Partial<MeshPeerRuntimeState>): void {
    const existing = this.peerStates.get(peerId);
    if (!existing) return;
    this.peerStates.set(peerId, { ...existing, ...patch });
    this.emitStatus();
  }

  private emitStatus(): void {
    this.callbacks.onStatusChange(
      Array.from(this.peerStates.values()),
      this.selfOnline,
      this.selfError
    );
  }

  public getPeerStates(): MeshPeerRuntimeState[] {
    return Array.from(this.peerStates.values());
  }

  public stop(markDestroyed = true): void {
    if (markDestroyed) {
      this.destroyed = true;
      this.batcher.dispose();
    } else {
      this.batcher.clear();
    }
    this.peerLastAckedHash.clear();
    this.peerLastHelloSent.clear();
    this.peerLastStateSent.clear();
    this.lastFlushedBatchOpIds = [];
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, conn] of this.connections.entries()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }
    this.selfOnline = false;
  }
}

/** Named alias fulfilling the explicit PeerMeshConnector module specification */
export class PeerMeshConnector extends HolooPeerMeshManager {}

export function buildRelayEnvelopesFromOutbox(
  items: MeshSyncOutboxItem[],
  currentSnapshotJson: string
): MeshRelayEnvelope[] {
  return items
    .filter((item) => item.target === 'p2p_mesh' && item.status !== 'synced')
    .slice(0, 15)
    .map((item) => ({
      operationId: item.operationId,
      originDeviceId: item.originDeviceId,
      payloadHash: item.payloadHash,
      snapshotJson: item.snapshotJson || currentSnapshotJson,
      deliveredToPeers: item.deliveredToPeers || [],
      requiredPeers: item.requiredPeers || [],
      createdAt: item.createdAt,
      summary: item.summary,
    }));
}
