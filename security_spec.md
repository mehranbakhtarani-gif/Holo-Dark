# Holoo Corporate Apex ERP — Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Tenant Ownership**: Every accounting record (`accounts`, `parties`, `products`, `vouchers`, `invoices`, `cheques`, `employees`, `assets`, `costCenters`) MUST contain `ownerId == request.auth.uid` and can only be read, queried, created, updated, or deleted by its verified owner (`request.auth.token.email_verified == true`) or a verified admin.
2. **PII Isolation**: `users/{userId}` stores personal/company contact metadata and is strictly restricted to `request.auth.uid == userId` (no blanket `isSignedIn()` reads).
3. **Balanced Double-Entry Integrity**: Every `vouchers` document must contain `lines` with between 2 and 100 entries, `totalDebit >= 0`, `totalCredit >= 0`, and `totalDebit == totalCredit`. Permanent (`status == 'permanent'`) vouchers are terminally locked from modification by non-admins.
4. **Invoice & Cheque Terminal Locks**: Cancelled invoices and cancelled cheques cannot be mutated by non-admins.
5. **Temporal Integrity & Immutability**: `createdAt == request.time` on create, `updatedAt == request.time` on update, and `ownerId` + `createdAt` are immutable after creation.
6. **Zero Privilege Escalation**: `users/{userId}` creation restricts `role == 'accountant'` and `admins/{adminId}` forbids all client writes.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Email Write**: Authenticated user with `email_verified: false` tries to create an `accounts` document -> MUST FAIL (`PERMISSION_DENIED`).
2. **Identity Spoofing on Create**: User A tries to create a `vouchers` doc with `ownerId: "user_B"` -> MUST FAIL.
3. **Shadow Field Injection**: User creates a `products` doc with extra ghost field `isAdminApproved: true` -> MUST FAIL (`hasOnly`).
4. **Oversized Document ID Poisoning**: User creates `parties/<200-char-id>` -> MUST FAIL (`isValidId`).
5. **Unbalanced Double-Entry Voucher**: User creates a `vouchers` doc with `totalDebit: 1000, totalCredit: 500` -> MUST FAIL.
6. **Terminal State Violation (Permanent Voucher)**: Non-admin updates a `vouchers` doc whose `existing().status == 'permanent'` -> MUST FAIL.
7. **PII Blanket Scrape**: User A attempts `get` on `/users/user_B` -> MUST FAIL.
8. **Unscoped List Query**: User A runs an unfiltered `list` on `/invoices` without matching `ownerId == userA` -> MUST FAIL.
9. **Client Timestamp Forgery**: User submits `createdAt: Timestamp(2020-01-01)` instead of `serverTimestamp()` -> MUST FAIL.
10. **Immutable Owner Tampering**: User A updates their `cheques` doc trying to change `ownerId` to `user_B` -> MUST FAIL.
11. **Value Poisoning on Allowed Update Field**: User updates `products.stock` to `"not-a-number"` -> MUST FAIL (`isValidProduct`).
12. **Self-Assigned Admin Escalation**: User creates `/users/{uid}` with `role: "admin"` or writes to `/admins/{uid}` -> MUST FAIL.


## 3. Phase 1 — Server-Enforced Operator Authorization (Required Before Production)

### Current verified architecture
- The client authenticates one Firebase Google account and stores the active operator selection in React state.
- Multiple local operator records share the same Firebase UID and workspace ownerId.
- Firestore rules validate the workspace owner and document schema, but cannot prove which local operator is currently using the browser.
- Therefore local RBAC is a UI/application workflow control, not a security boundary. A modified client using the owner's Firebase token can bypass it.
- Firebase Functions now provide workspace bootstrap, invitation acceptance, owner-only role changes/revocation, and owner-only member listing. The React settings UI is connected to these callables; local operator records remain a separate legacy workflow.

