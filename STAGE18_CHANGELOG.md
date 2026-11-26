# Stage 18 — Final Remediation Log

Status: IN_PROGRESS

## Changes applied

### 1. Release Validation emulator-test fixture
- The workspace-native warehouse-transfer fixture now creates its verified workspace migration manifest before writing the extension that triggers server-side transfer sequencing.
- This keeps the initial dispatch sequence and later receipt sequence on the same workspace-native counter path.
- The earlier Release Validation failure was an assertion in the warehouse-transfer receipt integration test (`_version` expected 5, observed 6). The fixture ordering has been corrected; the new result still requires CI confirmation.

### 2. Durable Supabase sync idempotency
- Replaced the 32-bit FNV snapshot fingerprint with SHA-256, while normalizing the volatile `exportedAt` field.
- Sync operation IDs are deterministic from target, workspace, device, client revision, and payload hash. The same logical retry therefore retains the same ID after reload.
- Sync outbox writes are awaited and fail visibly instead of being silently ignored.
- A successful push acknowledges only the exact operation that was accepted; it does not bulk-delete another tab's pending operations.
- The server now retains a bounded history of the latest 256 operation IDs in persisted `_syncMeta`, while preserving compatibility with the former `lastOperationId` field.

### 3. Workspace-native voucher validation
- Added server-side validation for create, update, finalize, and reverse transitions.
- Validates workspace ownership, Shamsi date shape/range, fiscal-year/date consistency, and closed fiscal years.
- Validates balanced totals and every journal line, including finite nonnegative amounts and nonzero one-sided entries.
- Resolves every account against the workspace chart of accounts; rejects missing, inactive, group, and general-ledger accounts.
- Enforces required party references and validates any supplied party and cost-center references against the same workspace.
- Rejects duplicate non-reversal voucher reference IDs.
- Added emulator coverage for unknown accounts, non-posting account levels, missing required parties, invalid dates, closed fiscal years, and duplicate references.

## Verification status

- Source changes and tests have been committed to `fix/accounting-fifo-persistence`.
- The latest branch HEAD must pass Quality Gates and Release Validation before these changes are marked VERIFIED.
- The previously observed Release Validation failure belongs to the earlier HEAD; it is not evidence that the current HEAD passes.
- No physical Android device test, full offline PWA test, or independent three-device sync test is claimed by this remediation log.

## Remaining Stage 18 blockers

1. Obtain and inspect Quality Gates and Release Validation results for the latest HEAD.
2. Resolve any new TypeScript, unit, rules, emulator, or production-build failures.
3. Continue the audit of direct Firestore financial writes and migrate sensitive mutations safely before tightening rules.
4. Complete workspace RBAC read/write routing for all supported collections.
5. Review remaining sync concurrency and server-side idempotency race conditions; the persisted replay window is bounded to 256 IDs and is not a substitute for a transactional idempotency ledger.
6. Re-run the full regression suite after all fixes.
7. Do not mark Stage 18 complete until all applicable checks have verified evidence.