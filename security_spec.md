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
- No Firebase Functions source, deployment manifest, operator invitation flow, or custom-claims provisioning workflow exists in this repository at this revision.

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
