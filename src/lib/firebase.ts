import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  doc,
  Firestore,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  setLogLevel,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

// Silence noisy SDK internal offline/retry console.error spam on slow or filtered networks;
// all actual operation failures are still surfaced through handleFirestoreError().
setLogLevel('silent');

const app = initializeApp(firebaseConfig);

export type FirestoreCacheMode = 'persistent-multitab' | 'persistent-single' | 'memory';
let detectedFirestoreCacheMode: FirestoreCacheMode = 'memory';

function createResilientFirestore(): Firestore {
  const dbId = firebaseConfig.firestoreDatabaseId;
  // 1. Prefer persistent multi-tab IndexedDB cache for full offline read/write & multi-tab sync
  try {
    const instance = initializeFirestore(
      app,
      {
        experimentalAutoDetectLongPolling: true,
        ignoreUndefinedProperties: true,
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      dbId
    );
    detectedFirestoreCacheMode = 'persistent-multitab';
    return instance;
  } catch {
    // 2. Fallback to single-tab persistent cache if SharedWorker/BroadcastChannel is restricted
    try {
      const instance = initializeFirestore(
        app,
        {
          experimentalAutoDetectLongPolling: true,
          ignoreUndefinedProperties: true,
          localCache: persistentLocalCache(),
        },
        dbId
      );
      detectedFirestoreCacheMode = 'persistent-single';
      return instance;
    } catch {
      // 3. Final fallback to memory cache (e.g. strict private/incognito iframe without IndexedDB)
      try {
        const instance = initializeFirestore(
          app,
          {
            experimentalAutoDetectLongPolling: true,
            ignoreUndefinedProperties: true,
            localCache: memoryLocalCache(),
          },
          dbId
        );
        detectedFirestoreCacheMode = 'memory';
        return instance;
      } catch {
        return getFirestore(app, dbId);
      }
    }
  }
}

export const db = createResilientFirestore();
export const getFirestoreCacheMode = (): FirestoreCacheMode => detectedFirestoreCacheMode;
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function isFirestoreOfflineError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    message.includes('the client is offline') ||
    message.includes('Could not reach Cloud Firestore backend') ||
    message.includes('Failed to get document because the client is offline')
  );
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return false;
  }
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (isFirestoreOfflineError(error)) {
      console.warn('Firestore backend temporarily unreachable; operating in offline mode until reconnected.');
      return false;
    }
    return true;
  }
}

let pendingGoogleSignIn: Promise<Awaited<ReturnType<typeof signInWithPopup>> | null> | null = null;

export async function signInWithGoogle() {
  if (pendingGoogleSignIn) {
    return pendingGoogleSignIn;
  }
  const request = signInWithPopup(auth, googleProvider)
    .catch((err: unknown) => {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
      if (code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user') {
        return null;
      }
      throw err;
    })
    .finally(() => {
      pendingGoogleSignIn = null;
    });

  pendingGoogleSignIn = request;
  return request;
}

export async function signOutAccount() {
  return signOut(auth);
}


// Workspace callable gateway. Membership and role are revalidated server-side on every call.
export const functions = getFunctions(app, 'us-central1');
export interface WorkspaceContextResult {
  workspaceId: string;
  role: string;
  migrationStatus: string;
  stagedReadsEnabled: boolean;
  coreWritesFrozen: boolean;
  coreWriteMode: 'legacy' | 'workspace_native' | string;
}
export async function resolveWorkspaceContext(): Promise<WorkspaceContextResult> {
  const callable = httpsCallable<void, WorkspaceContextResult>(functions, 'getWorkspaceContext');
  const result = await callable();
  return result.data;
}

export interface InvoiceReturnCounterMigrationResult {
  status: 'completed' | 'already-completed';
  migratedCount: number;
  scannedInvoiceCount?: number;
}

export async function migrateInvoiceReturnCounters(): Promise<InvoiceReturnCounterMigrationResult> {
  const callable = httpsCallable<void, InvoiceReturnCounterMigrationResult>(
    functions,
    'migrateInvoiceReturnCounters',
  );
  const result = await callable();
  return result.data;
}


export interface WorkspaceCoreRecord<T = Record<string, unknown>> {
  id: string;
  payload: T;
  version: number;
}