### Required target architecture
1. Give every human operator an individual Firebase Authentication UID. Never use a client-selected operator ID as identity.
2. Represent workspaces separately from users. Use a server-managed membership record keyed by workspaceId and uid, with immutable workspace ownership and a role identifier.
3. Issue custom claims only from a trusted Admin SDK environment after verifying an invitation/owner approval. Claims should identify the workspace and membership role; clients must never write claims or membership authority.
4. Enforce tenant membership and role permissions in Firestore Rules for every collection and sensitive state transition. Keep document owner/workspace identity immutable on update.
5. Move high-impact accounting transitions (voucher finalization, invoice issue/cancellation, stock valuation changes, year close, operator/role administration) to callable/server functions where invariants span multiple documents or require privileged writes.
6. Add emulator tests for cross-tenant reads/writes, role escalation, stale/revoked membership, forbidden state transitions, and transaction idempotency before enabling the new rules.
7. Migrate existing single-owner data with an explicit backup, dry-run mapping, reversible migration, and owner sign-off. Do not deploy rules that require claims until every existing owner has been provisioned.

### Rollout blocker
This repository currently has no trusted server provisioning path. Enforcing custom-claim-only access immediately would lock out existing workspaces; retaining owner-only fallback would leave local operator RBAC bypassable. The migration and server provisioning layer must be implemented and tested before claiming server-enforced multi-user RBAC.


## 4. Phase 2 — Trusted Firebase Workspace Provisioning (Implemented Scaffold)

### Added server-side callable functions
- `bootstrapWorkspace`: verified Firebase account creates (or safely reopens provisioning for) its owner workspace. Workspace ID equals the existing Firebase UID to preserve the current ownerId data model during this first stage.
- `createWorkspaceInvitation`: owner-only, email-bound invitation with a cryptographically random one-time token. Only the SHA-256 digest is stored; expiry is seven days.
- `acceptWorkspaceInvitation`: requires a verified matching email, validates invitation status/expiry, creates a membership transactionally and issues workspace custom claims.
- `setWorkspaceMemberRole`: owner-only role changes through the Admin SDK.
- `revokeWorkspaceMember`: marks membership inactive and removes workspace claims. Future authorization rules must check the membership document to defeat stale ID tokens.

### New server-owned collections
- `workspaces/{workspaceId}` — workspace owner and lifecycle.
- `workspaceMemberships/{workspaceId}_{uid}` — authoritative active membership, email and role.
- `workspaceInvitations/{sha256(token)}` — email-bound invitation metadata; raw token is returned once and is not stored.

### Deployment/configuration
- Added `firebase.json` for the existing named Firestore database, Functions source and local Auth/Firestore/Functions emulators.
- Added isolated Node.js 22 Functions package and strict TypeScript configuration under `functions/`.
- Added deployment and rollout notes in `functions/README.md`.

### Explicit limitations / not yet enabled
- Existing accounting records still use `ownerId == request.auth.uid`; invited members cannot yet access another user's records.
- The original local operator matrix remains a legacy/local workflow; secure workspace administration is implemented separately as documented in Phase 3.
- No email delivery provider is configured; invitation tokens require secure manual delivery.
- Firestore rules have intentionally NOT been broadened to workspace members. This avoids accidentally opening every accounting collection before migration and emulator verification.
- Functions have not been installed, compiled, emulator-tested or deployed. The source is a provisioning foundation, not a completed multi-user authorization rollout.


### Named Firestore client decision
The Functions access the existing named database through `@google-cloud/firestore` with explicit `projectId` and `databaseId`; they do not use the Firebase Admin SDK's named-database `getFirestore(app, databaseId)` API, which is documented as preview. Firebase Admin remains responsible for Auth custom claims.


### Deployment guardrails
- Added `.firebaserc` with the existing Firebase project as the explicit default, preventing accidental deployment to an unspecified project.
- Added Functions build output and local dependency exclusions under `functions/.gitignore`.
- No Functions or Firestore Rules were deployed; no production data was changed.


