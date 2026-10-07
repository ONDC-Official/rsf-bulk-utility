import { createHash, randomUUID } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function unwrapPayload(input) {
  return input?.payload && typeof input.payload === 'object' ? input.payload : input;
}

export function amountToMinor(value, allowNegative = false) {
  const text = String(value ?? '').trim();
  const pattern = allowNegative ? /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/ : /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  if (!pattern.test(text)) throw new InputError('Amount must be an INR value with at most two decimals.');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const minor = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (text.startsWith('-') ? -1 : 1);
  if (!Number.isSafeInteger(minor)) throw new InputError('Amount is outside the supported range.');
  return minor;
}

export function minorToString(value) {
  const absolute = Math.abs(value);
  return `${value < 0 ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function normalizeSubscriberUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { throw new InputError('Enter a valid HTTP or HTTPS subscriber URL.'); }
}

export function deriveSubscriber(context) {
  if (!context?.bap_id || !context?.bpp_id) throw new InputError('Context must include bap_id and bpp_id.');
  normalizeSubscriberUrl(context.bpp_uri);
  return { subscriber_url: normalizeSubscriberUrl(context.bap_uri) };
}

export function validateSettlementInputs(expectedMinor, status, amounts) {
  if (!['PAID', 'NOT-PAID', 'UNDERPAID', 'OVERPAID'].includes(status)) throw new InputError('Choose a supported settlement status.');
  if (!Array.isArray(amounts) || !amounts.length) throw new InputError('Enter at least one settlement amount.');
  const amountMinors = amounts.map(value => amountToMinor(value, true));
  const total = amountMinors.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(total)) throw new InputError('Settlement total is outside the supported range.');
  return { amountMinors, total };
}

function findTag(order, code) {
  for (const payment of order.payments || []) {
    for (const tag of payment.tags || []) {
      if (tag.descriptor?.code !== 'SETTLEMENT_TERMS') continue;
      const found = tag.list?.find(item => item.descriptor?.code === code)?.value;
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function normalizeOnConfirm(raw) {
  const payload = unwrapPayload(raw);
  const context = payload?.context;
  const order = payload?.message?.order;
  if (context?.action !== 'on_confirm') throw new InputError('Payload context.action must be on_confirm.');
  if (!context.transaction_id || !context.bap_id || !context.bpp_id) throw new InputError('on_confirm must include transaction_id, bap_id, and bpp_id.');
  if (!order?.id) throw new InputError('on_confirm must include message.order.id.');
  const settlementValue = findTag(order, 'SETTLEMENT_AMOUNT');
  if (settlementValue === undefined) throw new InputError('Payment SETTLEMENT_TERMS must include SETTLEMENT_AMOUNT.');
  const payment = (order.payments || []).find(item => item.tags?.some(tag => tag.descriptor?.code === 'SETTLEMENT_TERMS')) || order.payments?.[0] || {};
  const currency = payment.params?.currency || order.quote?.price?.currency || 'INR';
  if (currency !== 'INR') throw new InputError('Only INR settlement amounts are supported by this mock.');
  return {
    raw: payload,
    context,
    order,
    transactionId: context.transaction_id,
    orderId: order.id,
    collectorId: context.bap_id,
    receiverId: context.bpp_id,
    grossAmountMinor: order.quote?.price?.value !== undefined ? amountToMinor(order.quote.price.value) : amountToMinor(payment.params?.amount),
    expectedSettlementMinor: amountToMinor(settlementValue),
    currency,
    settlementType: findTag(order, 'SETTLEMENT_TYPE') || 'NEFT',
    provider: order.provider || {},
    payment
  };
}

export function stableId(prefix, values, length = 18) {
  const hash = createHash('sha256').update(values.join('|')).digest('hex').slice(0, length).toUpperCase();
  return `${prefix}-${hash}`;
}

export function createMockSettlement(order, now = new Date()) {
  const identity = [order.transactionId, order.orderId, order.receiverId, 'cycle-1'];
  const settlementId = stableId('MOCK-SET', identity, 12);
  const reference = stableId('MOCK-UTR', identity, 16);
  return {
    settlement_id: settlementId,
    settlement_reference_no: reference,
    transaction_id: order.transactionId,
    order_id: order.orderId,
    receiver_id: order.receiverId,
    cycle: 'cycle-1',
    amount_minor: order.expectedSettlementMinor,
    currency: 'INR',
    status: 'PAID',
    timestamp: now.toISOString(),
    beneficiary: {
      account_no: process.env.MOCK_RECEIVER_ACCOUNT || 'MOCK-ACCOUNT-001',
      ifsc_code: process.env.MOCK_RECEIVER_IFSC || 'MOCK0000001',
      bank_name: process.env.MOCK_RECEIVER_BANK || 'Mock Bank',
      name: process.env.MOCK_RECEIVER_NAME || 'Mock Receiver'
    },
    is_mock: true
  };
}

function freshNtsContext(source, action, messageId, timestamp = new Date().toISOString()) {
  return {
    ...source,
    domain: process.env.NTS_DOMAIN || 'ONDC:NTS10',
    country: source.country || source.location?.country?.code || 'IND',
    city: source.city || source.location?.city?.code || 'std:080',
    action,
    core_version: process.env.NTS_CORE_VERSION || '1.0.0',
    bap_id: source.bap_id,
    bap_uri: source.bap_uri,
    bpp_id: source.bpp_id,
    bpp_uri: source.bpp_uri,
    transaction_id: source.transaction_id,
    message_id: messageId,
    timestamp,
    ttl: source.ttl || process.env.NTS_TTL || 'P2D'
  };
}

export function buildReceiverRecon(order, settlement) {
  const sourceOrder = order.order;
  const details = settlement.beneficiary;
  const payment = order.payment;
  const outboundOrder = {
    id: order.orderId,
    collector_app_id: order.collectorId,
    receiver_app_id: order.receiverId,
    state: sourceOrder.status,
    provider: {
      name: {
        name: sourceOrder.provider?.descriptor?.name || '',
        code: sourceOrder.provider?.id || ''
      }
    },
    payment: {
      params: {
        transaction_id: payment.params?.transaction_id,
        transaction_status: payment.status || 'PAID',
        amount: minorToString(order.grossAmountMinor),
        currency: order.currency
      },
      type: payment.type || 'PRE-ORDER',
      status: payment.status || 'PAID',
      collected_by: payment.collected_by || 'BAP',
      '@ondc/org/settlement_details': [{
        settlement_counterparty: 'seller-app',
        settlement_phase: 'sale-amount',
        settlement_amount: Number(minorToString(settlement.amount_minor)),
        settlement_type: String(order.settlementType).toLowerCase(),
        settlement_bank_account_no: details.account_no,
        settlement_ifsc_code: details.ifsc_code,
        bank_name: details.bank_name,
        beneficiary_name: details.name,
        settlement_status: settlement.status,
        settlement_reference: settlement.settlement_reference_no,
        settlement_timestamp: settlement.timestamp
      }]
    },
    settlement_reason_code: '01',
    transaction_id: order.transactionId,
    settlement_id: settlement.settlement_id,
    settlement_reference_no: settlement.settlement_reference_no,
    recon_status: '01',
    order_recon_status: '01',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const messageId = stableId('mock-recon', [settlement.settlement_id], 16);
  return {
    context: freshNtsContext(order.context, 'receiver_recon', messageId),
    message: { orderbook: { orders: [outboundOrder] } }
  };
}

export function buildReceiverReconGroup(entries, messageId, timestamp = new Date().toISOString()) {
  if (!entries.length) throw new InputError('Select at least one order.');
  const first = entries[0].snapshot;
  const orders = entries.map(({ snapshot, status, amountMinors }) => {
    const source = snapshot.raw_order;
    const payment = snapshot.payment;
    const settlementId = stableId('MOCK-SET', [snapshot._id, 'cycle-1'], 12);
    const references = amountMinors.map((_, index) => stableId('MOCK-UTR', [snapshot._id, 'cycle-1', String(index)], 16));
    const beneficiary = {
      account: process.env.MOCK_RECEIVER_ACCOUNT || '99679007677676',
      ifsc: process.env.MOCK_RECEIVER_IFSC || 'HDFC900008',
      bank: process.env.MOCK_RECEIVER_BANK || 'HDFC',
      name: process.env.MOCK_RECEIVER_NAME || 'A to Z Printing Solutions Pvt. Ltd'
    };
    return {
      id: snapshot.order_id,
      collector_app_id: snapshot.collector_id,
      receiver_app_id: snapshot.receiver_id,
      state: source.status,
      provider: { name: { name: source.provider?.descriptor?.name || '', code: source.provider?.id || '' } },
      payment: {
        params: { transaction_id: payment.params?.transaction_id, transaction_status: payment.status || 'PAID', amount: minorToString(snapshot.gross_minor), currency: 'INR' },
        type: payment.type || 'PRE-ORDER', status: payment.status || 'PAID', collected_by: payment.collected_by,
        '@ondc/org/collected_by_status': 'Assert', '@ondc/org/return_window': 'P6D',
        '@ondc/org/settlement_basis': 'Collection', '@ondc/org/settlement_window': 'P8D',
        '@ondc/org/settlement_details': amountMinors.map((amount, index) => ({
          settlement_counterparty: 'seller-app', settlement_phase: 'sale-amount', settlement_amount: Number(minorToString(amount)),
          settlement_type: String(snapshot.settlement_type || 'NEFT').toLowerCase(), settlement_status: status,
          settlement_bank_account_no: beneficiary.account, settlement_ifsc_code: beneficiary.ifsc,
          bank_name: beneficiary.bank, beneficiary_name: beneficiary.name,
          settlement_reference: references[index], settlement_timestamp: timestamp
        }))
      },
      settlement_reason_code: '01', transaction_id: snapshot.transaction_id,
      settlement_id: settlementId, settlement_reference_no: references[0],
      recon_status: '01', order_recon_status: '01',
      created_at: source.created_at || timestamp, updated_at: source.updated_at || timestamp
    };
  });
  return { context: freshNtsContext(first.context, 'receiver_recon', messageId, timestamp), message: { orderbook: { orders } } };
}

export function createCaseOrder({ id, expectedMinor = null, reportedMinor = null, receivedMinor = null, assessment = 'unknown', source = '', settlementId = null, reference = null }) {
  return {
    id,
    expected_minor: expectedMinor,
    reported_minor: reportedMinor,
    received_minor: receivedMinor,
    assessment,
    source,
    settlement_id: settlementId,
    settlement_reference_no: reference,
    notes: ''
  };
}

export function validateCaseOrder(order) {
  const allowed = ['matched', 'underpaid', 'overpaid', 'missing', 'unknown'];
  if (!order.id || !allowed.includes(order.assessment)) throw new InputError('Each order needs an ID and a supported assessment.');
  if (order.assessment === 'unknown') return;
  if (!Number.isSafeInteger(order.difference_minor)) throw new InputError(`Enter a difference amount for ${order.id}.`);
}

function responseOrder(order, context) {
  const result = {
    id: order.id,
    collector_app_id: context.collector_app_id || context.bap_id,
    receiver_app_id: context.receiver_app_id || context.bpp_id,
    transaction_id: context.transaction_id,
    order_recon_status: '02'
  };
  if (order.assessment === 'unknown') {
    result.counterparty_recon_status = '04';
    result.message = { name: 'order does not exist', code: '70010' };
    return result;
  }
  if (order.assessment !== 'missing' && order.settlement_id) result.settlement_id = order.settlement_id;
  if (order.assessment !== 'missing' && order.settlement_reference_no) result.settlement_reference_no = order.settlement_reference_no;
  if (order.assessment === 'missing') {
    result.counterparty_recon_status = '04';
    result.counterparty_diff_amount = { currency: 'INR', value: minorToString(order.difference_minor) };
    result.message = { name: 'order not settled', code: 'missing' };
    return result;
  }
  result.counterparty_recon_status = '03';
  result.counterparty_diff_amount = {
    currency: 'INR',
    value: minorToString(order.difference_minor)
  };
  result.message = order.assessment === 'overpaid'
    ? { name: 'excess amount', code: 'more' }
    : { name: 'lesser amount', code: 'less' };
  return result;
}

export function buildOnReceiverRecon(reconciliationCase, orders) {
  for (const order of orders) validateCaseOrder(order);
  const discrepancies = orders.filter(order => order.assessment !== 'matched');
  if (!discrepancies.length) return { noResponseRequired: true };
  const messageId = stableId('mock-onrr', [reconciliationCase._id, String(reconciliationCase.version)], 16);
  const timestamp = new Date(reconciliationCase.updated_at || reconciliationCase.created_at).toISOString();
  const payload = {
    context: freshNtsContext(reconciliationCase.context, 'on_receiver_recon', messageId, timestamp),
    message: { orderbook: { orders: discrepancies.map(order => responseOrder(order, reconciliationCase.context)) } }
  };
  return { payload, messageId, mockOverpaid: discrepancies.some(order => order.assessment === 'overpaid') };
}

export function newCaseId() {
  return randomUUID();
}
