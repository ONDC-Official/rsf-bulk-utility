import { db } from './db.js';
import { amountToMinor, createCaseOrder, deriveSubscriber, normalizeOnConfirm, stableId } from './domain.js';

const subscriberUrl = process.env.DEMO_SUBSCRIBER_URL || 'http://localhost:3000/mock-np';
const ownSubscriberId = process.env.ONDC_SUBSCRIBER_ID;
const ownBapUri = process.env.OWN_BAP_URI || 'http://localhost:3000/own/bap';
const ownBppUri = process.env.OWN_BPP_URI || 'http://localhost:3000/own/bpp';

function onConfirm(orderId, transactionId, expected, ownCollector) {
  const context = {
    domain: 'ONDC:TRV11', action: 'on_confirm', version: '2.0.0',
    transaction_id: transactionId, message_id: `demo-${orderId}`,
    bap_id: ownCollector ? ownSubscriberId : 'demo-subscriber.local',
    bap_uri: ownCollector ? ownBapUri : subscriberUrl,
    bpp_id: ownCollector ? 'demo-subscriber.local' : ownSubscriberId,
    bpp_uri: ownCollector ? subscriberUrl : ownBppUri,
    location: { country: { code: 'IND' }, city: { code: 'std:080' } },
    timestamp: '2026-09-29T10:35:00.000Z', ttl: 'PT30S'
  };
  return { context, message: { order: {
    id: orderId, status: 'ACTIVE', provider: { id: 'P1', descriptor: { name: 'ONDC Metro Rail Limited' } },
    quote: { price: { currency: 'INR', value: expected } },
    payments: [{ id: `PAY-${orderId}`, collected_by: 'BAP', status: 'PAID', type: 'PRE-ORDER',
      params: { transaction_id: `payment-${orderId}`, amount: expected, currency: 'INR' },
      tags: [{ descriptor: { code: 'SETTLEMENT_TERMS' }, list: [
        { descriptor: { code: 'SETTLEMENT_AMOUNT' }, value: expected },
        { descriptor: { code: 'SETTLEMENT_TYPE' }, value: 'NEFT' }
      ] }]
    }], created_at: '2026-09-29T10:35:00.000Z', updated_at: '2026-09-29T10:35:00.000Z'
  } } };
}

async function seedOnConfirm(payload) {
  const parsed = normalizeOnConfirm(payload);
  const route = deriveSubscriber(payload.context);
  const collectorId = payload.context.bap_id;
  const receiverId = payload.context.bpp_id;
  const key = stableId('ORDER', [parsed.transactionId, parsed.orderId, receiverId], 32);
  const inboundId = `demo-on-confirm-${parsed.orderId}`;
  await db().collection('inbound_messages').updateOne({ _id: inboundId }, { $setOnInsert: {
    _id: inboundId, action: 'on_confirm', message_id: payload.context.message_id,
    transaction_id: parsed.transactionId, source: 'demo', received_at: new Date(), raw_payload: payload
  } }, { upsert: true });
  await db().collection('order_snapshots').updateOne({ _id: key }, { $setOnInsert: {
    _id: key, transaction_id: parsed.transactionId, order_id: parsed.orderId,
    receiver_id: receiverId, collector_id: collectorId, subscriber_url: route.subscriber_url,
    local_role: route.own_side === 'BAP' ? 'collector' : 'receiver',
    receiver_send_state: 'unsent', has_received_recon: false,
    context: payload.context, payment: parsed.payment, settlement_type: parsed.settlementType,
    provider_name: parsed.order.provider.descriptor.name, expected_minor: parsed.expectedSettlementMinor,
    gross_minor: parsed.grossAmountMinor, currency: 'INR', source_message_id: inboundId,
    raw_order: parsed.order, created_at: new Date()
  } }, { upsert: true });
  await db().collection('routing_contexts').updateOne({ _id: key }, { $setOnInsert: {
    _id: key, transaction_id: parsed.transactionId, order_id: parsed.orderId,
    bap_id: payload.context.bap_id, bap_uri: payload.context.bap_uri,
    bpp_id: payload.context.bpp_id, bpp_uri: payload.context.bpp_uri,
    collected_by: 'BAP', subscriber_url: route.subscriber_url,
    external_side: route.external_side, source_message_id: inboundId, created_at: new Date()
  } }, { upsert: true });
}

async function seedReceivedRecon() {
  const transactionId = 'demo-received-recon-001';
  const inboundId = `demo-receiver-recon-${transactionId}`;
  const payload = {
    context: { domain: 'ONDC:NTS10', action: 'receiver_recon', core_version: '1.0.0',
      transaction_id: transactionId, message_id: inboundId,
      bap_id: 'demo-subscriber.local', bap_uri: subscriberUrl,
      bpp_id: ownSubscriberId, bpp_uri: ownBppUri,
      country: 'IND', city: 'std:080', timestamp: '2026-09-29T10:42:00.000Z', ttl: 'P2D' },
    message: { orderbook: { orders: [
      { id: 'REC-10021', payment: { '@ondc/org/settlement_details': [{ settlement_amount: 1250, settlement_status: 'PAID' }] } },
      { id: 'REC-10022', payment: { '@ondc/org/settlement_details': [{ settlement_amount: 2000, settlement_status: 'PAID' }] } }
    ] } }
  };
  await db().collection('inbound_messages').updateOne({ _id: inboundId }, { $setOnInsert: {
    _id: inboundId, action: 'receiver_recon', message_id: inboundId,
    transaction_id: transactionId, source: 'demo', received_at: new Date(), raw_payload: payload
  } }, { upsert: true });
  const caseId = `demo-case-${transactionId}`;
  await db().collection('reconciliation_cases').updateOne({ _id: caseId }, { $setOnInsert: {
    _id: caseId, source_type: 'received_receiver_recon', source_message_id: inboundId,
    subscriber_url: subscriberUrl, transaction_id: transactionId,
    context: payload.context, source_payload: payload, status: 'draft', version: 1,
    orders: [
      createCaseOrder({ id: 'REC-10021', expectedMinor: amountToMinor('1250'), reportedMinor: amountToMinor('1250'), receivedMinor: amountToMinor('1250'), assessment: 'matched', source: 'Received receiver_recon' }),
      createCaseOrder({ id: 'REC-10022', expectedMinor: amountToMinor('2000'), reportedMinor: amountToMinor('2000'), receivedMinor: amountToMinor('1800'), assessment: 'underpaid', source: 'Received receiver_recon' })
    ], created_at: new Date(), updated_at: new Date()
  } }, { upsert: true });
}

export async function seedDemoData() {
  if (process.env.SEED_DEMO === 'false') return;
  await seedOnConfirm(onConfirm('MTR-10021', 'demo-collector-001', '174.60', true));
  await seedOnConfirm(onConfirm('MTR-10022', 'demo-collector-001', '60.00', true));
  await seedOnConfirm(onConfirm('MTR-10023', 'demo-collector-002', '95.00', true));
  await seedOnConfirm(onConfirm('MTR-20110', 'demo-receiver-010', '300.00', false));
  await seedOnConfirm(onConfirm('MTR-20111', 'demo-receiver-011', '450.00', false));
  await seedOnConfirm(onConfirm('MTR-20112', 'demo-receiver-012', '200.00', false));
  await seedReceivedRecon();
}