/** Reads a complete, frozen Workspace snapshot. Partial pages are never returned. */
export async function listWorkspaceCoreRecords<T = Record<string, unknown>>(
  collectionName: 'accounts' | 'products' | 'parties' | 'vouchers'
): Promise<WorkspaceCoreRecord<T>[]> {
  const callable = httpsCallable<
    { collection: 'accounts' | 'products' | 'parties' | 'vouchers'; limit: number; cursor?: string },
    { workspaceId: string; collection: string; generation: string; items: WorkspaceCoreRecord<T>[]; nextCursor: string | null }
  >(functions, 'listWorkspaceCoreRecords');
  const all: WorkspaceCoreRecord<T>[] = [];
  let cursor: string | undefined;
  let generation: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const response = await callable({ collection: collectionName, limit: 100, ...(cursor ? { cursor } : {}) });
    const data = response.data;
    if (data.collection !== collectionName || !data.generation || (generation && generation !== data.generation)) {
      throw new Error('Workspace snapshot generation changed during pagination.');
    }
    generation = data.generation;
    all.push(...data.items);
    if (!data.nextCursor) return all;
    cursor = data.nextCursor;
  }
  throw new Error('Workspace collection exceeds the safe pagination limit; no partial result was returned.');
}

export interface WorkspaceCoreMutationInput<T = Record<string, unknown>> {
  collection: 'accounts' | 'products';
  documentId: string;
  operation: 'create' | 'update' | 'delete';
  operationId: string;
  expectedVersion: number;
  data?: T;
}
export interface WorkspaceCoreMutationResult {
  status: 'committed' | 'replayed';
  operationId: string;
  version: number;
}

/** Calls the versioned Workspace-native gateway; never falls back to legacy root writes. */
export async function mutateWorkspaceCoreRecord<T = Record<string, unknown>>(
  input: WorkspaceCoreMutationInput<T>
): Promise<WorkspaceCoreMutationResult> {
  const callable = httpsCallable<WorkspaceCoreMutationInput<T>, WorkspaceCoreMutationResult>(
    functions,
    'mutateWorkspaceCoreRecord'
  );
  const result = await callable(input);
  return result.data;
}

export interface CreateTrackedWarehouseTransferInput {
  productId: string;
  transferId: string;
  transferNumber: string;
  fromWarehouse: string;
  toWarehouse: string;
  qty: number;
  date: string;
  operatorName?: string;
  notes?: string;
}
export async function createTrackedWarehouseTransferAtomic(
  input: CreateTrackedWarehouseTransferInput
): Promise<{ status: 'committed' | 'replayed'; transfer: Record<string, unknown>; productVersion: number }> {
  const callable = httpsCallable<CreateTrackedWarehouseTransferInput, {
    status: 'committed' | 'replayed'; transfer: Record<string, unknown>; productVersion: number;
  }>(functions, 'createTrackedWarehouseTransfer');
  const result = await callable(input);
  return result.data;
}
export interface ReceiveTrackedWarehouseTransferInput {
  productId: string;
  transferId: string;
  receivedDate: string;
}
export async function receiveTrackedWarehouseTransferAtomic(
  input: ReceiveTrackedWarehouseTransferInput
): Promise<{
  status: 'committed' | 'replayed';
  productVersion: number;
  transferId?: string;
  receivedEventSequence?: number;
}> {
  const callable = httpsCallable<ReceiveTrackedWarehouseTransferInput, {
    status: 'committed' | 'replayed';
    productVersion: number;
    transferId?: string;
    receivedEventSequence?: number;
  }>(functions, 'receiveTrackedWarehouseTransfer');
  const result = await callable(input);
  return result.data;
}
export interface WorkspaceVoucherMutationInput {
  operation: 'create' | 'update' | 'delete' | 'finalize' | 'reverse';
  documentId: string;
  operationId: string;
  expectedVersion?: number;
  sourceDocumentId?: string;
  expectedSourceVersion?: number;
  integrityHash?: string;
  data?: Record<string, unknown>;
}
export interface WorkspaceVoucherMutationResult {
  status: 'committed' | 'replayed';
  operationId: string;
  version: number;
  sourceVersion?: number;
  voucherNumber: number;
}
export async function mutateWorkspaceVoucher(
  input: WorkspaceVoucherMutationInput
): Promise<WorkspaceVoucherMutationResult> {
  const callable = httpsCallable<WorkspaceVoucherMutationInput, WorkspaceVoucherMutationResult>(
    functions, 'mutateWorkspaceVoucher'
  );
  const result = await callable(input);
  return result.data;
}