## 5. Phase 3 — Workspace UI Integration and Emulator Test Harness

### Implemented
- Added `WorkspaceAccessPanel` to company settings. It uses the same Firebase app as the authenticated user and calls Functions in `us-central1`.
- Owner bootstrap is an explicit action; users without workspace claims can accept an invitation without first creating a competing workspace.
- Verified-email gating is enforced in the UI and independently in every callable.
- Owners can create email-bound invitations, copy the one-time raw token, list members, change supported roles, and revoke memberships.
- Invitees must enter the token manually; it is not placed in a URL or browser storage. After acceptance, the client forces an ID-token refresh.
- The legacy local operator matrix is explicitly labelled as local-only and is not presented as Firebase identity or server authorization.
- Added owner-only `listWorkspaceMembers` callable. Bootstrap now checks existing active membership records so a stale pre-invitation ID token cannot create a second workspace after an invitation has been accepted.
- Added a Node.js built-in test harness at `functions/test/workspace.emulator.test.cjs` and `npm run test:emulator`. The scenarios cover owner bootstrap/idempotency, verified-email enforcement, invitation email mismatch and invalid token, concurrent invitation acceptance, stale-token bootstrap prevention, member listing, non-owner denial, invalid/self role escalation, role change, and revocation.

### Deliberate security boundaries
- Firestore Rules remain owner-only. No workspace member access to accounting documents is enabled.
- Invitation delivery remains manual; the UI displays a one-time token and does not send email.
- Accepting an invitation provisions membership and claims only. It does not yet migrate or expose the owner's accounting records.
- Membership records, not custom claims alone, remain the intended authoritative source for future Rules. The current Rules have not yet been migrated to consult memberships.

### Verification status
- Emulator test source and command are committed, but the tests have **not** been executed in this environment.
- Functions dependency installation, TypeScript compilation, Vite build, and Firebase Auth/Firestore/Functions Emulator execution remain pending.
- No production Functions deployment, Firestore Rules deployment, data migration, or PR merge was performed.

## 6. Phase 4 — Reversible Workspace Data Staging Migration

### Implemented migration service
- Added owner-only callable endpoints: `beginWorkspaceDataMigration`, `migrateWorkspaceDataBatch`, and `verifyWorkspaceDataMigration`.
- Migration source collections are explicitly allowlisted: counters, accounting master/transaction data, payroll/assets/cost centers, currencies/rates, operational dossiers/orders/jobs, legacy operator records, audit logs, workspace extensions, device presence, and cloud backups.
- Each source record is copied in pages of at most 200 documents to:
  `workspaces/{workspaceId}/migrationData/{collection}/records/{sourceId}`.
- The destination stores an envelope containing the original payload, source path/id, workspace ID, schema version, copy timestamp, and SHA-256 source digest. The original root document is never modified or deleted.
- Copy-page writes and cursor advancement are committed in one Firestore transaction. Stable destination IDs make retries idempotent.
- Verification rereads the current legacy source in bounded pages, recomputes SHA-256, compares each staged payload, and checks per-collection source/staged counts. Changes or missing destination documents stop verification with a data-loss error.
- Added an owner-only Settings panel. The owner explicitly starts the staging copy and advances one bounded page at a time; verification is also advanced page by page.

### Explicitly not a cutover
- This phase does **not** change application reads/writes from root collections to workspace subcollections.
- Firestore Rules remain owner-only and default-deny for the new staging namespace. No member receives accounting access.
- Source collections remain authoritative. The staging copy is not yet a live workspace data store.
- User profile documents under `users/{uid}` are not included in the accounting/operational collection allowlist; they require a separate profile migration decision.
- A verified staging copy is a prerequisite for the later dual-write/cutover phase, not permission to delete legacy data.

