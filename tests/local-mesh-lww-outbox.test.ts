import assert from 'node:assert/strict';
import {
  mergeWorkspacesDeterministicLWW,
  isAuthorizedOutboxPeerAck,
  SYNCABLE_WORKSPACE_COLLECTIONS,
  MESH_DEVICES,
  safeParseJsonObject,
  tagSnapshotWithSyncMetadata,
  type MeshSyncOutboxItem,
} from '../src/lib/localFolderDexieDb';
import {
  buildRelayEnvelopesFromOutbox,
  compactRelayEnvelopesForPeer,
  computeMeshAuthTag,
  evaluateVectorExchangeDecision,
  getAcknowledgableMeshOperationIds,
  getOtherMeshPeerIds,
  HolooPeerMeshManager,
  isValidMeshPeerId,
  MeshUpdateBatcher,
  PeerMeshConnector,
  type BatchedUpdateFlushPayload,
  type MeshRelayEnvelope,
} from '../src/lib/p2pMeshSync';

let passed = 0;

function runTest(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

runTest('1. tagSnapshotWithSyncMetadata stamps uuid, deviceId, updatedAt, isDeleted without mutating financials', () => {
  const raw = JSON.stringify({
    profile: { companyName: 'پارس نخ مهران', fiscalYear: '1404', currencyUnit: 'IRT' },
    vouchers: [{ id: 'v1', number: 101, totalDebit: 25000000, totalCredit: 25000000 }],
    invoices: [{ id: 'inv1', grandTotal: 18500000 }],
    products: [{ id: 'p1', name: 'نخ پلی‌استر ۳۰۰', stockKg: 420 }],
  });

  const tagged = tagSnapshotWithSyncMetadata(
    raw,
    'holoo-mesh-mehran-laptop',
    '2026-11-24T10:00:00.000Z'
  );
  const parsed = JSON.parse(tagged);

  assert.equal(parsed.vouchers[0].id, 'v1');
  assert.equal(parsed.vouchers[0].uuid, 'v1');
  assert.equal(parsed.vouchers[0].deviceId, 'holoo-mesh-mehran-laptop');
  assert.equal(parsed.vouchers[0].updatedAt, '2026-11-24T10:00:00.000Z');
  assert.equal(parsed.vouchers[0].isDeleted, false);
  assert.equal(parsed.vouchers[0].totalDebit, 25000000);
  assert.equal(parsed.invoices[0].grandTotal, 18500000);
  assert.equal(parsed.products[0].stockKg, 420);
  assert.equal(parsed._meshSyncMeta.originDeviceId, 'holoo-mesh-mehran-laptop');
});

runTest('2. tracked warehouse transfers are included in mesh sync and receipt updates converge by LWW', () => {
  assert.equal(SYNCABLE_WORKSPACE_COLLECTIONS.includes('trackedWarehouseTransfers'), true);
  const legacyTagged = JSON.parse(tagSnapshotWithSyncMetadata(
    JSON.stringify({ trackedWarehouseTransfers: [{ id: 'tr_legacy', date: '1405/09/05', status: 'in_transit' }] }),
    'holoo-mesh-mehran-laptop',
    '2026-11-26T10:00:00.000Z'
  ));
  assert.equal(legacyTagged.trackedWarehouseTransfers[0].updatedAt, '1970-01-01T00:00:00.000Z');

  const dispatch = {
    id: 'tr_mesh_001',
    uuid: 'tr_mesh_001',
    deviceId: 'holoo-mesh-mehran-laptop',
    updatedAt: '2026-11-26T10:00:00.000Z',
    isDeleted: false,
    transferNumber: 'TR-001',
    productId: 'product_1',
    fromWarehouse: 'انبار مرکزی',
    toWarehouse: 'انبار شعبه',
    qty: 12,
    transferredCostIrr: 960000,
    transferredLayers: [{ layerId: 'tr_layer_1', remainingQty: 12, totalCostIrr: 960000 }],
    status: 'in_transit',
  };
  const received = {
    ...dispatch,
    deviceId: 'holoo-mesh-mehran-phone1',
    updatedAt: '2026-11-26T10:15:00.000Z',
    status: 'received',
    receivedDate: '1405/09/05',
    receivedEventSequence: 42,
    receivedEventSequenceSource: 'sync',
  };

  const laptopSnapshot = JSON.stringify({ trackedWarehouseTransfers: [dispatch] });
  const phoneSnapshot = JSON.stringify({ trackedWarehouseTransfers: [received] });
  const laptopThenPhone = mergeWorkspacesDeterministicLWW(
    laptopSnapshot,
    phoneSnapshot,
    'holoo-mesh-mehran-laptop'
  );
  const phoneThenLaptop = mergeWorkspacesDeterministicLWW(
    phoneSnapshot,
    laptopSnapshot,
    'holoo-mesh-mehran-phone1'
  );
  const resultA = JSON.parse(laptopThenPhone.mergedSnapshotJson);
  const resultB = JSON.parse(phoneThenLaptop.mergedSnapshotJson);

  assert.equal(resultA.trackedWarehouseTransfers.length, 1);
  assert.equal(resultB.trackedWarehouseTransfers.length, 1);
  assert.equal(resultA.trackedWarehouseTransfers[0].status, 'received');
  assert.equal(resultB.trackedWarehouseTransfers[0].status, 'received');
  assert.equal(resultA.trackedWarehouseTransfers[0].receivedEventSequence, 42);
  assert.equal(resultB.trackedWarehouseTransfers[0].receivedEventSequence, 42);
  assert.equal(resultA.trackedWarehouseTransfers[0].transferredCostIrr, 960000);
  assert.equal(resultB.trackedWarehouseTransfers[0].transferredCostIrr, 960000);
});

runTest('3. mergeWorkspacesDeterministicLWW converges deterministically across 3 devices (order-independent)', () => {
  const laptopSnap = JSON.stringify({
    profile: { companyName: 'پارس نخ مهران', updatedAt: '2026-11-24T10:00:00.000Z' },
    vouchers: [
      {
        id: 'v1',
        uuid: 'v1',
        deviceId: 'holoo-mesh-mehran-laptop',
        updatedAt: '2026-11-24T10:00:00.000Z',
        isDeleted: false,
        description: 'نسخه قدیمی لپ‌تاپ',
      },
      {
        id: 'v_laptop_only',
        uuid: 'v_laptop_only',
        deviceId: 'holoo-mesh-mehran-laptop',
        updatedAt: '2026-11-24T10:05:00.000Z',
        isDeleted: false,
        description: 'سند جدید لپ‌تاپ',
      },
    ],
    products: [
      {
        id: 'p_del',
        uuid: 'p_del',
        deviceId: 'holoo-mesh-mehran-laptop',
        updatedAt: '2026-11-24T09:00:00.000Z',
        isDeleted: false,
        name: 'کالای آزمایشی',
      },
    ],
  });

  const phone1Snap = JSON.stringify({
    profile: { companyName: 'پارس نخ مهران (آپدیت موبایل)', updatedAt: '2026-11-24T10:12:00.000Z' },
    vouchers: [
      {
        id: 'v1',
        uuid: 'v1',
        deviceId: 'holoo-mesh-mehran-phone1',
        updatedAt: '2026-11-24T10:10:00.000Z',
        isDeleted: false,
        description: 'نسخه جدیدتر موبایل من',
      },
      {
        id: 'v_phone1_only',
        uuid: 'v_phone1_only',
        deviceId: 'holoo-mesh-mehran-phone1',
        updatedAt: '2026-11-24T10:11:00.000Z',
        isDeleted: false,
        description: 'سند موبایل من',
      },
    ],
    products: [
      {
        id: 'p_del',
        uuid: 'p_del',
        deviceId: 'holoo-mesh-mehran-phone1',
        updatedAt: '2026-11-24T10:15:00.000Z',
        isDeleted: true,
        name: 'کالای آزمایشی',
      },
    ],
  });

  const ab = mergeWorkspacesDeterministicLWW(laptopSnap, phone1Snap, 'holoo-mesh-mehran-laptop');
  const ba = mergeWorkspacesDeterministicLWW(phone1Snap, laptopSnap, 'holoo-mesh-mehran-phone1');

  const parsedAB = JSON.parse(ab.mergedSnapshotJson);
  const parsedBA = JSON.parse(ba.mergedSnapshotJson);

  assert.equal(ab.changed, true);
  assert.equal(ab.addedCount >= 1, true);
  assert.equal(ab.updatedCount >= 1, true);
  assert.equal(ab.deletedCount, 1);

  // Newer timestamp wins for v1 on both sides
  const v1AB = parsedAB.vouchers.find((v: { id: string }) => v.id === 'v1');
  const v1BA = parsedBA.vouchers.find((v: { id: string }) => v.id === 'v1');
  assert.equal(v1AB.description, 'نسخه جدیدتر موبایل من');
  assert.equal(v1BA.description, 'نسخه جدیدتر موبایل من');

  // Both sides retain all non-deleted records from both devices
  assert.equal(parsedAB.vouchers.length, 3);
  assert.equal(parsedBA.vouchers.length, 3);

  // Tombstoned product is removed on both sides
  assert.equal(parsedAB.products.length, 0);
  assert.equal(parsedBA.products.length, 0);

  // Profile LWW converged
  assert.equal(parsedAB.profile.companyName, 'پارس نخ مهران (آپدیت موبایل)');
  assert.equal(parsedBA.profile.companyName, 'پارس نخ مهران (آپدیت موبایل)');
});

runTest('3b. LWW merge converges when same-device writes share an identical timestamp', () => {
  const timestamp = '2026-11-26T12:00:00.000Z';
  const deviceId = 'holoo-mesh-mehran-phone1';
  const makeSnapshot = (description: string) => JSON.stringify({
    vouchers: [{
      id: 'same-ms-voucher',
      uuid: 'same-ms-voucher',
      deviceId,
      updatedAt: timestamp,
      isDeleted: false,
      description,
    }],
  });
  const alpha = makeSnapshot('alpha');
  const zeta = makeSnapshot('zeta');
  const alphaThenZeta = mergeWorkspacesDeterministicLWW(alpha, zeta, deviceId);
  const zetaThenAlpha = mergeWorkspacesDeterministicLWW(zeta, alpha, deviceId);
  const recordA = JSON.parse(alphaThenZeta.mergedSnapshotJson).vouchers[0];
  const recordB = JSON.parse(zetaThenAlpha.mergedSnapshotJson).vouchers[0];
  assert.equal(recordA.description, 'zeta');
  assert.deepEqual(recordA, recordB);
});

runTest('3d. remote mesh operations are ACKed only after local state application succeeds', () => {
  const operationIds = ['op-1', 'op-2', 'op-1', ''];
  assert.equal(getAcknowledgableMeshOperationIds(operationIds, false), null);
  assert.deepEqual(getAcknowledgableMeshOperationIds(operationIds, true), ['op-1', 'op-2']);
});

runTest('3c. outbox ACKs are accepted only from required P2P peers', () => {
  const p2pItem = {
    target: 'p2p_mesh' as const,
    requiredPeers: ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2'],
  };
  const folderItem = {
    target: 'local_folder' as const,
    requiredPeers: [],
  };

  assert.equal(isAuthorizedOutboxPeerAck(p2pItem, 'holoo-mesh-mehran-phone1'), true);
  assert.equal(isAuthorizedOutboxPeerAck(p2pItem, 'holoo-mesh-mehran-laptop'), false);
  assert.equal(isAuthorizedOutboxPeerAck(folderItem, 'holoo-mesh-mehran-phone1'), false);
  assert.equal(isAuthorizedOutboxPeerAck({ target: 'p2p_mesh', requiredPeers: [] }, 'holoo-mesh-mehran-phone2'), false);
});

runTest('4. safeParseJsonObject strips prototype pollution payloads', () => {
  const malicious = '{"__proto__":{"polluted":true},"constructor":{"bad":1},"safe":42}';
  const parsed = safeParseJsonObject(malicious);
  assert.ok(parsed);
  assert.equal(parsed.safe, 42);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'constructor'), false);
});

