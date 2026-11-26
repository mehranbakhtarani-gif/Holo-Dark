# Firebase Functions — trusted workspace membership

This codebase adds a server-owned membership and invitation foundation. It does **not**
yet turn the existing owner-scoped accounting collections into shared multi-user data.

## Deployment prerequisites
- Firebase project: `elaborate-hash-368613`
- Named Firestore database: `ai-studio-remixapex-83053e73-77ed-4f64-8f70-f22da529446b`
- Enable Cloud Functions and ensure billing/Blaze plan is active.
- Deploy using an operator with permission to deploy Functions and manage Firebase Authentication custom claims.
- Do not deploy Firestore rules requiring workspace claims until the data migration and rules-emulator suite are complete.

## First-stage callable API
- `bootstrapWorkspace`: idempotently creates the existing account owner's workspace and owner membership. Workspace ID is the current Firebase UID to preserve current ownerId semantics.
- `createWorkspaceInvitation`: owner-only, email-bound, seven-day invitation. The raw random token is returned once; only its SHA-256 digest is stored.
- `acceptWorkspaceInvitation`: requires a verified Firebase email matching the invitation recipient.
- `setWorkspaceMemberRole`: owner-only role change through Admin SDK.
- `revokeWorkspaceMember`: marks membership inactive and clears the member's workspace custom claims.

Membership authority is stored in `workspaceMemberships/{workspaceId}_{uid}`. Claims are a routing/identity hint; **future Firestore rules and callable accounting operations must also check the active membership document** because already-issued ID tokens can remain valid until refreshed/expired.

## Important current limitations
1. Existing records still use `ownerId == request.auth.uid`. Invited users cannot yet read or write those records.
2. The React app still uses locally selected `rbacOperators`; it is not yet wired to these callable functions.
3. No invitation email delivery is configured; the owner must deliver the one-time token through a trusted channel.
4. Existing accounts need to call `bootstrapWorkspace` and refresh their ID token before using the new membership layer.
5. Functions deployment, emulator tests, and a data migration have not been performed from this change.

## Safe rollout order
1. Install and build Functions dependencies.
2. Run Auth, Firestore and Functions emulators with test users and test projects.
3. Add emulator tests for owner bootstrap, email mismatch, token replay, expired invitations, role escalation, revoked membership and concurrent acceptance.
4. Wire the app's operator administration UI to the callable API and require one Firebase UID per human.
5. Migrate records to a workspace-aware schema with backup and dry-run verification.
6. Add membership checks to every Firestore path and move sensitive accounting transitions to trusted functions.
7. Deploy Functions, then rules and client only after successful staging verification.


## Named database SDK note
The Functions use the supported `@google-cloud/firestore` client with an explicit `projectId` and `databaseId`. The Admin SDK's named-database `getFirestore(app, databaseId)` API is documented as preview, so it is deliberately not used here. The Firebase Admin SDK is retained only for Auth custom-claims management.


## Workspace emulator integration tests

Install Functions dependencies with `npm install` in this directory. Start the configured Auth, Firestore, and Functions emulators from the repository root using `firebase emulators:start --only auth,firestore,functions`. In a second terminal, run `npm run test:emulator` from `functions/`. The test harness creates isolated verified Auth Emulator users and exercises the callable endpoints against the Functions and Firestore emulators. It uses only emulator endpoints and does not deploy or mutate production resources. The harness expects the project ID and emulator ports declared in the repository Firebase configuration; override `FIREBASE_PROJECT_ID`, `AUTH_EMULATOR_HOST`, or `FUNCTIONS_EMULATOR_HOST` only when running a deliberately separate emulator stack.

## Reversible workspace data staging

The owner can start and advance a staging migration from Settings. The Functions API uses `beginWorkspaceDataMigration`, `migrateWorkspaceDataBatch`, and `verifyWorkspaceDataMigration`. It copies allowlisted owner-scoped root collections in pages of up to 200 records into `workspaces/{workspaceId}/migrationData/{collection}/records/{sourceId}`. Original records are read-only inputs and are not deleted or rewritten. Destination records preserve the complete source payload inside an envelope and include a SHA-256 digest.

The verification phase rereads each current source page and compares its digest with the staged record; it also compares copied and verified record counts per collection. If a source changes during the copy, verification stops rather than claiming a successful migration. Restart/reset is deliberately not automatic.

**Important:** this is a staging copy only. It does not change the app's root-collection reads/writes, enable workspace-member Firestore Rules, or authorize any member to access the staged records. Do not deploy broadened Rules or delete legacy collections based only on a staging status.

## Role-scoped staged data reads

`listWorkspaceStagedRecords` provides read-only, paginated access to a verified staging snapshot. It checks verified email, the active workspace record, and the caller's active membership document on every request. Current membership role—not a potentially stale custom claim—determines the collection allowlist. Reads are unavailable until the migration manifest is `verified`. Each request returns at most 100 records and caps the serialized response below 7 MiB.

This callable does not implement dual-write or replace the application's legacy root-collection queries. Firestore Rules remain default-deny for the staging namespace; do not grant direct client access or perform a production cutover based only on this gateway.