### Verification status
- Added emulator test coverage for a real owner-scoped source fixture, exclusion of a foreign owner's record, and preservation of the legacy source after staging.
- The emulator tests, Functions TypeScript build, and application build have **not** been executed in this environment. No data migration has been run against the live Firebase project, and no Rules or Functions deployment has occurred.

## 7. Phase 5 — Membership-Authoritative Staged Data Read Gateway

### Implemented
- Added `listWorkspaceStagedRecords`, a read-only callable endpoint for staged workspace records.
- Every request requires a verified Firebase account, an active workspace, and a matching active `workspaceMemberships/{workspaceId}_{uid}` record. A workspace claim is only a locator; it does not authorize access by itself.
- Role permissions are evaluated from the current membership document on every request. Supported roles receive explicit collection allowlists; the owner can read all allowlisted staged collections.
- Reads are blocked until the migration manifest reaches `verified`. Results are paginated, limited to 1–100 records, and response payloads are capped below 7 MiB.
- Emulator test cases cover denial for a warehouse role reading accounts, access immediately after a server-side role change even with a stale role claim, denial after role reduction with the same stale claim, and immediate denial after revocation without requiring token refresh.

### Not a dual-write or production cutover
- This endpoint exposes only the verified staging snapshot and is read-only. It does not change `AccountingContext` root collection reads/writes or mirror subsequent changes into staging.
- Firestore Rules remain unchanged and default-deny for workspace staging paths. Clients cannot bypass the callable's membership checks with direct Firestore reads.
- No broad member access, dual-write, data cutover, or legacy deletion is enabled. These require the next separately tested phase.
- The Emulator tests and both builds remain unexecuted; the code and test cases are committed but not runtime-verified.

## 8. Phase 6 — Atomic Dual-Write Bridge (Core Collections, Not Yet App Cutover)

### Implemented server-side bridge
- Added `writeWorkspaceRecord` for the initial core collections: `accounts`, `products`, `vouchers`, and `invoices`.
- Each operation checks the current active membership and role. Read-only auditors cannot write; other roles receive explicit collection allowlists.
- Create/update/delete writes to the legacy root document and the workspace staging record occur in one Firestore transaction in the same named database.
- A per-workspace operation ledger provides idempotent retries. Reusing an operation ID with different content is rejected.
- Updates/deletes require both legacy and staging copies to exist; creates reject an existing copy. This avoids silently recreating a missing side of an inconsistent pair.
- Added server-side structural and core financial checks for account, product/FIFO, voucher balance/permanent integrity seal, and invoice amounts/status. Unsupported collection writes are rejected instead of bypassing validation.
- Added Emulator test source for paired updates, replay idempotency, and operation-ID content conflict.

### Explicit rollout restrictions
- The bridge is a callable server primitive, not yet the active write path in `AccountingContext`. Existing CRUD methods, invoice multi-document posting, stock adjustments, cancellation, counters, and other collections still use their legacy write paths.
- The callable requires a verified migration manifest and both copies for update/delete. It must not be invoked until the owner has completed and verified staging.
- The current migration snapshot can become stale if legacy writes continue after verification. Before routing production writes, the application must enter a controlled migration freeze or implement a durable change journal/reconciliation barrier; a snapshot verification alone is not a safe cutover protocol.
- Core validators are intentionally conservative and incomplete relative to every Firestore Rules constraint. No production use is authorized until schema parity, full transaction flows, and Emulator tests are verified.
- No Firestore Rules change, Functions deployment, production migration, or PR merge was performed.
- Emulator tests and builds remain unexecuted.


## Workspace context resolution (phase 14 foundation)
The `getWorkspaceContext` callable resolves the workspace locator from the authenticated token, then revalidates the active membership document and active workspace on every request. Its role value is server-authoritative. The response includes migration status; staged reads are advertised only when the manifest is verified. The client exports a typed callable helper, but AccountingContext is not yet switched to this result. Root ownerId queries and writes remain unchanged until the subsequent read-adapter and transaction-routing steps are implemented and verified.


