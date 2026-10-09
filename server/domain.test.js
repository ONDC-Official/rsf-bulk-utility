import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOnReceiverRecon, buildReceiverReconGroup, createCaseOrder, deriveSubscriber, normalizeSubscriberUrl,
  normalizeNtsContext, validateSettlementInputs
} from './domain.js';

test('scopes arbitrary participants by BAP URI without matching the signing identity', () => {
  const context = { bap_id: 'external-bap', bap_uri: 'https://BUYER.test:443/protocol/', bpp_id: 'external-bpp', bpp_uri: 'https://np.test/ondc/' };
  assert.deepEqual(deriveSubscriber(context), { subscriber_url: 'https://buyer.test/protocol' });
  assert.deepEqual(deriveSubscriber({ ...context, bpp_uri: 'https://another-seller.test' }), deriveSubscriber(context));
  assert.deepEqual(deriveSubscriber({ ...context, bap_id: context.bpp_id }), deriveSubscriber(context));
  assert.throws(() => deriveSubscriber({ ...context, bap_uri: 'invalid' }), /valid HTTP or HTTPS/);
  assert.throws(() => deriveSubscriber({ ...context, bpp_uri: 'invalid' }), /valid HTTP or HTTPS/);
  assert.throws(() => deriveSubscriber({ ...context, bap_id: '' }), /bap_id and bpp_id/);
});

test('keeps an on_receiver_recon preview stable for the same case version', () => {
  const record = {
    _id: 'case-1', version: 2, updated_at: new Date('2026-09-29T08:00:00.000Z'),
    context: { transaction_id: 'tx-2', bap_id: 'collector', bap_uri: 'https://np.test/bap',
      bpp_id: 'receiver', bpp_uri: 'http://local.test/bpp', collector_app_id: 'collector', receiver_app_id: 'receiver' }
  };
  const orders = [{ ...createCaseOrder({ id: 'O2', expectedMinor: 10000, receivedMinor: 5000, assessment: 'underpaid' }), difference_minor: 321 }];
  const first = buildOnReceiverRecon(record, orders);
  const second = buildOnReceiverRecon(record, orders);
  assert.deepEqual(second, first);
  assert.equal(first.payload.context.timestamp, '2026-09-29T08:00:00.000Z');
});

test('accepts settlement amounts independently of the chosen status', () => {
  assert.deepEqual(validateSettlementInputs(17460, 'PAID', ['100.00', '74.60']), { amountMinors: [10000, 7460], total: 17460 });
  assert.equal(validateSettlementInputs(17460, 'PAID', ['174.59']).total, 17459);
  assert.deepEqual(validateSettlementInputs(17460, 'UNDERPAID', ['50.00']), { amountMinors: [5000], total: 5000 });
  assert.equal(validateSettlementInputs(17460, 'OVERPAID', ['10.00']).total, 1000);
  assert.equal(validateSettlementInputs(17460, 'UNDERPAID', ['200.00']).total, 20000);
  assert.equal(validateSettlementInputs(17460, 'NOT-PAID', ['30.00']).total, 3000);
  assert.equal(validateSettlementInputs(17460, 'OVERPAID', ['-0.25']).total, -25);
});

test('uses the entered difference without calculating or validating status relationships', () => {
  const record = { _id: 'manual-case', version: 1, updated_at: new Date(), context: { transaction_id: 'fresh-tx', bap_id: 'bap', bpp_id: 'bpp' } };
  for (const assessment of ['matched', 'underpaid', 'overpaid', 'missing']) {
    const order = { ...createCaseOrder({ id: 'CUSTOM', expectedMinor: 10000, receivedMinor: 20000, assessment }), difference_minor: -125 };
    const result = buildOnReceiverRecon(record, [order]).payload.message.orderbook.orders[0];
    assert.equal(result.counterparty_diff_amount.value, '-1.25');
  }
  const matched = { ...createCaseOrder({ id: 'MATCHED', expectedMinor: 10000, receivedMinor: 1, assessment: 'matched' }), difference_minor: 999 };
  assert.equal(buildOnReceiverRecon(record, [matched]).payload.message.orderbook.orders[0].counterparty_diff_amount.value, '9.99');
  assert.throws(() => buildOnReceiverRecon(record, [{ ...matched, difference_minor: null }]), /Enter a difference/);
});

