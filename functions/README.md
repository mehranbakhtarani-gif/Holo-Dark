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
