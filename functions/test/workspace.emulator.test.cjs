const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { deleteApp, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'elaborate-hash-368613';
const AUTH_EMULATOR = process.env.AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FUNCTIONS_EMULATOR = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const FIRESTORE_EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const DATABASE_ID = 'ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b';
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR;
const adminApp = initializeApp({ projectId: PROJECT_ID }, 'workspace-migration-emulator-test');
const firestore = getFirestore(adminApp, DATABASE_ID);
test.after(async () => { await firestore.terminate(); await deleteApp(adminApp); });
const API_KEY = 'fake-api-key';
const base = `http://${FUNCTIONS_EMULATOR}/${PROJECT_ID}/us-central1`;

async function createVerifiedUser(label, verify = true) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = 'Test-password-123!';
  const signup = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const signupText = await signup.text();
  assert.equal(signup.ok, true, signupText);
  const created = JSON.parse(signupText);
  if (!verify) return { email, password, uid: created.localId, token: created.idToken };
  await getAuth(adminApp).updateUser(created.localId, { emailVerified: true });
  // Mint a fresh ID token after the verification mutation so the email_verified
  // claim presented to callable functions reflects the updated Auth user record.
  const signedIn = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const signedInText = await signedIn.text();
  assert.equal(signedIn.ok, true, signedInText);
  const freshToken = JSON.parse(signedInText);
  return { email, password, uid: freshToken.localId, token: freshToken.idToken };
}

async function refreshUserToken(user) {
  const response = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password, returnSecureToken: true }),
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  user.token = JSON.parse(body).idToken;
  return user;
}

async function call(name, token, data = {}) {
  const response = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `Callable ${name} failed`);
    error.status = payload.error?.status;
    throw error;
  }
  return payload.result;
}


function stableTestValue(value) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value && typeof value.toMillis === 'function') return { __timestamp: value.toMillis() };
  if (Array.isArray(value)) return value.map(stableTestValue);
  if (typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stableTestValue(value[key]); return out; }, {});
  return String(value);
}

async function expectCallableError(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    return true;
  });
}