test('builds custom responses with only order ID, difference and assessment', () => {
  const record = { _id: 'custom-only', version: 1, updated_at: new Date(), context: { transaction_id: 'fresh-tx', bap_id: 'bap', bpp_id: 'bpp' } };
  for (const assessment of ['matched', 'underpaid', 'overpaid', 'missing']) {
    const result = buildOnReceiverRecon(record, [{ id: 'CUSTOM', difference_minor: 723, assessment }]);
    assert.equal(result.payload.message.orderbook.orders[0].counterparty_diff_amount.value, '7.23');
  }
});

test('includes matched orders in mixed and all-matched response payloads', () => {
  const record = { _id: 'matched-case', version: 1, updated_at: new Date('2026-10-08T00:00:00.000Z'), context: { transaction_id: 'tx', bap_id: 'bap', bpp_id: 'bpp' } };
  const matched = { id: 'MATCHED', difference_minor: 0, assessment: 'matched', settlement_id: 'SET-1', settlement_reference_no: 'UTR-1' };
  for (const orders of [[matched], [matched, { id: 'UNDERPAID', difference_minor: 125, assessment: 'underpaid' }]]) {
    const draft = buildOnReceiverRecon(record, orders);
    const outgoing = draft.payload.message.orderbook.orders;
    assert.equal(draft.payload.context.action, 'on_receiver_recon');
    assert.ok(draft.messageId);
    assert.deepEqual(outgoing.map(order => order.id), orders.map(order => order.id));
    assert.equal(outgoing[0].counterparty_recon_status, '01');
    assert.equal(outgoing[0].counterparty_diff_amount.value, '0.00');
    assert.equal(outgoing[0].settlement_id, 'SET-1');
    assert.equal(outgoing[0].settlement_reference_no, 'UTR-1');
    assert.deepEqual(outgoing[0].message, { name: 'amount matched', code: 'matched' });
    if (outgoing[1]) {
      assert.equal(outgoing[1].counterparty_recon_status, '03');
      assert.equal(outgoing[1].message.code, 'less');
    }
  }
  assert.throws(() => buildOnReceiverRecon(record, []), /at least one order/);
});

test('fills ONDC-required mock references for every assessment and preserves supplied references', () => {
  const record = { _id: 'mock-case', version: 1, updated_at: '2026-10-09T00:00:00.000Z', context: { transaction_id: 'mock-tx', bap_id: 'bap', bpp_id: 'bpp' } };
  const required = ['id', 'message', 'invoice_no', 'settlement_id', 'transaction_id', 'receiver_app_id', 'collector_app_id', 'order_recon_status', 'settlement_reference_no', 'counterparty_diff_amount', 'counterparty_recon_status'];
  const orders = ['matched', 'underpaid', 'overpaid', 'missing', 'unknown'].map(assessment => ({ id: assessment, assessment, difference_minor: assessment === 'unknown' ? null : 0 }));
  const build = (caseRecord, rows) => buildOnReceiverRecon(caseRecord, rows).payload.message.orderbook.orders;
  const outgoing = build(record, orders);
  for (const order of outgoing) {
    for (const field of required) assert.ok(Object.hasOwn(order, field), `${order.id} requires ${field}`);
    assert.match(order.invoice_no, /^MOCK-INV-/);
    assert.match(order.settlement_id, /^MOCK-SET-/);
    assert.match(order.settlement_reference_no, /^MOCK-UTR-/);
    assert.equal(typeof order.message.name, 'string');
    assert.equal(order.counterparty_diff_amount.value, '0.00');
  }
  assert.deepEqual(build({ ...record, version: 2 }, orders), outgoing);
  assert.equal(new Set(outgoing.map(order => order.settlement_id)).size, orders.length);
  assert.notEqual(build({ ...record, context: { ...record.context, transaction_id: 'other-tx' } }, orders)[0].settlement_id, outgoing[0].settlement_id);
  const supplied = createCaseOrder({ id: 'SUPPLIED', assessment: 'matched', invoiceNo: 'INV-123', settlementId: 'SET-123', reference: 'UTR-123' });
  const response = build(record, [{ ...supplied, difference_minor: 0 }])[0];
  assert.equal(response.invoice_no, 'INV-123');
  assert.equal(response.settlement_id, 'SET-123');
  assert.equal(response.settlement_reference_no, 'UTR-123');
});

