const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { deleteApp, initializeApp } = require('firebase-admin/app');
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
  const verified = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:update?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: created.idToken, emailVerified: true, returnSecureToken: true }),
  });
  const verifiedText = await verified.text();
  assert.equal(verified.ok, true, verifiedText);
  const account = JSON.parse(verifiedText);
  return { email, password, uid: account.localId, token: account.idToken };
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