runTest('5. 3-device Peer ID allowlist & authTag validation', () => {
  assert.equal(MESH_DEVICES.length, 3);
  assert.equal(isValidMeshPeerId('holoo-mesh-mehran-laptop'), true);
  assert.equal(isValidMeshPeerId('holoo-mesh-mehran-phone1'), true);
  assert.equal(isValidMeshPeerId('holoo-mesh-mehran-phone2'), true);
  assert.equal(isValidMeshPeerId('evil-attacker-peer'), false);
  assert.equal(isValidMeshPeerId(''), false);

  const others = getOtherMeshPeerIds('holoo-mesh-mehran-laptop');
  assert.deepEqual(others, ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2']);

  const tagA = computeMeshAuthTag('secret-mesh-pass');
  const tagB = computeMeshAuthTag('secret-mesh-pass');
  const tagC = computeMeshAuthTag('different-pass');
  assert.equal(tagA, tagB);
  assert.notEqual(tagA, tagC);
});

runTest('6. buildRelayEnvelopesFromOutbox selects only pending p2p_mesh operations for relay', () => {
  const sampleItems: MeshSyncOutboxItem[] = [
    {
      operationId: 'op_pending_p2p',
      target: 'p2p_mesh',
      originDeviceId: 'holoo-mesh-mehran-laptop',
      summary: 'سند جدید',
      payloadHash: 'h1',
      snapshotJson: '{"vouchers":[]}',
      deliveredToPeers: ['holoo-mesh-mehran-phone1'],
      requiredPeers: ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2'],
      status: 'pending',
      retryCount: 0,
      voucherCount: 1,
      invoiceCount: 0,
      productCount: 0,
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:00:00.000Z',
    },
    {
      operationId: 'op_synced_p2p',
      target: 'p2p_mesh',
      originDeviceId: 'holoo-mesh-mehran-laptop',
      summary: 'سند تحویل‌شده',
      payloadHash: 'h2',
      deliveredToPeers: ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2'],
      requiredPeers: ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2'],
      status: 'synced',
      retryCount: 0,
      voucherCount: 1,
      invoiceCount: 0,
      productCount: 0,
      createdAt: '2026-11-24T09:00:00.000Z',
      updatedAt: '2026-11-24T09:00:00.000Z',
    },
    {
      operationId: 'op_folder_only',
      target: 'local_folder',
      originDeviceId: 'holoo-mesh-mehran-laptop',
      summary: 'صف پوشه محلی',
      payloadHash: 'h3',
      deliveredToPeers: [],
      requiredPeers: [],
      status: 'pending',
      retryCount: 0,
      voucherCount: 1,
      invoiceCount: 0,
      productCount: 0,
      createdAt: '2026-11-24T10:01:00.000Z',
      updatedAt: '2026-11-24T10:01:00.000Z',
    },
  ];

  const envelopes = buildRelayEnvelopesFromOutbox(sampleItems, '{"fallback":true}');
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].operationId, 'op_pending_p2p');
  assert.deepEqual(envelopes[0].deliveredToPeers, ['holoo-mesh-mehran-phone1']);
  assert.deepEqual(envelopes[0].requiredPeers, [
    'holoo-mesh-mehran-phone1',
    'holoo-mesh-mehran-phone2',
  ]);
});