## AccountingContext workspace resolution guard
AccountingContext now calls `getWorkspaceContext` before cloud seeding or root-collection listeners. If the caller is an active member whose workspace ID differs from their Firebase UID, it does not seed a personal duplicate tenant and does not attach legacy root listeners. The Context scopes its ownerId to the resolved workspace owner ID; because current root Firestore Rules still require `ownerId == request.auth.uid`, member writes are intentionally denied until server-backed Workspace CRUD/read adapters and matching authorization rules are implemented. Verified staging status alone does not enable client reads: the snapshot can become stale while legacy writes continue. Authorization errors fail closed; only an uninitialized workspace or a not-yet-deployed resolver retains the legacy owner path.


## Frozen core read adapter
The listWorkspaceCoreRecords callable is limited to accounts/products, enforces the active membership role on every request, and requires a verified migration manifest plus an explicit immutable read barrier (readBarrier.status=frozen, generation, frozenAt). This prevents serving a snapshot that may have drifted due to legacy root writes after verification. The client helper retrieves all pages and refuses partial collections; AccountingContext publishes accounts/products only after both collections load successfully. The barrier is not created by this change and no legacy writes are frozen. Consequently the endpoint correctly remains closed until a dedicated freeze and reconciliation workflow is implemented. No voucher, invoice, stock movement, or other multi-document writes are redirected.


## Core write freeze and reconciliation
The owner-only freeze callable marks the migration manifest coreWritesFrozen=true and assigns a reconciliation generation. Firestore Rules gate legacy client create/update/delete operations for accounts and products against this server-owned flag; the writeWorkspaceRecord callable also rejects writes to those collections while frozen. A separate owner-only reconciliation callable compares source/staging counts and each source payload SHA-256, and promotes the read barrier to frozen only after an exact match. Any mismatch or bounded-work failure leaves reads closed and the write freeze in place. This is intentionally fail-closed and one-way in this stage: no automatic unfreeze, no write-routing activation, and no freeze of vouchers/invoices/stock transactions. Functions and Rules must be deployed together after emulator validation and an approved maintenance plan.

The generic listWorkspaceStagedRecords endpoint is subject to the same final barrier for accounts/products, preventing alternate read paths from bypassing the freeze requirement. getWorkspaceContext reports stagedReadsEnabled only after the frozen barrier is sealed.


## Workspace-native core write gateway (phase 15 foundation)
The owner-only `activateWorkspaceCoreWrites` transition is allowed only after the verified staging snapshot has been frozen and reconciled. It sets a server-owned `coreWriteMode=workspace_native` flag while leaving the legacy root write freeze in place. The owner-only transition is idempotent and does not perform a production activation unless explicitly invoked.

The `mutateWorkspaceCoreRecord` callable is restricted to accounts/products and checks verified authentication, current active membership, current role allowlists, the active workspace lifecycle, complete payload validation, and the workspace-native mode flag. It writes only beneath `workspaces/{workspaceId}/migrationData`; it never dual-writes or mutates legacy root collections. Each update/delete requires an expected record version. Operation IDs are scoped to the workspace and use a request hash to make retries idempotent and payload substitution fail. Deletes retain a tombstone and increment the version. Reads expose the current version and omit tombstones while retaining the original frozen generation as the cutover reference.

AccountingContext account/product create, update, and delete now call the native gateway whenever a Workspace context is resolved; they track server versions and do not fall back to legacy writes on Workspace errors. Simple one-record stock adjustments and warehouse changes also use this route. Voucher-backed stock adjustments, bulk stocktaking, invoice issuance/cancellation, and other multi-document accounting/inventory flows are not yet migrated and are blocked or remain unsupported in Workspace mode. The emulator test cases are authored but have not been executed. No Functions/Rules deployment, live activation, production migration, or PR merge was performed.