test('offline invoice creates receive a server inventory sequence exactly once', async () => {
  const owner = await createVerifiedUser('offline-invoice-sequence');
  const counterRef = firestore.collection('counters').doc(owner.uid);
  await counterRef.set({
    ownerId: owner.uid,
    lastVoucherNumber: 4,
    lastInvoiceSeq: 102,
    lastInventorySequence: 40,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  const invoiceBase = (invoiceNumber) => ({
    ownerId: owner.uid,
    invoiceNumber,
    invoiceType: 'sale',
    date: '1405/08/10',
    partyId: 'party-offline',
    partyName: 'Offline test customer',
    warehouse: 'انبار مرکزی',
    subtotal: 100,
    discount: 0,
    vatAmount: 0,
    grandTotal: 100,
    paidCash: 100,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 0,
    status: 'issued',
    items: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  const invoiceRefs = [
    firestore.collection('invoices').doc(`offline-seq-a-${owner.uid}`),
    firestore.collection('invoices').doc(`offline-seq-b-${owner.uid}`),
  ];
  await Promise.all(invoiceRefs.map((ref, index) => ref.set(invoiceBase(`OFFLINE-${index}`))));

  const waitForSequence = async (ref) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snap = await ref.get();
      if (Number.isSafeInteger(snap.get('eventSequence'))) return snap.get('eventSequence');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Offline invoice sequence was not assigned by the Firestore trigger');
  };
  const sequences = await Promise.all(invoiceRefs.map(waitForSequence));
  assert.deepEqual([...sequences].sort((a, b) => a - b), [41, 42]);
  assert.equal((await invoiceRefs[0].get()).get('eventSequenceSource'), 'sync');
  assert.equal((await invoiceRefs[1].get()).get('eventSequenceSource'), 'sync');
  const counterAfter = await counterRef.get();
  assert.equal(counterAfter.get('lastInventorySequence'), 42);

  // An online-committed invoice already has a sequence and must not consume another number.
  const onlineRef = firestore.collection('invoices').doc(`online-seq-${owner.uid}`);
  await onlineRef.set({ ...invoiceBase('ONLINE'), eventSequence: 50 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await onlineRef.get()).get('eventSequence'), 50);
  assert.equal((await counterRef.get()).get('lastInventorySequence'), 42);
});

test('workspace provisioning, invitation, owner-only RBAC and revocation', async () => {
  const owner = await createVerifiedUser('owner');
  const ownerWorkspace = await call('bootstrapWorkspace', owner.token);
  assert.equal(ownerWorkspace.workspaceId, owner.uid);
  await call('bootstrapWorkspace', owner.token); // idempotent owner bootstrap
  await refreshUserToken(owner);

  const invitee = await createVerifiedUser('invitee');
  const wrongEmail = await createVerifiedUser('wrong');
  const unverified = await createVerifiedUser('unverified', false);
  const invitation = await call('createWorkspaceInvitation', owner.token, {
    email: invitee.email, role: 'accountant',
  });
  assert.ok(invitation.invitationToken);
  await expectCallableError(
    call('acceptWorkspaceInvitation', wrongEmail.token, { invitationToken: invitation.invitationToken }),
    'PERMISSION_DENIED',
  );
  await expectCallableError(
    call('acceptWorkspaceInvitation', unverified.token, { invitationToken: invitation.invitationToken }),
    'PERMISSION_DENIED',
  );
  await expectCallableError(
    call('acceptWorkspaceInvitation', invitee.token, { invitationToken: 'invalid-token-value-that-is-long-enough-123456' }),
    'NOT_FOUND',
  );

  const staleInviteeToken = invitee.token;
  const acceptResults = await Promise.all([
    call('acceptWorkspaceInvitation', invitee.token, { invitationToken: invitation.invitationToken }),
    call('acceptWorkspaceInvitation', invitee.token, { invitationToken: invitation.invitationToken }),
  ]);
  assert.ok(acceptResults.every((result) => result.workspaceId === owner.uid));
  await refreshUserToken(invitee);
  await expectCallableError(call('bootstrapWorkspace', staleInviteeToken), 'ALREADY_EXISTS');

  const members = await call('listWorkspaceMembers', owner.token);
  assert.equal(members.members.length, 2);
  assert.ok(members.members.some((member) => member.uid === invitee.uid && member.role === 'accountant' && member.active));

  await expectCallableError(call('listWorkspaceMembers', invitee.token), 'PERMISSION_DENIED');
  await expectCallableError(call('listWorkspaceStagedRecords', invitee.token, { collection: 'products' }), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: owner.uid, role: 'finance_manager' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'owner' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'root_admin' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('revokeWorkspaceMember', invitee.token, { uid: owner.uid }), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', invitee.token, { uid: owner.uid, role: 'accountant' }), 'PERMISSION_DENIED');

  await call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'warehouse_keeper' });
  const changed = await call('listWorkspaceMembers', owner.token);
  assert.equal(changed.members.find((member) => member.uid === invitee.uid).role, 'warehouse_keeper');

  const ownerAccountId = `migration-owner-${owner.uid}`;
  const foreignAccountId = `migration-foreign-${wrongEmail.uid}`;
  const createdAt = Timestamp.now();
  await firestore.collection('accounts').doc(ownerAccountId).set({
    ownerId: owner.uid, code: '99101', title: 'Migration fixture owner account',
    level: 'kol', category: 'asset', nature: 'debit', isSystem: false,
    createdAt, updatedAt: createdAt,
  });
  await firestore.collection('accounts').doc(foreignAccountId).set({
    ownerId: wrongEmail.uid, code: '99102', title: 'Foreign tenant fixture',
    level: 'kol', category: 'asset', nature: 'debit', isSystem: false,
    createdAt, updatedAt: createdAt,
  });

  const migration = await call('beginWorkspaceDataMigration', owner.token);
  assert.equal(migration.status, 'copying');
  let migrationStatus = migration.status;
  let migrationSteps = 0;
  while (migrationStatus === 'copying' && migrationSteps < 30) {
    const step = await call('migrateWorkspaceDataBatch', owner.token);
    migrationStatus = step.status;
    migrationSteps += 1;
  }
  assert.equal(migrationStatus, 'verifying');
  let verifySteps = 0;
  while (migrationStatus === 'verifying' && verifySteps < 30) {
    const step = await call('verifyWorkspaceDataMigration', owner.token);
    migrationStatus = step.status;
    verifySteps += 1;
  }
  assert.equal(migrationStatus, 'verified');
  const stagedOwnerAccount = await firestore
    .collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('accounts')
    .collection('records').doc(ownerAccountId).get();
  const stagedForeignAccount = await firestore
    .collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('accounts')
    .collection('records').doc(foreignAccountId).get();
  assert.equal(stagedOwnerAccount.exists, true);
  assert.equal(stagedOwnerAccount.get('payload').ownerId, owner.uid);
  assert.equal(stagedForeignAccount.exists, false);
  assert.equal((await firestore.collection('accounts').doc(ownerAccountId).get()).exists, true);

  // Atomic dual-write bridge updates the root and staging copies with an idempotent operation key.
  await call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'accountant' });
  const dualWriteOperationId = randomUUID().replace(/-/g, '');
  const updatedAccount = {
    ownerId: owner.uid, code: '99101', title: 'Updated owner account',
    level: 'kol', category: 'asset', nature: 'debit', isSystem: false,
    createdAt, updatedAt: Timestamp.now(),
  };
  const dualWrite = await call('writeWorkspaceRecord', invitee.token, {
    collection: 'accounts', documentId: ownerAccountId, operation: 'update',
    operationId: dualWriteOperationId, data: updatedAccount,
  });
  assert.equal(dualWrite.status, 'committed');
  const replay = await call('writeWorkspaceRecord', invitee.token, {
    collection: 'accounts', documentId: ownerAccountId, operation: 'update',
    operationId: dualWriteOperationId, data: updatedAccount,
  });
  assert.equal(replay.status, 'replayed');
  assert.equal((await firestore.collection('accounts').doc(ownerAccountId).get()).get('title'), 'Updated owner account');
  const dualStaged = await firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('accounts').collection('records').doc(ownerAccountId).get();
  assert.equal(dualStaged.get('payload').title, 'Updated owner account');
  await expectCallableError(call('writeWorkspaceRecord', invitee.token, {
    collection: 'accounts', documentId: ownerAccountId, operation: 'update',
    operationId: dualWriteOperationId, data: { ...updatedAccount, title: 'Different payload' },
  }), 'ALREADY_EXISTS');

  // Role authorization is read from the active membership document, not stale custom claims.
  await expectCallableError(
    call('listWorkspaceStagedRecords', invitee.token, { collection: 'accounts' }),
    'PERMISSION_DENIED',
  );
  await call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'accountant' });
  await expectCallableError(call('listWorkspaceStagedRecords', invitee.token, {
    collection: 'accounts', limit: 10,
  }), 'FAILED_PRECONDITION');
  await call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'warehouse_keeper' });
  await expectCallableError(
    call('listWorkspaceStagedRecords', invitee.token, { collection: 'accounts' }),
    'PERMISSION_DENIED',
  );
  await expectCallableError(call('listWorkspaceStagedRecords', invitee.token, {
    collection: 'products', limit: 10,
  }), 'FAILED_PRECONDITION');

  await call('revokeWorkspaceMember', owner.token, { uid: invitee.uid });
  const revoked = await call('listWorkspaceMembers', owner.token);
  assert.equal(revoked.members.find((member) => member.uid === invitee.uid).active, false);
  await expectCallableError(call('listWorkspaceMembers', invitee.token), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'accountant' }), 'FAILED_PRECONDITION');
});


