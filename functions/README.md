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

## Atomic dual-write bridge (limited scaffold)

`writeWorkspaceRecord` is an idempotent callable bridge for the initial core collections (`accounts`, `products`, `vouchers`, `invoices`). It checks live membership/role, validates a conservative subset of each core schema, and commits the root record plus its staging envelope and operation ledger in one transaction in the same named Firestore database.

The callable is **not yet wired into AccountingContext**. Do not use it as a production cutover: invoice posting, inventory/voucher multi-document operations, cancellation, counters, and the remaining collections still require transaction-aware adapters. Only call it after staging verification; a verified snapshot can become stale if legacy writes continue.


### Workspace context resolver
- `getWorkspaceContext` returns the caller's workspace ID, authoritative active-membership role, and migration status.
- The workspace claim is treated only as a locator; active membership and workspace lifecycle are re-read on every call.
- `src/lib/firebase.ts` exports the regional Functions client and a typed `resolveWorkspaceContext()` client helper.
- This is a context-resolution foundation only. It does not change AccountingContext ownership, root-collection listeners, CRUD routing, or multi-document accounting transactions.


### AccountingContext integration guard
AccountingContext resolves the authenticated caller's Workspace before cloud hydration. Active invited members are prevented from creating a duplicate personal cloud seed or attaching UID-scoped root listeners. Their ownerId is resolved to the Workspace ID, while current root Rules still require the caller UID, deliberately blocking unsupported member writes. No staged reads are enabled yet because legacy writes can stale the verified snapshot; the next step must implement and test server-backed read/write adapters before member accounting access is opened.


### Frozen core read adapter (accounts/products)
- listWorkspaceCoreRecords exposes only accounts and products and revalidates active membership and role on every page.
- A verified migration manifest alone is insufficient. The endpoint requires readBarrier.status = frozen, a non-empty generation, and a freeze timestamp; without these fields it fails closed because legacy writes may have made the snapshot stale.
- The client helper pages through the full collection and returns no partial result if pagination fails or the safety cap is exceeded.
- AccountingContext fetches accounts and products together for invited members and publishes neither collection until both reads complete. Other collections and all writes remain unavailable through this adapter.
- No code in this change creates the freeze barrier or stops legacy writes. Until a separately reviewed freeze/reconciliation procedure is implemented, member reads are expected to remain blocked.


### Core collection freeze and reconciliation
- freezeWorkspaceCoreWrites sets a server-owned coreWritesFrozen flag and a reconciling generation on the verified migration manifest. Firestore Rules then reject legacy client writes to accounts/products; the dual-write callable also rejects writes to those collections.
- reconcileWorkspaceCoreSnapshot compares source/staging counts and SHA-256 payload hashes for every account/product before changing readBarrier.status to frozen. A mismatch or safety-limit failure leaves the barrier closed.
- This is a one-way safety freeze in this stage. It does not unfreeze legacy writes, redirect application writes, or freeze vouchers/invoices/inventory workflows. Deploy Functions and Firestore Rules together only after emulator validation and an explicit maintenance plan.

- The generic staged-record read endpoint is also gated for accounts/products until the same frozen reconciliation barrier is sealed; role authorization alone cannot bypass the barrier.


### Workspace-native core writes (phase 15 foundation)
- `activateWorkspaceCoreWrites` is owner-only and requires a verified migration, the permanent legacy-write freeze, and a reconciled frozen barrier with both collection counts. It records `coreWriteMode=workspace_native`; it does not reopen legacy writes.
- `mutateWorkspaceCoreRecord` writes only to the workspace migration namespace for accounts/products. It never writes to legacy root collections. It rechecks active membership and role, validates the complete record, requires an expected version, and records an idempotent operation ledger entry.
- Updates use optimistic concurrency. Reusing an operation ID with the same request is a replay; reusing it with different content is rejected. Deletes create tombstones rather than removing the document, preserving identity and auditability.
- `listWorkspaceCoreRecords` returns active records with their version and hides tombstones. The frozen generation remains the cutover generation; workspace-native writes do not cause a legacy-source reconciliation to be rerun.
- AccountingContext now routes account and product create/update/delete through this gateway whenever a Workspace context is present. It tracks server versions for optimistic concurrency and updates local state only after the callable succeeds. Direct legacy-root CRUD remains only for users with no Workspace context; Workspace errors never fall back to legacy writes. Simple single-record stock edits and warehouse changes also use the native versioned gateway. Voucher-backed stock adjustments, bulk stocktaking, invoice issuance/cancellation, and other multi-document flows remain deliberately blocked or pending the subsequent transaction migration; they must not be treated as supported in Workspace mode. No live workspace is activated by this code change. Do not deploy or invoke activation until the remaining transaction-sensitive flows, schema parity, and Emulator tests are complete.


### Workspace-native voucher lifecycle (phase 16, first slice)
- `mutateWorkspaceVoucher` supports draft creation and draft finalization for owner, finance_manager, accountant, and treasurer memberships.
- Draft creation assigns the next voucher number inside the same Firestore transaction that creates the workspace voucher and advances the migrated owner counter. It reads the current fiscal-year staged vouchers as a collision guard and never writes the legacy root `vouchers` or `counters` collections.
- Finalization checks the expected record version, requires a draft, recomputes the deterministic integrity seal on the server, and commits the permanent status and new version in one transaction.
- Both operations require the verified/frozen/native workspace state, active server-side membership, role authorization, and workspace-scoped idempotency keys. A repeated operation with changed content is rejected.
- AccountingContext routes Workspace-native draft creation, version-checked draft editing/deletion, and finalization through this callable. Direct permanent creation remains blocked in Workspace mode; users must create a draft and finalize it. Voucher reversal remains a separate, not-yet-migrated flow.
- Emulator test coverage has been authored for sequential numbering, staged reads and version propagation, update/delete tombstones, replay, server-side integrity verification, version conflicts, atomic reversal creation, duplicate prevention, reversal-draft deletion/release, and absence of legacy-root writes. Tests/build have not yet been executed.


### Workspace-native voucher draft lifecycle

The `mutateWorkspaceVoucher` callable supports atomic `create`, `update`, `delete`, and `finalize` operations for staged vouchers. Draft updates and deletions require the current envelope version and a unique workspace-scoped operation ID. Updates preserve the server-assigned voucher number and original creation timestamp; deletions create a versioned tombstone rather than physically removing the staged record. Permanent vouchers cannot be edited or deleted. All operations require a verified caller, active workspace membership, an allowed finance role, a verified/frozen migration manifest, and a frozen read barrier. No operation writes to legacy root voucher collections.


### Workspace-native voucher reversal

The `mutateWorkspaceVoucher` callable also supports `reverse`. It reads the permanent source voucher, verifies its server-comparable integrity seal and expected envelope version, rejects an existing reversal, derives the reversal lines on the server, allocates the next fiscal-year voucher number, creates the reversal draft, advances the counter, and marks the source envelope as reversed in one Firestore transaction. The source envelope version is incremented. The server also checks the workspace owner's closed fiscal years before posting. Reversal idempotency hashes the complete request payload. A reversal remains a draft and must be finalized through the existing finalize operation. If that draft is deleted, the same transaction tombstones it and clears the matching source marker while incrementing the source version, allowing a corrected reversal attempt. No legacy-root voucher or counter writes occur.
