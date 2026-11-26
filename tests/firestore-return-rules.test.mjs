import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

const projectId = 'demo-holo-dark';
let testEnv;

function invoiceBase(ownerId, invoiceType, overrides = {}) {
  return {
    ownerId,
    invoiceNumber: `TEST-${invoiceType}-001`,
    invoiceType,
    date: '1405/08/01',
    partyId: 'party_1',
    partyName: 'Test party',
    warehouse: 'Main',
    subtotal: 100,
    discount: 0,
    vatAmount: 0,
    grandTotal: 100,
    paidCash: 0,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 100,
    status: 'issued',
    items: [{ productId: 'product_1', quantity: 1 }],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function sourceMutation(sourceRef, returnId, count, revision) {
  return {
    activeReturnCount: count,
    returnRevision: revision,
    lastReturnMutationId: returnId,
    _version: revision + 1,
    updatedByDevice: 'rules-test',
    updatedAt: serverTimestamp(),
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

test('invoice event sequences require an atomic server-counter reservation', async () => {
  await testEnv.clearFirestore();
  const uid = 'rules_inventory_sequence';
  const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
  const counterRef = doc(db, 'counters', uid);
  const invoiceRef = doc(db, 'invoices', 'sale_with_sequence');

  // A client cannot claim an online sequence without reserving that exact value.
  await assertFails(setDoc(invoiceRef, invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
    eventSequence: 7,
    eventSequenceSource: 'online',
  })));

  // Offline clients must omit sequence provenance; only the trusted trigger may
  // later mark a record as sync-assigned using Admin SDK privileges.
  await assertFails(setDoc(doc(db, 'invoices', 'sale_with_forged_sync_sequence'), invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
    eventSequence: 8,
    eventSequenceSource: 'sync',
  })));
  await assertFails(setDoc(doc(db, 'invoices', 'sale_with_invalid_sequence_source'), invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
    eventSequence: 8,
    eventSequenceSource: 'client-clock',
  })));
  await assertFails(setDoc(doc(db, 'invoices', 'sale_with_fractional_sequence'), invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
    eventSequence: 7.5,
    eventSequenceSource: 'online',
  })));

  // The counter reservation and invoice creation must share one atomic commit.
  const createBatch = writeBatch(db);
  createBatch.set(counterRef, {
    ownerId: uid,
    lastVoucherNumber: 0,
    lastInvoiceSeq: 102,
    lastInventorySequence: 7,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  createBatch.set(invoiceRef, invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
    eventSequence: 7,
    eventSequenceSource: 'online',
  }));
  await assertSucceeds(createBatch.commit());

  await assertSucceeds(updateDoc(counterRef, {
    lastInventorySequence: 8,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(counterRef, {
    lastInventorySequence: 6,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(invoiceRef, {
    eventSequence: 9,
    eventSequenceSource: 'online',
    updatedAt: serverTimestamp(),
  }));
});

test('return counter ACL requires exact atomic return creation and cancellation pairs', async () => {
  await testEnv.clearFirestore();
  const uid = 'rules_owner';
  const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
  const sourceRef = doc(db, 'invoices', 'sale_source_1');
  const returnRef = doc(db, 'invoices', 'sale_return_1');

  await assertFails(setDoc(doc(db, 'invoices', 'sale_source_without_counters'), invoiceBase(uid, 'sale')));
  await assertFails(setDoc(doc(db, 'invoices', 'sale_source_forged_counter'), invoiceBase(uid, 'sale', { returnRevision: 0, activeReturnCount: 5 })));
  await assertSucceeds(setDoc(sourceRef, invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
  })));

  // A counter-only write cannot reserve a return or change the source revision.
  await assertFails(updateDoc(sourceRef, sourceMutation(sourceRef, 'sale_return_1', 1, 1)));

  // A return document without its matching source mutation is rejected.
  await assertFails(setDoc(returnRef, invoiceBase(uid, 'sale_return', {
    sourceInvoiceId: 'sale_source_1',
  })));

  // The exact return document and its source counter must be committed together.
  const createBatch = writeBatch(db);
  createBatch.set(returnRef, invoiceBase(uid, 'sale_return', {
    sourceInvoiceId: 'sale_source_1',
  }));
  createBatch.update(sourceRef, sourceMutation(sourceRef, 'sale_return_1', 1, 1));
  await assertSucceeds(createBatch.commit());

  // An original invoice with an active return cannot be cancelled.
  await assertFails(updateDoc(sourceRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  }));

  // Cancelling a return without decrementing the source counter is rejected.
  await assertFails(updateDoc(returnRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  }));

  // A source counter decrement while the linked return stays active is rejected.
  await assertFails(updateDoc(sourceRef, sourceMutation(sourceRef, 'sale_return_1', 0, 2)));

  const cancelBatch = writeBatch(db);
  cancelBatch.update(returnRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  });
  cancelBatch.update(sourceRef, sourceMutation(sourceRef, 'sale_return_1', 0, 2));
  await assertSucceeds(cancelBatch.commit());

  // Once the paired cancellation is committed, the source invoice can be cancelled.
  await assertSucceeds(updateDoc(sourceRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  }));
});