test('workspace context resolves active membership from server, not a client-selected role', async () => {
  const owner = await createVerifiedUser('context-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const ownerContext = await call('getWorkspaceContext', owner.token);
  assert.equal(ownerContext.workspaceId, owner.uid);
  assert.equal(ownerContext.role, 'owner');
  assert.equal(ownerContext.migrationStatus, 'not_started');
  assert.equal(ownerContext.stagedReadsEnabled, false);

  const outsider = await createVerifiedUser('context-outsider');
  await expectCallableError(call('getWorkspaceContext', outsider.token), 'FAILED_PRECONDITION');
});


test('core workspace reads require a verified snapshot and an explicit freeze barrier', async () => {
  const owner = await createVerifiedUser('core-read-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({ status: 'verified' });
  await expectCallableError(call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts' }), 'FAILED_PRECONDITION');

  await manifestRef.set({ status: 'verified', readBarrier: {
    status: 'frozen', generation: 'freeze-generation-001', frozenAt: Timestamp.now(),
  } }, { merge: true });
  const recordId = `core-read-${owner.uid}`;
  await firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('accounts').collection('records').doc(recordId).set({
      payload: { ownerId: owner.uid, code: '99201', title: 'Frozen snapshot account' },
      sourceId: recordId, workspaceId: owner.uid, schemaVersion: 1,
    });
  const page = await call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts', limit: 10 });
  assert.equal(page.generation, 'freeze-generation-001');
  assert.ok(page.items.some((item) => item.id === recordId && item.payload.title === 'Frozen snapshot account'));
  await expectCallableError(call('listWorkspaceCoreRecords', owner.token, { collection: 'vouchers' }), 'INVALID_ARGUMENT');
});


test('core freeze blocks bridge writes and reconciliation seals only an exact snapshot', async () => {
  const owner = await createVerifiedUser('core-freeze-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const now = Timestamp.now();
  const accountId = `freeze-account-${owner.uid}`;
  const productId = `freeze-product-${owner.uid}`;
  const account = { ownerId: owner.uid, code: '99301', title: 'Freeze fixture', level: 'kol', category: 'asset', nature: 'debit', isSystem: false, createdAt: now, updatedAt: now };
  const product = { ownerId: owner.uid, sku: `SKU-${owner.uid}`, name: 'Freeze product', category: 'raw', warehouse: 'main', unit: 'kg', buyPrice: 10, sellPrice: 12, stock: 4, reorderPoint: 1, vatExempt: false, createdAt: now, updatedAt: now };
  await firestore.collection('accounts').doc(accountId).set(account);
  await firestore.collection('products').doc(productId).set(product);
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({ workspaceId: owner.uid, status: 'verified' });
  for (const [collection, id, payload] of [['accounts', accountId, account], ['products', productId, product]]) {
    await firestore.collection('workspaces').doc(owner.uid).collection('migrationData').doc(collection).collection('records').doc(id).set({
      workspaceId: owner.uid, sourceCollection: collection, sourceId: id, sourceHash: require('node:crypto').createHash('sha256').update(JSON.stringify(stableTestValue(payload))).digest('hex'), schemaVersion: 1, payload,
    });
  }
  const freeze = await call('freezeWorkspaceCoreWrites', owner.token);
  assert.equal(freeze.status, 'frozen_pending_reconciliation');
  await expectCallableError(call('writeWorkspaceRecord', owner.token, {
    collection: 'accounts', documentId: accountId, operation: 'update', operationId: randomUUID().replace(/-/g, ''),
    data: { ...account, title: 'Should be blocked' },
  }), 'FAILED_PRECONDITION');
  const reconciled = await call('reconcileWorkspaceCoreSnapshot', owner.token);
  assert.equal(reconciled.status, 'frozen');
  assert.equal(reconciled.collections.accounts.sourceCount, 1);
  assert.equal(reconciled.collections.products.sourceCount, 1);
  const sealed = await manifestRef.get();
  assert.equal(sealed.get('readBarrier.status'), 'frozen');
  assert.equal(sealed.get('readBarrier.generation'), freeze.generation);
  const page = await call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts', limit: 10 });
  assert.equal(page.generation, freeze.generation);
});

test('workspace-native core writes activate only after reconciliation and enforce versions', async () => {
  const owner = await createVerifiedUser('native-core-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const now = Timestamp.now();
  const accountId = `native-account-${owner.uid}`;
  const account = { ownerId: owner.uid, code: '99401', title: 'Native account', level: 'kol', category: 'asset', nature: 'debit', isSystem: false, createdAt: now, updatedAt: now };
  await firestore.collection('accounts').doc(accountId).set(account);
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({ workspaceId: owner.uid, status: 'verified' });
  await firestore.collection('workspaces').doc(owner.uid).collection('migrationData').doc('accounts').collection('records').doc(accountId).set({
    workspaceId: owner.uid, sourceCollection: 'accounts', sourceId: accountId,
    sourceHash: require('node:crypto').createHash('sha256').update(JSON.stringify(stableTestValue(account))).digest('hex'),
    schemaVersion: 1, payload: account,
  });
  await firestore.collection('workspaces').doc(owner.uid).collection('migrationData').doc('products').collection('records').doc('unused').set({
    workspaceId: owner.uid, sourceCollection: 'products', sourceId: 'unused',
    sourceHash: 'fixture', schemaVersion: 1, payload: { fixture: true },
  });
  // Keep source and staging counts equal for both core collections.
  await firestore.collection('workspaces').doc(owner.uid).collection('migrationData').doc('products').collection('records').doc('unused').delete();
  await call('freezeWorkspaceCoreWrites', owner.token);
  await call('reconcileWorkspaceCoreSnapshot', owner.token);
  const activated = await call('activateWorkspaceCoreWrites', owner.token);
  assert.equal(activated.status, 'active');
  const updated = { ...account, title: 'Workspace-native title', updatedAt: Timestamp.now() };
  const operationId = randomUUID().replace(/-/g, '');
  const write = await call('mutateWorkspaceCoreRecord', owner.token, {
    collection: 'accounts', documentId: accountId, operation: 'update',
    operationId, expectedVersion: 1, data: updated,
  });
  assert.equal(write.version, 2);
  assert.equal((await firestore.collection('accounts').doc(accountId).get()).get('title'), 'Native account');
  const replay = await call('mutateWorkspaceCoreRecord', owner.token, {
    collection: 'accounts', documentId: accountId, operation: 'update',
    operationId, expectedVersion: 1, data: updated,
  });
  assert.equal(replay.status, 'replayed');
  await expectCallableError(call('mutateWorkspaceCoreRecord', owner.token, {
    collection: 'accounts', documentId: accountId, operation: 'update',
    operationId: randomUUID().replace(/-/g, ''), expectedVersion: 1, data: updated,
  }), 'ABORTED');
  const page = await call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts', limit: 10 });
  assert.ok(page.items.some((item) => item.id === accountId && item.version === 2 && item.payload.title === 'Workspace-native title'));
  const deleted = await call('mutateWorkspaceCoreRecord', owner.token, {
    collection: 'accounts', documentId: accountId, operation: 'delete',
    operationId: randomUUID().replace(/-/g, ''), expectedVersion: 2,
  });
  assert.equal(deleted.version, 3);
  const afterDelete = await call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts', limit: 10 });
  assert.equal(afterDelete.items.some((item) => item.id === accountId), false);
  assert.equal((await firestore.collection('accounts').doc(accountId).get()).exists, true);
});

test('core reconciliation keeps the read barrier closed when source and staging differ', async () => {
  const owner = await createVerifiedUser('core-freeze-mismatch');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const now = Timestamp.now();
  const id = `mismatch-account-${owner.uid}`;
  await firestore.collection('accounts').doc(id).set({ ownerId: owner.uid, code: '99302', title: 'Missing stage', level: 'kol', category: 'asset', nature: 'debit', isSystem: false, createdAt: now, updatedAt: now });
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({ workspaceId: owner.uid, status: 'verified' });
  await call('freezeWorkspaceCoreWrites', owner.token);
  await expectCallableError(call('reconcileWorkspaceCoreSnapshot', owner.token), 'DATA_LOSS');
  const manifest = await manifestRef.get();
  assert.equal(manifest.get('coreWritesFrozen'), true);
  assert.equal(manifest.get('readBarrier.status'), 'reconciling');
  await expectCallableError(call('listWorkspaceCoreRecords', owner.token, { collection: 'accounts' }), 'FAILED_PRECONDITION');
});


test('workspace voucher create, numbering, finalize and replay are atomic', async () => {
  const owner = await createVerifiedUser('voucher-native-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({
    workspaceId: owner.uid, status: 'verified', coreWritesFrozen: true,
    coreWriteMode: 'workspace_native',
    readBarrier: { status: 'frozen', generation: 'voucher-generation-1', frozenAt: Timestamp.now() },
  });
  const voucherId = `voucher-${owner.uid}`;
  const operationId = randomUUID().replace(/-/g, '');
  const now = Timestamp.now();
  const draft = {
    ownerId: owner.uid, date: '1405/08/05', fiscalYear: '1405',
    description: 'Atomic workspace voucher', voucherType: 'general', status: 'draft',
    totalDebit: 1250, totalCredit: 1250,
    lines: [
      { accountCode: '101', debit: 1250, credit: 0, description: 'Debit' },
      { accountCode: '401', debit: 0, credit: 1250, description: 'Credit' },
    ],
  };
  const created = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'create', documentId: voucherId, operationId, data: draft,
  });
  assert.equal(created.status, 'committed');
  assert.equal(created.version, 1);
  assert.equal(created.voucherNumber, 1);
  const replay = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'create', documentId: voucherId, operationId, data: draft,
  });
  assert.equal(replay.status, 'replayed');
  const voucherRef = firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('vouchers').collection('records').doc(voucherId);
  const savedDraft = await voucherRef.get();
  assert.equal(savedDraft.get('payload.status'), 'draft');
  assert.equal(savedDraft.get('payload.voucherNumber'), 1);
  assert.equal((await firestore.collection('vouchers').doc(voucherId).get()).exists, false);
  const counterRef = firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('counters').collection('records').doc(owner.uid);
  assert.equal((await counterRef.get()).get('payload.lastVoucherNumber'), 1);

  const secondId = `voucher-second-${owner.uid}`;
  const second = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'create', documentId: secondId, operationId: randomUUID().replace(/-/g, ''), data: draft,
  });
  assert.equal(second.voucherNumber, 2);
  const stagedVoucherRead = await call('listWorkspaceCoreRecords', owner.token, { collection: 'vouchers' });
  const stagedVoucher = stagedVoucherRead.items.find((item) => item.id === voucherId);
  assert.equal(stagedVoucher.version, 1);
  assert.equal(stagedVoucher.payload.voucherNumber, 1);

  const updateOperationId = randomUUID().replace(/-/g, '');
  const updatedDraft = { ...draft, description: 'Updated atomic workspace voucher' };
  const updated = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'update', documentId: secondId, operationId: updateOperationId,
    expectedVersion: 1, data: updatedDraft,
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.voucherNumber, 2);
  const secondRef = firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('vouchers').collection('records').doc(secondId);
  assert.equal((await secondRef.get()).get('payload.description'), 'Updated atomic workspace voucher');
  assert.equal((await secondRef.get()).get('payload.voucherNumber'), 2);
  const updatedReplay = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'update', documentId: secondId, operationId: updateOperationId,
    expectedVersion: 1, data: updatedDraft,
  });
  assert.equal(updatedReplay.status, 'replayed');
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'update', documentId: secondId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 1, data: updatedDraft,
  }), 'ABORTED');

  const deleted = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'delete', documentId: secondId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 2,
  });
  assert.equal(deleted.version, 3);
  assert.equal((await secondRef.get()).get('deleted'), true);
  assert.equal((await firestore.collection('vouchers').doc(secondId).get()).exists, false);
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'delete', documentId: secondId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 2,
  }), 'NOT_FOUND');

  const fnv = (input, seed) => {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  const canonicalLines = draft.lines.map(line =>
    `${line.accountCode}|||${Math.round(line.debit)}|${Math.round(line.credit)}`
  ).join(';');
  const sealPayload = `1|${draft.date}|general|1250|1250|${canonicalLines}`;
  const integrityHash = `vseal_${fnv(sealPayload, 0x811c9dc5)}${fnv(sealPayload.split('').reverse().join(''), 0x9e3779b9)}`;
  const finalized = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'finalize', documentId: voucherId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 1, integrityHash,
  });
  assert.equal(finalized.version, 2);
  assert.equal((await voucherRef.get()).get('payload.status'), 'permanent');
  assert.equal((await voucherRef.get()).get('payload.integrityHash'), integrityHash);
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'finalize', documentId: voucherId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 1, integrityHash,
  }), 'ABORTED');

  await firestore.collection('users').doc(owner.uid).set({ closedFiscalYears: ['1405'] }, { merge: true });
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: `closed-period-reversal-${owner.uid}`,
    operationId: randomUUID().replace(/-/g, ''),
    sourceDocumentId: voucherId, expectedSourceVersion: 2,
    data: { date: '1405/08/06', fiscalYear: '1405', description: 'Closed period reversal' },
  }), 'FAILED_PRECONDITION');
  await firestore.collection('users').doc(owner.uid).set({ closedFiscalYears: [] }, { merge: true });

  const reversalId = `reversal-${owner.uid}`;
  const reversalOperationId = randomUUID().replace(/-/g, '');
  const reversal = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: reversalId, operationId: reversalOperationId,
    sourceDocumentId: voucherId, expectedSourceVersion: 2,
    data: { date: '1405/08/06', fiscalYear: '1405', description: 'Atomic reversal of voucher 1' },
  });
  assert.equal(reversal.status, 'committed');
  assert.equal(reversal.version, 1);
  assert.equal(reversal.voucherNumber, 3);
  const reversalRef = firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('vouchers').collection('records').doc(reversalId);
  const reversalSnap = await reversalRef.get();
  assert.equal(reversalSnap.get('payload.status'), 'draft');
  assert.equal(reversalSnap.get('payload.reversalOfVoucherId'), voucherId);
  assert.equal(reversalSnap.get('payload.totalDebit'), 1250);
  assert.equal(reversalSnap.get('payload.totalCredit'), 1250);
  const reversalPayload = reversalSnap.get('payload');
  assert.equal(reversalPayload.lines[0].debit, 0);
  assert.equal(reversalPayload.lines[0].credit, 1250);
  const sourceAfterReverse = await voucherRef.get();
  assert.equal(sourceAfterReverse.get('reversedByVoucherId'), reversalId);
  assert.equal(sourceAfterReverse.get('version'), 3);
  assert.equal((await firestore.collection('vouchers').doc(reversalId).get()).exists, false);
  const reversalReplay = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: reversalId, operationId: reversalOperationId,
    sourceDocumentId: voucherId, expectedSourceVersion: 2,
    data: { date: '1405/08/06', fiscalYear: '1405', description: 'Atomic reversal of voucher 1' },
  });
  assert.equal(reversalReplay.status, 'replayed');
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: reversalId, operationId: reversalOperationId,
    sourceDocumentId: voucherId, expectedSourceVersion: 2,
    data: { date: '1405/08/06', fiscalYear: '1405', description: 'Changed description with reused operation ID' },
  }), 'ALREADY_EXISTS');
  await expectCallableError(call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: `duplicate-reversal-${owner.uid}`,
    operationId: randomUUID().replace(/-/g, ''),
    sourceDocumentId: voucherId, expectedSourceVersion: 3,
    data: { date: '1405/08/06', fiscalYear: '1405', description: 'Duplicate reversal attempt' },
  }), 'ALREADY_EXISTS');

  const deletedReversal = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'delete', documentId: reversalId, operationId: randomUUID().replace(/-/g, ''),
    expectedVersion: 1,
  });
  assert.equal(deletedReversal.version, 2);
  assert.equal(deletedReversal.sourceVersion, 4);
  const sourceAfterDelete = await voucherRef.get();
  assert.equal(sourceAfterDelete.get('version'), 4);
  assert.equal(sourceAfterDelete.get('reversedByVoucherId'), undefined);
  const secondReversal = await call('mutateWorkspaceVoucher', owner.token, {
    operation: 'reverse', documentId: `reversal-again-${owner.uid}`,
    operationId: randomUUID().replace(/-/g, ''),
    sourceDocumentId: voucherId, expectedSourceVersion: 4,
    data: { date: '1405/08/07', fiscalYear: '1405', description: 'Reversal after prior draft was deleted' },
  });
  assert.equal(secondReversal.status, 'committed');
  assert.equal(secondReversal.voucherNumber, 4);
});