runTest('7. PeerMeshConnector is exported and extends HolooPeerMeshManager', () => {
  assert.equal(typeof PeerMeshConnector, 'function');
  assert.equal(Object.getPrototypeOf(PeerMeshConnector), HolooPeerMeshManager);
});

runTest('8. MeshUpdateBatcher coalesces bursts of small updates into fewer flushes and enforces maxBatchSize', () => {
  const flushes: BatchedUpdateFlushPayload[] = [];
  const batcher = new MeshUpdateBatcher(
    (payload) => {
      flushes.push(payload);
    },
    { batchWindowMs: 5000, maxBatchSize: 4, maxBatchDelayMs: 10000 }
  );

  // Enqueue 3 small transaction updates — should remain buffered (0 exchanges so far)
  batcher.enqueue('op_1');
  batcher.enqueue('op_2');
  batcher.enqueue('op_3');
  assert.equal(flushes.length, 0);
  assert.equal(batcher.getPendingCount(), 3);

  // 4th update hits maxBatchSize -> triggers 1 single coalesced flush containing all 4 opIds
  batcher.enqueue('op_4');
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].batchedCount, 4);
  assert.deepEqual(flushes[0].operationIds, ['op_1', 'op_2', 'op_3', 'op_4']);
  assert.equal(batcher.getPendingCount(), 0);

  // Enqueue 2 more and force manual flush (e.g. pagehide / instant sync)
  batcher.enqueue('op_5');
  batcher.enqueue('op_6');
  const manual = batcher.flushNow();
  assert.ok(manual);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1].batchedCount, 2);
  assert.deepEqual(flushes[1].operationIds, ['op_5', 'op_6']);

  batcher.dispose();
});