test('keeps one orderbook row and creates a detail for each amount', () => {
  const context = { transaction_id: 'tx-1', bap_id: 'own-bap', bap_uri: 'http://local.test/bap', bpp_id: 'external', bpp_uri: 'https://np.test/ondc', country: 'IND', city: 'std:011', ttl: 'P1D', custom: { marker: 'preserved' }, location: { country: { code: 'IND' }, city: { code: 'std:080' } } };
  const snapshot = {
    _id: 'order-key', order_id: 'O1', transaction_id: 'tx-1', context,
    collector_id: 'own-bap', receiver_id: 'external', gross_minor: 18000,
    settlement_type: 'NEFT', payment: { status: 'PAID', collected_by: 'BAP', type: 'PRE-ORDER', params: { transaction_id: 'payment-1' } },
    raw_order: { status: 'ACTIVE', provider: { id: 'P1', descriptor: { name: 'Metro' } } }
  };
  const payload = buildReceiverReconGroup([{ snapshot, status: 'PAID', amountMinors: [10000, 7460] }], 'msg-1', '2026-09-29T00:00:00.000Z');
  assert.equal(payload.context.action, 'receiver_recon');
  for (const key of ['transaction_id', 'bap_id', 'bap_uri', 'bpp_id', 'bpp_uri', 'country', 'city', 'ttl']) assert.deepEqual(payload.context[key], context[key]);
  assert.equal(payload.context.core_version, '1.0.0');
  assert.equal('location' in payload.context, false);
  assert.equal('custom' in payload.context, false);
  assert.deepEqual(snapshot.context, context);
  assert.equal(payload.message.orderbook.orders.length, 1);
  const details = payload.message.orderbook.orders[0].payment['@ondc/org/settlement_details'];
  assert.deepEqual(details.map(detail => detail.settlement_amount), [100, 74.6]);
  assert.notEqual(details[0].settlement_reference, details[1].settlement_reference);
});

test('maps v2 source context to NTS 1.0.0 fields for both actions and stable retries', () => {
  const source = {
    domain: 'ONDC:TRV11', version: '2.0.0', core_version: '2.0.0',
    bap_id: 'abc.rsp.com', bap_uri: 'https://abc.rsp.com',
    bpp_id: 'abc.receiverapp.com', bpp_uri: 'https://abc.receiverapp.com',
    transaction_id: 'T1', message_id: 'M1', timestamp: '2026-10-07T00:00:00.000Z', ttl: 'P2D',
    location: { country: { code: 'IND' }, city: { code: 'std:080' } },
    collector_app_id: 'collector', receiver_app_id: 'receiver', extra: 'must-not-leak'
  };
  const original = structuredClone(source);
  for (const action of ['receiver_recon', 'on_receiver_recon']) {
    const context = normalizeNtsContext({ ...source, action });
    assert.deepEqual(context, {
      domain: 'ONDC:NTS10', country: 'IND', city: 'std:080', action, core_version: '1.0.0',
      bap_id: source.bap_id, bap_uri: source.bap_uri, bpp_id: source.bpp_id, bpp_uri: source.bpp_uri,
      transaction_id: 'T1', message_id: 'M1', timestamp: source.timestamp, ttl: 'P2D'
    });
    assert.deepEqual(normalizeNtsContext(context), context);
  }
  const record = { _id: 'v2-case', version: 1, context: source, updated_at: source.timestamp };
  const response = buildOnReceiverRecon(record, [{ id: 'O1', difference_minor: 100, assessment: 'underpaid' }]);
  assert.equal(response.payload.context.country, 'IND');
  assert.equal(response.payload.context.city, 'std:080');
  assert.equal('version' in response.payload.context, false);
  assert.equal('location' in response.payload.context, false);
  assert.equal(response.payload.message.orderbook.orders[0].collector_app_id, 'collector');
  assert.deepEqual(source, original);
});