test('workspace-native warehouse transfer receipt updates staged product and extension atomically', async () => {
  const owner = await createVerifiedUser('warehouse-native-receipt-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const productId = `native-receipt-product-${owner.uid}`;
  const transferId = `native-receipt-transfer-${owner.uid}`;
  const now = Timestamp.now();
  const transitLayer = {
    layerId: 'native-receipt-layer-1', sourceRef: 'native-purchase-source-1',
    remainingQty: 4, totalCostIrr: 8400, warehouse: 'در راه → انبار مقصد',
  };
  const unrelatedLayer = {
    layerId: 'native-receipt-layer-2', sourceRef: 'native-purchase-source-2',
    remainingQty: 6, totalCostIrr: 15000, warehouse: 'انبار مرکزی',
  };
  const product = {
    ownerId: owner.uid, sku: 'NATIVE-RECEIPT-01', name: 'Native receipt fixture',
    category: 'raw', warehouse: 'انبار مرکزی', unit: 'kg',
    buyPrice: 2100, sellPrice: 3000, stock: 10, reorderPoint: 0,
    vatExempt: false, inventoryValueIrr: 23400,
    costLayers: [transitLayer, unrelatedLayer], createdAt: now, updatedAt: now,
  };
  const nativeProductRef = firestore.collection('workspaces').doc(owner.uid)
    .collection('migrationData').doc('products').collection('records').doc(productId);
  await nativeProductRef.set({
    workspaceId: owner.uid, sourceCollection: 'products', sourceId: productId,
    sourceHash: 'native-product-fixture-hash', schemaVersion: 1, version: 7,
    payload: product, updatedAt: now,
  });
  const transfer = {
    id: transferId, transferNumber: 'TR-NATIVE-RECEIPT-01', date: '1405/08/01',
    productId, sku: product.sku, productName: product.name,
    fromWarehouse: 'انبار مرکزی', toWarehouse: 'انبار مقصد',
    qty: 4, transferredCostIrr: 8400, transferredLayers: [{
      layerId: transitLayer.layerId, sourceRef: transitLayer.sourceRef,
      remainingQty: transitLayer.remainingQty, totalCostIrr: transitLayer.totalCostIrr,
    }],
    status: 'in_transit',
  };
  const extensionRef = firestore.collection('workspaceExtensions').doc(owner.uid);
  await extensionRef.set({
    ownerId: owner.uid, trackedWarehouseTransfers: [transfer], _version: 3,
    createdAt: now, updatedAt: now,
  });
  const manifestRef = firestore.collection('workspaceMigrations').doc(owner.uid);
  await manifestRef.set({
    workspaceId: owner.uid, status: 'verified', coreWritesFrozen: true,
    coreWriteMode: 'workspace_native',
    readBarrier: { status: 'open', generation: 'native-receipt-generation-1', frozenAt: now },
  });

  await expectCallableError(call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/05',
  }), 'FAILED_PRECONDITION');

  await manifestRef.update({ 'readBarrier.status': 'frozen' });
  const received = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/05',
  });
  assert.equal(received.status, 'committed');
  assert.equal(received.productVersion, 8);

  const stagedAfter = await nativeProductRef.get();
  const extensionAfter = await extensionRef.get();
  const savedProduct = stagedAfter.get('payload');
  assert.equal(stagedAfter.get('version'), 8);
  assert.equal(savedProduct.stock, 10);
  assert.equal(savedProduct.inventoryValueIrr, 23400);
  assert.equal(savedProduct.costLayers[0].warehouse, 'انبار مقصد');
  assert.equal(savedProduct.costLayers[1].warehouse, 'انبار مرکزی');
  assert.equal(stagedAfter.get('sourceHash'), require('node:crypto').createHash('sha256')
    .update(JSON.stringify(stableTestValue(savedProduct))).digest('hex'));
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.status'), 'received');
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.receivedDate'), '1405/08/05');
  assert.equal(extensionAfter.get('_version'), 4);
  assert.equal((await firestore.collection('products').doc(productId).get()).exists, false);

  const replay = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/05',
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.productVersion, 8);
  await expectCallableError(call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/06',
  }), 'FAILED_PRECONDITION');
});