runTest('8. compactRelayEnvelopesForPeer drops already-delivered peers and strips duplicate snapshotJson payloads', () => {
  const largeSnap = JSON.stringify({ vouchers: Array.from({ length: 20 }, (_, i) => ({ id: `v_${i}` })) });
  const envelopes: MeshRelayEnvelope[] = [
    {
      operationId: 'op_already_delivered',
      originDeviceId: 'holoo-mesh-mehran-laptop',
      payloadHash: 'hash_old',
      snapshotJson: largeSnap,
      deliveredToPeers: ['holoo-mesh-mehran-phone1'],
      requiredPeers: ['holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2'],
      createdAt: '2026-11-24T10:00:00.000Z',
      summary: 'delivered to phone1',
    },
    {
      operationId: 'op_superseded',
      originDeviceId: 'holoo-mesh-mehran-phone2',
      payloadHash: 'hash_p2_v1',
      snapshotJson: largeSnap,
      deliveredToPeers: [],
      requiredPeers: ['holoo-mesh-mehran-phone1'],
      createdAt: '2026-11-24T10:01:00.000Z',
      summary: 'older phone2 update',
    },
    {
      operationId: 'op_newest_phone2',
      originDeviceId: 'holoo-mesh-mehran-phone2',
      payloadHash: 'hash_p2_v2',
      snapshotJson: largeSnap,
      deliveredToPeers: [],
      requiredPeers: ['holoo-mesh-mehran-phone1'],
      createdAt: '2026-11-24T10:02:00.000Z',
      summary: 'newest phone2 update',
    },
    {
      operationId: 'op_matches_main_hash',
      originDeviceId: 'holoo-mesh-mehran-laptop',
      payloadHash: 'hash_main_latest',
      snapshotJson: largeSnap,
      deliveredToPeers: [],
      requiredPeers: ['holoo-mesh-mehran-phone1'],
      createdAt: '2026-11-24T10:03:00.000Z',
      summary: 'already inside main snapshot',
    },
  ];

  const compacted = compactRelayEnvelopesForPeer(
    envelopes,
    'holoo-mesh-mehran-phone1',
    'hash_main_latest'
  );

  // op_already_delivered excluded; 3 remain
  assert.equal(compacted.length, 3);
  assert.equal(compacted.some((e) => e.operationId === 'op_already_delivered'), false);

  // Superseded older envelope and main-hash-matching envelope have empty snapshotJson (zero duplicate bytes!)
  const superseded = compacted.find((e) => e.operationId === 'op_superseded')!;
  const newestP2 = compacted.find((e) => e.operationId === 'op_newest_phone2')!;
  const mainMatch = compacted.find((e) => e.operationId === 'op_matches_main_hash')!;

  assert.equal(superseded.snapshotJson, '');
  assert.equal(mainMatch.snapshotJson, '');
  assert.equal(newestP2.snapshotJson, largeSnap);
});

