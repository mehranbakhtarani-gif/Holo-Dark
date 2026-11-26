const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'elaborate-hash-368613';
const AUTH_EMULATOR = process.env.AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FUNCTIONS_EMULATOR = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
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
  if (!verify) return { email, uid: created.localId, token: created.idToken };
  const verified = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:update?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: created.idToken, emailVerified: true, returnSecureToken: true }),
  });
  const verifiedText = await verified.text();
  assert.equal(verified.ok, true, verifiedText);
  const account = JSON.parse(verifiedText);
  return { email, uid: account.localId, token: account.idToken };
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
  await expectCallableError(call('bootstrapWorkspace', staleInviteeToken), 'ALREADY_EXISTS');

  const members = await call('listWorkspaceMembers', owner.token);
  assert.equal(members.members.length, 2);
  assert.ok(members.members.some((member) => member.uid === invitee.uid && member.role === 'accountant' && member.active));

  await expectCallableError(call('listWorkspaceMembers', invitee.token), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: owner.uid, role: 'finance_manager' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'owner' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'root_admin' }), 'INVALID_ARGUMENT');
  await expectCallableError(call('revokeWorkspaceMember', invitee.token, { uid: owner.uid }), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', invitee.token, { uid: owner.uid, role: 'accountant' }), 'PERMISSION_DENIED');

  await call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'warehouse_keeper' });
  const changed = await call('listWorkspaceMembers', owner.token);
  assert.equal(changed.members.find((member) => member.uid === invitee.uid).role, 'warehouse_keeper');

  await call('revokeWorkspaceMember', owner.token, { uid: invitee.uid });
  const revoked = await call('listWorkspaceMembers', owner.token);
  assert.equal(revoked.members.find((member) => member.uid === invitee.uid).active, false);
  await expectCallableError(call('listWorkspaceMembers', invitee.token), 'PERMISSION_DENIED');
  await expectCallableError(call('setWorkspaceMemberRole', owner.token, { uid: invitee.uid, role: 'accountant' }), 'FAILED_PRECONDITION');
});