test('warehouse transfer creation splits source FIFO layers and persists the in-transit voucher atomically', async () => {
  const owner = await createVerifiedUser('warehouse-create-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const productId = `create-transfer-product-${owner.uid}`;
  const transferId = `trf-create-${owner.uid}`;
  const now = Timestamp.now();
  await firestore.collection('products').doc(productId).set({
    ownerId: owner.uid, sku: 'TRANSFER-01', name: 'Transfer fixture',
    category: 'raw', warehouse: 'انبار مرکزی', unit: 'kg',
    buyPrice: 1000, sellPrice: 1500, stock: 7, reorderPoint: 0,
    vatExempt: false, inventoryValueIrr: 10000,
    costLayers: [
      { layerId: 'source-layer-1', sourceRef: 'purchase-1', date: '1405/01/01', originalQty: 3, remainingQty: 3, unitCostIrr: 1000, totalCostIrr: 3000, warehouse: 'انبار مرکزی' },
      { layerId: 'source-layer-2', sourceRef: 'purchase-2', date: '1405/01/02', originalQty: 2, remainingQty: 2, unitCostIrr: 1000, totalCostIrr: 2000, warehouse: 'انبار مرکزی' },
      { layerId: 'other-warehouse-layer', sourceRef: 'purchase-3', date: '1405/01/03', originalQty: 2, remainingQty: 2, unitCostIrr: 2500, totalCostIrr: 5000, warehouse: 'انبار دیگر' },
    ], createdAt: now, updatedAt: now,
  });
  const extensionRef = firestore.collection('workspaceExtensions').doc(owner.uid);
  await extensionRef.set({ ownerId: owner.uid, trackedWarehouseTransfers: [], _version: 1, createdAt: now, updatedAt: now });
  const result = await call('createTrackedWarehouseTransfer', owner.token, {
    productId, transferId, transferNumber: 'TR-CREATE-01',
    fromWarehouse: 'انبار مرکزی', toWarehouse: 'انبار مقصد',
    qty: 4, date: '1405/08/01',
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.transfer.status, 'in_transit');
  assert.ok(Number.isSafeInteger(result.transfer.eventSequence) && result.transfer.eventSequence > 0);
  assert.equal(result.transfer.qty, 4);
  assert.equal(result.transfer.transferredCostIrr, 4000);
  const productAfter = await firestore.collection('products').doc(productId).get();
  const extensionAfter = await extensionRef.get();
  assert.equal(productAfter.get('stock'), 7);
  assert.equal(productAfter.get('inventoryValueIrr'), 10000);
  const layers = productAfter.get('costLayers');
  assert.equal(layers.find((layer) => layer.layerId === 'source-layer-2').remainingQty, 1);
  assert.equal(layers.find((layer) => layer.layerId === 'source-layer-2').totalCostIrr, 1000);
  assert.equal(layers.find((layer) => layer.layerId === 'other-warehouse-layer').remainingQty, 2);
  assert.equal(layers.filter((layer) => layer.warehouse === 'در راه → انبار مقصد').length, 2);
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.id'), transferId);
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.status'), 'in_transit');
  assert.equal(extensionAfter.get('_version'), 2);

  // Exercise the exact layers created above through the real receipt callable.
  const received = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/02',
  });
  assert.equal(received.status, 'committed');
  assert.ok(Number.isSafeInteger(received.receivedEventSequence));
  assert.ok(received.receivedEventSequence > result.transfer.eventSequence);
  const receivedProduct = await firestore.collection('products').doc(productId).get();
  const receivedExtension = await extensionRef.get();
  assert.equal(receivedProduct.get('stock'), 7);
  assert.equal(receivedProduct.get('inventoryValueIrr'), 10000);
  assert.equal(receivedProduct.get('costLayers').filter((layer) => layer.warehouse === 'انبار مقصد')
    .reduce((sum, layer) => sum + layer.remainingQty, 0), 4);
  assert.equal(receivedProduct.get('costLayers').filter((layer) => layer.warehouse === 'در راه → انبار مقصد').length, 0);
  assert.equal(receivedProduct.get('costLayers').find((layer) => layer.layerId === 'other-warehouse-layer').warehouse, 'انبار دیگر');
  assert.equal(receivedExtension.get('trackedWarehouseTransfers.0.status'), 'received');
  assert.equal(receivedExtension.get('trackedWarehouseTransfers.0.receivedDate'), '1405/08/02');
  assert.equal(receivedExtension.get('trackedWarehouseTransfers.0.eventSequence'), result.transfer.eventSequence);
  assert.equal(receivedExtension.get('trackedWarehouseTransfers.0.receivedEventSequence'), received.receivedEventSequence);
  assert.equal(receivedExtension.get('_version'), 3);
  const inventoryCounter = await firestore.collection('counters').doc(owner.uid).get();
  assert.equal(inventoryCounter.get('lastInventorySequence'), received.receivedEventSequence);

  const receiptReplay = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/02',
  });
  assert.equal(receiptReplay.status, 'replayed');
  const creationReplay = await call('createTrackedWarehouseTransfer', owner.token, {
    productId, transferId, transferNumber: 'TR-CREATE-01',
    fromWarehouse: 'انبار مرکزی', toWarehouse: 'انبار مقصد',
    qty: 4, date: '1405/08/01',
  });
  assert.equal(creationReplay.status, 'replayed');
  assert.equal(creationReplay.transfer.status, 'received');

  await expectCallableError(call('createTrackedWarehouseTransfer', owner.token, {
    productId, transferId: `trf-create-replay-${owner.uid}`, transferNumber: 'TR-OVER',
    fromWarehouse: 'انبار مرکزی', toWarehouse: 'انبار مقصد',
    qty: 99, date: '1405/08/01',
  }), 'FAILED_PRECONDITION');
});