runTest('9. evaluateVectorExchangeDecision avoids redundant full-state pushes when in sync or one-sided', () => {
  // Identical state -> zero network traffic
  const synced = evaluateVectorExchangeDecision({
    localClock: { 'holoo-mesh-mehran-laptop': 5 },
    remoteClock: { 'holoo-mesh-mehran-laptop': 5 },
    localHash: 'h_same',
    remoteHash: 'h_same',
    localPeerId: 'holoo-mesh-mehran-laptop',
    remotePeerId: 'holoo-mesh-mehran-phone1',
    remotePendingRelayIds: [],
    localPendingRelayCountForRemote: 0,
  });
  assert.deepEqual(synced, {
    inSync: true,
    shouldRequestRemoteState: false,
    shouldSendLocalState: false,
  });

  // Only local is ahead -> push local state without requesting stale remote state
  const localAhead = evaluateVectorExchangeDecision({
    localClock: { 'holoo-mesh-mehran-laptop': 6, 'holoo-mesh-mehran-phone1': 2 },
    remoteClock: { 'holoo-mesh-mehran-laptop': 5, 'holoo-mesh-mehran-phone1': 2 },
    localHash: 'h_new',
    remoteHash: 'h_old',
    localPeerId: 'holoo-mesh-mehran-laptop',
    remotePeerId: 'holoo-mesh-mehran-phone1',
    remotePendingRelayIds: [],
    localPendingRelayCountForRemote: 0,
  });
  assert.deepEqual(localAhead, {
    inSync: false,
    shouldRequestRemoteState: false,
    shouldSendLocalState: true,
  });

  // Only remote is ahead -> request remote state without redundantly pushing stale local state
  const remoteAhead = evaluateVectorExchangeDecision({
    localClock: { 'holoo-mesh-mehran-laptop': 5, 'holoo-mesh-mehran-phone1': 2 },
    remoteClock: { 'holoo-mesh-mehran-laptop': 5, 'holoo-mesh-mehran-phone1': 4 },
    localHash: 'h_old',
    remoteHash: 'h_remote_new',
    localPeerId: 'holoo-mesh-mehran-laptop',
    remotePeerId: 'holoo-mesh-mehran-phone1',
    remotePendingRelayIds: [],
    localPendingRelayCountForRemote: 0,
  });
  assert.deepEqual(remoteAhead, {
    inSync: false,
    shouldRequestRemoteState: true,
    shouldSendLocalState: false,
  });
});

console.log(`\nAll ${passed} local-mesh LWW & outbox tests passed!`);