test('proforma conversion initializes source return counters', async () => {
  await testEnv.clearFirestore();
  const uid = 'rules_owner_proforma';
  const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
  const proformaRef = doc(db, 'invoices', 'proforma_to_sale_1');

  await assertSucceeds(setDoc(proformaRef, invoiceBase(uid, 'proforma')));
  await assertSucceeds(updateDoc(proformaRef, {
    invoiceNumber: 'SALE-001',
    invoiceType: 'sale',
    status: 'issued',
    voucherId: 'voucher_proforma_conversion',
    items: [{ productId: 'product_1', quantity: 1 }],
    returnRevision: 0,
    activeReturnCount: 0,
    _version: 2,
    updatedByDevice: 'rules-test',
    updatedAt: serverTimestamp(),
  }));

  const returnRef = doc(db, 'invoices', 'return_from_converted_proforma');
  const returnBatch = writeBatch(db);
  returnBatch.set(returnRef, invoiceBase(uid, 'sale_return', {
    sourceInvoiceId: 'proforma_to_sale_1',
  }));
  returnBatch.update(proformaRef, sourceMutation(proformaRef, 'return_from_converted_proforma', 1, 1));
  await assertSucceeds(returnBatch.commit());
});

test('return ACL rejects mismatched mutation IDs and fails closed for legacy sources', async () => {
  await testEnv.clearFirestore();
  const uid = 'rules_owner_legacy';
  const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();

  const sourceRef = doc(db, 'invoices', 'sale_source_legacy');
  const actualReturnRef = doc(db, 'invoices', 'sale_return_actual');
  await assertSucceeds(setDoc(sourceRef, invoiceBase(uid, 'sale', {
    returnRevision: 0,
    activeReturnCount: 0,
  })));

  const mismatchedBatch = writeBatch(db);
  mismatchedBatch.set(actualReturnRef, invoiceBase(uid, 'sale_return', {
    sourceInvoiceId: 'sale_source_legacy',
  }));
  mismatchedBatch.update(sourceRef, sourceMutation(sourceRef, 'sale_return_other', 1, 1));
  await assertFails(mismatchedBatch.commit());

  const legacySourceRef = doc(db, 'invoices', 'sale_source_legacy_without_counter');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'invoices', 'sale_source_legacy_without_counter'), invoiceBase(uid, 'sale'));
  });

  await assertFails(setDoc(doc(db, 'invoices', 'sale_return_legacy'), invoiceBase(uid, 'sale_return', {
    sourceInvoiceId: 'sale_source_legacy_without_counter',
  })));
  await assertFails(updateDoc(legacySourceRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  }));
});


test('warehouse transfer event authority ledger is server-only', async () => {
  await testEnv.clearFirestore();
  const uid = 'rules_transfer_authority_owner';
  const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
  const authorityRef = doc(db, 'warehouseTransferEventAuthority', `${uid}_transfer_001_dispatch`);

  // The extension array is client-writable for offline outbox delivery, but its
  // sequence/provenance source must live in a collection clients cannot forge.
  await assertFails(setDoc(authorityRef, {
    ownerId: uid,
    transferId: 'transfer_001',
    kind: 'dispatch',
    eventSequence: 44,
    source: 'online',
    createdAt: serverTimestamp(),
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'warehouseTransferEventAuthority', `${uid}_transfer_001_dispatch`), {
      ownerId: uid,
      transferId: 'transfer_001',
      kind: 'dispatch',
      eventSequence: 44,
      source: 'online',
      createdAt: serverTimestamp(),
    });
  });
  await assertFails(getDoc(authorityRef));
  await assertFails(updateDoc(authorityRef, { eventSequence: 45 }));
  await assertFails(deleteDoc(authorityRef));
});