test('warehouse transfer receipt commits FIFO layers and transfer status atomically', async () => {
  const owner = await createVerifiedUser('warehouse-receipt-owner');
  await call('bootstrapWorkspace', owner.token);
  await refreshUserToken(owner);
  const productId = `receipt-product-${owner.uid}`;
  const transferId = `receipt-transfer-${owner.uid}`;
  const now = Timestamp.now();
  const transitLayer = {
    layerId: 'receipt-layer-1', sourceRef: 'purchase-source-1',
    remainingQty: 2, totalCostIrr: 2000, warehouse: 'در راه → انبار مقصد',
  };
  const unrelatedLayer = {
    layerId: 'receipt-layer-2', sourceRef: 'purchase-source-2',
    remainingQty: 3, totalCostIrr: 4500, warehouse: 'انبار مرکزی',
  };
  await firestore.collection('products').doc(productId).set({
    ownerId: owner.uid, sku: 'RECEIPT-01', name: 'Receipt fixture',
    category: 'raw', warehouse: 'انبار مرکزی', unit: 'kg',
    buyPrice: 1000, sellPrice: 1500, stock: 5, reorderPoint: 0,
    vatExempt: false, inventoryValueIrr: 6500,
    costLayers: [transitLayer, unrelatedLayer], createdAt: now, updatedAt: now,
  });
  const transfer = {
    id: transferId, transferNumber: 'TR-RECEIPT-01', date: '1405/08/01',
    productId, sku: 'RECEIPT-01', productName: 'Receipt fixture',
    fromWarehouse: 'انبار مرکزی', toWarehouse: 'انبار مقصد',
    qty: 2, transferredCostIrr: 2000, transferredLayers: [{
      layerId: transitLayer.layerId, sourceRef: transitLayer.sourceRef,
      remainingQty: transitLayer.remainingQty, totalCostIrr: transitLayer.totalCostIrr,
    }],
    status: 'in_transit',
  };
  const extensionRef = firestore.collection('workspaceExtensions').doc(owner.uid);
  await extensionRef.set({
    ownerId: owner.uid, trackedWarehouseTransfers: [transfer], _version: 1,
    createdAt: now, updatedAt: now,
  });
  const received = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/05',
  });
  assert.equal(received.status, 'committed');
  const productAfter = await firestore.collection('products').doc(productId).get();
  const extensionAfter = await extensionRef.get();
  assert.equal(productAfter.get('stock'), 5);
  assert.equal(productAfter.get('inventoryValueIrr'), 6500);
  assert.equal(productAfter.get('costLayers.0.warehouse'), 'انبار مقصد');
  assert.equal(productAfter.get('costLayers.1.warehouse'), 'انبار مرکزی');
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.status'), 'received');
  assert.equal(extensionAfter.get('trackedWarehouseTransfers.0.receivedDate'), '1405/08/05');
  assert.equal(extensionAfter.get('_version'), 2);

  const replay = await call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/05',
  });
  assert.equal(replay.status, 'replayed');
  await expectCallableError(call('receiveTrackedWarehouseTransfer', owner.token, {
    productId, transferId, receivedDate: '1405/08/06',
  }), 'FAILED_PRECONDITION');
});
