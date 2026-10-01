import express from 'express';
import { db, connectDatabase, closeDatabase } from './db.js';
import {
  InputError, amountToMinor, buildOnReceiverRecon, buildReceiverReconGroup,
  createCaseOrder, deriveSubscriber, minorToString, newCaseId, normalizeOnConfirm,
  normalizeSubscriberUrl, stableId, unwrapPayload, validateCaseOrder, validateSettlementInputs
} from './domain.js';
import { seedDemoData } from './seed.js';
import { AuthError, validateAuthConfig, verifyOnDcAuthorization } from './auth.js';
import { deliverPayload, resolveDeliveryTarget } from './delivery.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const jsonParser = express.json({ limit: '5mb', verify: (req, _res, buffer) => { req.rawBody = buffer.toString('utf8'); } });
app.use(jsonParser);

function inboundKey(action, messageId, raw) {
  return `${action}:${messageId || stableId('BODY', [JSON.stringify(raw)], 32)}`;
}

async function saveInbound({ action, raw, payload, source = 'np' }) {
  const messageId = payload.context.message_id || stableId('inbound', [JSON.stringify(payload)], 20);
  const transactionId = payload.context.transaction_id;
  const id = inboundKey(action, messageId, raw);
  const result = await db().collection('inbound_messages').updateOne({ _id: id }, { $setOnInsert: {
    _id: id, action, message_id: messageId, transaction_id: transactionId,
    sender_id: payload.context.bap_id, source, received_at: new Date(), raw_payload: raw
  } }, { upsert: true });
  return { id, messageId, transactionId, duplicate: result.upsertedCount === 0 };
}

function reportedAmount(order) {
  const details = order.payment?.['@ondc/org/settlement_details'] || order.payment?.settlement_details || [];
  if (!details.length) return null;
  return details.reduce((sum, detail) => sum + amountToMinor(detail.settlement_amount), 0);
}

function publicCase(doc) {
  if (!doc) return null;
  const { _id, source_payload, ...data } = doc;
  return { id: _id, ...data, source_payload };
}

app.get('/api/health', async (_req, res, next) => {
  try { await db().command({ ping: 1 }); res.json({ status: 'ok', database: 'connected' }); }
  catch (error) { next(error); }
});

app.post('/api/inbound/on_confirm', async (req, res, next) => {
  try {
    const raw = req.body;
    await verifyOnDcAuthorization({ header: req.get('authorization'), bodyText: req.rawBody, context: raw?.context || raw?.payload?.context });
    const order = normalizeOnConfirm(raw);
    const inbound = await saveInbound({ action: 'on_confirm', raw, payload: order.raw });
    const route = deriveSubscriber(order.context);
    const collectorSide = order.payment.collected_by;
    if (!['BAP', 'BPP'].includes(collectorSide)) throw new InputError('on_confirm payment.collected_by must be BAP or BPP.');
    const collectorId = collectorSide === 'BAP' ? order.context.bap_id : order.context.bpp_id;
    const receiverId = collectorSide === 'BAP' ? order.context.bpp_id : order.context.bap_id;
    const localRole = collectorSide === route.own_side ? 'collector' : 'receiver';
    const snapshot = {
      _id: stableId('ORDER', [order.transactionId, order.orderId, receiverId], 32),
      transaction_id: order.transactionId, order_id: order.orderId, receiver_id: receiverId,
      collector_id: collectorId, subscriber_url: route.subscriber_url, local_role: localRole,
      receiver_send_state: 'unsent', has_received_recon: false,
      context: order.context, payment: order.payment, settlement_type: order.settlementType,
      provider_name: order.order.provider?.descriptor?.name || '',
      expected_minor: order.expectedSettlementMinor,
      gross_minor: order.grossAmountMinor, currency: order.currency,
      source_message_id: inbound.id, raw_order: order.order, created_at: new Date()
    };
    await db().collection('order_snapshots').updateOne({ _id: snapshot._id }, { $setOnInsert: snapshot }, { upsert: true });
    await db().collection('routing_contexts').updateOne({ _id: snapshot._id }, { $setOnInsert: {
      _id: snapshot._id, transaction_id: order.transactionId, order_id: order.orderId,
      bap_id: order.context.bap_id, bap_uri: order.context.bap_uri,
      bpp_id: order.context.bpp_id, bpp_uri: order.context.bpp_uri,
      collected_by: collectorSide, subscriber_url: route.subscriber_url,
      external_side: route.external_side, source_message_id: inbound.id, created_at: new Date()
    } }, { upsert: true });
    res.status(inbound.duplicate ? 200 : 202).json({ duplicate: inbound.duplicate, order_key: snapshot._id, subscriber_url: route.subscriber_url, local_role: localRole });
  } catch (error) { next(error); }
});

app.post('/api/inbound/receiver_recon', async (req, res, next) => {
  try {
    const raw = req.body;
    const payload = unwrapPayload(raw);
    await verifyOnDcAuthorization({ header: req.get('authorization'), bodyText: req.rawBody, context: payload?.context });
    if (payload?.context?.action !== 'receiver_recon') throw new InputError('Payload context.action must be receiver_recon.');
    if (!payload.context.transaction_id || !Array.isArray(payload.message?.orderbook?.orders)) throw new InputError('receiver_recon requires transaction_id and message.orderbook.orders[].');
    const inbound = await saveInbound({ action: 'receiver_recon', raw, payload });
    const route = deriveSubscriber(payload.context);
    if (inbound.duplicate) {
      const existing = await db().collection('reconciliation_cases').findOne({ source_message_id: inbound.id });
      return res.status(200).json({ duplicate: true, case: publicCase(existing) });
    }
    const rows = [];
    for (const incoming of payload.message.orderbook.orders) {
      if (!incoming?.id) throw new InputError('Every receiver_recon order must include id.');
      const local = await db().collection('order_snapshots').findOne({ subscriber_url: route.subscriber_url, transaction_id: payload.context.transaction_id, order_id: incoming.id });
      if (local) await db().collection('order_snapshots').updateOne({ _id: local._id }, { $set: { has_received_recon: true } });
      const reportMinor = reportedAmount(incoming);
      const expectedMinor = local?.expected_minor ?? reportMinor;
      const receivedMinor = reportMinor ?? expectedMinor;
      const assessment = local ? (reportMinor === expectedMinor ? 'matched' : 'unknown') : 'unknown';
      rows.push(createCaseOrder({
        id: incoming.id, expectedMinor, reportedMinor: reportMinor, receivedMinor,
        assessment, source: 'Received receiver_recon', settlementId: incoming.settlement_id || null,
        reference: incoming.settlement_reference_no || null
      }));
    }
    const caseId = newCaseId();
    const record = {
      _id: caseId, source_type: 'received_receiver_recon', source_message_id: inbound.id,
      transaction_id: payload.context.transaction_id, subscriber_url: route.subscriber_url,
      context: { ...payload.context,
        collector_app_id: payload.message.orderbook.orders[0]?.collector_app_id || payload.context.bap_id,
        receiver_app_id: payload.message.orderbook.orders[0]?.receiver_app_id || payload.context.bpp_id },
      source_payload: payload,
      status: 'draft', version: 1, orders: rows, created_at: new Date(), updated_at: new Date()
    };
    await db().collection('reconciliation_cases').insertOne(record);
    res.status(201).json({ case: publicCase(record) });
  } catch (error) { next(error); }
});

function subscriberFromQuery(req) {
  return normalizeSubscriberUrl(req.query.subscriber_url);
}

function safeSearch(value) {
  return String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

app.get('/api/subscriber-urls', async (req, res, next) => {
  try {
    const prefix = String(req.query.prefix || '').trim();
    if (!prefix) return res.json({ subscriber_urls: [] });
    const pattern = new RegExp(`^${safeSearch(prefix)}`, 'i');
    const [orderUrls, caseUrls] = await Promise.all([
      db().collection('order_snapshots').distinct('subscriber_url', { subscriber_url: pattern }),
      db().collection('reconciliation_cases').distinct('subscriber_url', { subscriber_url: pattern })
    ]);
    const subscriberUrls = [...new Set([...orderUrls, ...caseUrls].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    res.json({ subscriber_urls: subscriberUrls });
  } catch (error) { next(error); }
});

function orderSummary(order) {
  return {
    key: order._id, order_id: order.order_id, transaction_id: order.transaction_id,
    provider: order.provider_name, expected_minor: order.expected_minor,
    gross_minor: order.gross_minor, receiver_send_state: order.receiver_send_state || 'unsent',
    unsolicited_send_state: order.unsolicited_send_state || 'unsent',
    receiver_draft_id: order.receiver_draft_id,
    sent_at: order.sent_at, source_message_id: order.source_message_id,
    subscriber_url: order.subscriber_url
  };
}

app.get('/api/subscriber/orders', async (req, res, next) => {
  try {
    const subscriber = subscriberFromQuery(req);
    const collection = db().collection('order_snapshots');
    const base = { subscriber_url: subscriber, local_role: 'collector' };
    const state = String(req.query.state || 'unsent');
    if (!['all', 'unsent', 'sent'].includes(state)) throw new InputError('Invalid send-state filter.');
    const filter = { ...base };
    if (state === 'sent') filter.receiver_send_state = 'sent';
    if (state === 'unsent') filter.receiver_send_state = { $ne: 'sent' };
    const query = safeSearch(req.query.query);
    if (query) filter.$or = [{ order_id: { $regex: query, $options: 'i' } }, { transaction_id: { $regex: query, $options: 'i' } }];
    if (req.query.cursor) filter._id = { $gt: String(req.query.cursor) };
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const docs = await collection.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    const counts = { unsent: await collection.countDocuments({ ...base, receiver_send_state: { $ne: 'sent' } }), sent: await collection.countDocuments({ ...base, receiver_send_state: 'sent' }) };
    res.json({ orders: docs.slice(0, limit).map(orderSummary), next_cursor: docs.length > limit ? docs[limit - 1]._id : null, counts });
  } catch (error) { next(error); }
});

app.get('/api/receiver-recon/sent', async (req, res, next) => {
  try {
    const key = String(req.query.order_key || '');
    if (!key) throw new InputError('order_key is required.');
    const record = await db().collection('outbound_messages').findOne({ action: 'receiver_recon', order_keys: key, status: 'sent' });
    if (!record) throw new InputError('Sent payload not found for this order.', 404);
    res.json({ payload: record.payload, response: record.response, sent_at: record.sent_at });
  } catch (error) { next(error); }
});

app.post('/api/receiver-recon/preview', async (req, res, next) => {
  try {
    const subscriber = normalizeSubscriberUrl(req.body.subscriber_url);
    const requested = req.body.orders;
    if (!Array.isArray(requested) || !requested.length) throw new InputError('Select at least one order.');
    if (new Set(requested.map(row => row.key)).size !== requested.length) throw new InputError('Each order may be selected once.');
    const snapshots = await db().collection('order_snapshots').find({ _id: { $in: requested.map(row => row.key) } }).toArray();
    const byKey = new Map(snapshots.map(row => [row._id, row]));
    const grouped = new Map();
    for (const input of requested) {
      const snapshot = byKey.get(input.key);
      if (!snapshot || snapshot.subscriber_url !== subscriber || snapshot.local_role !== 'collector') throw new InputError(`Order ${input.key} is not eligible for this subscriber.`, 403);
      if (snapshot.receiver_send_state && snapshot.receiver_send_state !== 'unsent') throw new InputError(`Order ${snapshot.order_id} is already sent or reserved.`, 409);
      const { amountMinors } = validateSettlementInputs(snapshot.expected_minor, input.status, input.amounts);
      const context = snapshot.context;
      const key = JSON.stringify([snapshot.transaction_id, context.bap_id, context.bap_uri, context.bpp_id, context.bpp_uri]);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ snapshot, status: input.status, amountMinors });
    }
    const draftId = newCaseId();
    const timestamp = new Date().toISOString();
    const groups = [...grouped].map(([key, entries]) => {
      const messageId = stableId('mock-recon', [draftId, key], 16);
      return { message_id: messageId, order_keys: entries.map(entry => entry.snapshot._id), status: 'draft',
        payload: buildReceiverReconGroup(entries, messageId, timestamp) };
    });
    await db().collection('receiver_drafts').insertOne({ _id: draftId, subscriber_url: subscriber,
      order_keys: requested.map(row => row.key), groups, created_at: new Date() });
    res.json({ draft_id: draftId, groups });
  } catch (error) { next(error); }
});

app.post('/api/receiver-recon/send', async (req, res, next) => {
  try {
    const draft = await db().collection('receiver_drafts').findOne({ _id: req.body.draft_id });
    if (!draft) throw new InputError('Receiver reconciliation draft not found. Preview again.', 404);
    const target = resolveDeliveryTarget(req.body.use_tunnel, draft.subscriber_url);
    const outcomes = [];
    for (const group of draft.groups) {
      const outbound = db().collection('outbound_messages');
      await outbound.updateOne({ _id: group.message_id }, { $setOnInsert: {
        _id: group.message_id, message_id: group.message_id, action: 'receiver_recon',
        transaction_id: group.payload.context.transaction_id, draft_id: draft._id,
        subscriber_url: draft.subscriber_url, order_keys: group.order_keys,
        payload: group.payload, status: 'queued', attempt_count: 0, created_at: new Date()
      } }, { upsert: true });
      const stored = await outbound.findOne({ _id: group.message_id });
      if (stored.status === 'sent') {
        outcomes.push({ message_id: group.message_id, status: 'sent', downstream_status: 200, response: stored.response });
        continue;
      }
      const claim = await outbound.findOneAndUpdate(
        { _id: group.message_id, status: { $in: ['queued', 'send_failed'] } },
        { $set: { status: 'sending', delivery_mode: target.mode, destination_url: `${target.baseUrl}/receiver_recon`, updated_at: new Date() }, $inc: { attempt_count: 1 } },
        { returnDocument: 'after' }
      );
      if (!claim) { outcomes.push({ message_id: group.message_id, status: 'sending' }); continue; }
      const snapshots = db().collection('order_snapshots');
      const claimed = await snapshots.updateMany({ _id: { $in: group.order_keys },
        $or: [{ receiver_send_state: 'unsent' }, { receiver_send_state: 'send_failed', receiver_draft_id: draft._id }] },
      { $set: { receiver_send_state: 'sending', receiver_draft_id: draft._id, updated_at: new Date() } });
      if (claimed.modifiedCount !== group.order_keys.length) {
        await snapshots.updateMany({ _id: { $in: group.order_keys }, receiver_draft_id: draft._id, receiver_send_state: 'sending' },
          { $set: { receiver_send_state: 'unsent', updated_at: new Date() }, $unset: { receiver_draft_id: '' } });
        await outbound.updateOne({ _id: group.message_id }, { $set: { status: 'send_failed', error: 'One or more orders were claimed by another request.' } });
        outcomes.push({ message_id: group.message_id, status: 'send_failed', error: 'One or more orders were claimed by another request.' });
        continue;
      }
      try {
        const response = await deliverPayload('receiver_recon', group.payload, target);
        if (response.status !== 200) throw Object.assign(new Error(`${target.mode === 'tunnel' ? 'Tunnel' : 'Subscriber'} returned HTTP ${response.status}.`), { downstream_status: response.status, response: response.body });
        await db().collection('mock_settlements').bulkWrite(group.payload.message.orderbook.orders.map((order, index) => ({
          updateOne: {
            filter: { transaction_id: group.payload.context.transaction_id, order_id: order.id, receiver_id: order.receiver_app_id, cycle: 1 },
            update: { $setOnInsert: {
              _id: order.settlement_id, transaction_id: group.payload.context.transaction_id,
              order_id: order.id, receiver_id: order.receiver_app_id, cycle: 1,
              order_key: group.order_keys[index], message_id: group.message_id,
              settlement_id: order.settlement_id, settlement_reference_no: order.settlement_reference_no,
              status: order.payment['@ondc/org/settlement_details'][0].settlement_status,
              details: order.payment['@ondc/org/settlement_details'], created_at: new Date()
            } }, upsert: true
          }
        })));
        await outbound.updateOne({ _id: group.message_id }, { $set: { status: 'sent', response: response.body, downstream_status: 200, sent_at: new Date(), updated_at: new Date() } });
        await snapshots.updateMany({ _id: { $in: group.order_keys }, receiver_draft_id: draft._id }, { $set: { receiver_send_state: 'sent', sent_at: new Date(), updated_at: new Date() } });
        outcomes.push({ message_id: group.message_id, status: 'sent', downstream_status: 200, response: response.body });
      } catch (error) {
        await outbound.updateOne({ _id: group.message_id }, { $set: { status: 'send_failed', error: error.message, downstream_status: error.downstream_status || null, response: error.response || null, updated_at: new Date() } });
        await snapshots.updateMany({ _id: { $in: group.order_keys }, receiver_draft_id: draft._id }, { $set: { receiver_send_state: 'send_failed', updated_at: new Date() } });
        outcomes.push({ message_id: group.message_id, status: 'send_failed', downstream_status: error.downstream_status || null, error: error.message });
      }
    }
    res.json({ draft_id: draft._id, groups: outcomes });
  } catch (error) { next(error); }
});

app.get('/api/subscriber/reconciliations', async (req, res, next) => {
  try {
    const subscriber = subscriberFromQuery(req);
    const transactionId = String(req.query.transaction_id || '').trim();
    if (!transactionId) throw new InputError('transaction_id is required.');
    const cases = await db().collection('reconciliation_cases').find({
      subscriber_url: subscriber, source_type: 'received_receiver_recon', transaction_id: transactionId
    }).sort({ created_at: -1 }).limit(50).toArray();
    res.json({ cases: cases.map(record => ({ id: record._id, transaction_id: record.transaction_id,
      order_count: record.orders.length, status: record.status, created_at: record.created_at })) });
  } catch (error) { next(error); }
});

app.get('/api/subscriber/known-orders', async (req, res, next) => {
  try {
    const subscriber = subscriberFromQuery(req);
    const filter = { subscriber_url: subscriber, local_role: 'receiver', has_received_recon: { $ne: true },
      unsolicited_sent: { $ne: true }, unsolicited_send_state: { $nin: ['sending', 'sent', 'send_failed'] } };
    const query = safeSearch(req.query.query);
    if (query) filter.order_id = { $regex: query, $options: 'i' };
    if (req.query.cursor) filter._id = { $gt: String(req.query.cursor) };
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const docs = await db().collection('order_snapshots').find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    res.json({ orders: docs.slice(0, limit).map(orderSummary), next_cursor: docs.length > limit ? docs[limit - 1]._id : null });
  } catch (error) { next(error); }
});

app.get('/api/subscriber/unsolicited-cases', async (req, res, next) => {
  try {
    const subscriber = subscriberFromQuery(req);
    const records = await db().collection('reconciliation_cases').find({ subscriber_url: subscriber,
      source_type: 'unsolicited', 'orders.0': { $exists: true }, status: { $in: ['draft', 'send_failed', 'sending'] } })
      .sort({ updated_at: -1 }).limit(50).toArray();
    res.json({ cases: records.map(record => ({ id: record._id, status: record.status,
      order_count: record.orders.length, updated_at: record.updated_at })) });
  } catch (error) { next(error); }
});

app.post('/api/cases/unsolicited', async (req, res, next) => {
  try {
    const subscriber = normalizeSubscriberUrl(req.body.subscriber_url);
    const keys = req.body.order_keys ?? [];
    if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw new InputError('Saved order selections must be a list of distinct keys.');
    if (!keys.length) {
      const identityFilter = { subscriber_url: subscriber, $or: [
        { bap_id: process.env.ONDC_SUBSCRIBER_ID }, { bpp_id: process.env.ONDC_SUBSCRIBER_ID }
      ] };
      let route = await db().collection('routing_contexts').findOne(identityFilter, { sort: { created_at: -1, _id: -1 } });
      if (!route) {
        const previous = await db().collection('reconciliation_cases').findOne({ subscriber_url: subscriber,
          $or: [{ 'context.bap_id': process.env.ONDC_SUBSCRIBER_ID }, { 'context.bpp_id': process.env.ONDC_SUBSCRIBER_ID }] },
        { sort: { created_at: -1, _id: -1 } });
        route = previous?.context;
      }
      if (!route || !route.bap_uri || !route.bpp_uri || deriveSubscriber(route).subscriber_url !== subscriber) {
        throw new InputError('No saved routing context for this subscriber. Receive an on_confirm or receiver_recon from this NP before creating custom orders.', 409);
      }
      const transactionId = newCaseId();
      const collectedByBpp = route.collected_by === 'BPP';
      const record = {
        _id: newCaseId(), source_type: 'unsolicited', subscriber_url: subscriber,
        transaction_id: transactionId,
        context: { ...route, transaction_id: transactionId,
          collector_app_id: route.collector_app_id || (collectedByBpp ? route.bpp_id : route.bap_id),
          receiver_app_id: route.receiver_app_id || (collectedByBpp ? route.bap_id : route.bpp_id) },
        source_payload: null, source_order_keys: [], orders: [], status: 'draft', version: 1,
        created_at: new Date(), updated_at: new Date()
      };
      await db().collection('reconciliation_cases').insertOne(record);
      return res.status(201).json({ cases: [publicCase(record)] });
    }
    const snapshots = await db().collection('order_snapshots').find({ _id: { $in: keys } }).toArray();
    if (snapshots.length !== keys.length) throw new InputError('One or more selected orders were not found.', 404);
    const savedRoutes = await db().collection('routing_contexts').find({ _id: { $in: keys } }).toArray();
    const routesByKey = new Map(savedRoutes.map(route => [route._id, route]));
    const grouped = new Map();
    for (const snapshot of snapshots) {
      if (snapshot.subscriber_url !== subscriber || snapshot.local_role !== 'receiver' || snapshot.has_received_recon || snapshot.unsolicited_sent ||
        (snapshot.unsolicited_send_state && snapshot.unsolicited_send_state !== 'unsent')) throw new InputError(`Order ${snapshot.order_id} is not eligible for unsolicited review.`, 409);
      const route = routesByKey.get(snapshot._id);
      if (!route || !route.bap_id || !route.bap_uri || !route.bpp_id || !route.bpp_uri || route.subscriber_url !== subscriber) throw new InputError(`Saved routing context is incomplete for ${snapshot.order_id}.`, 409);
      const context = route;
      const baseKey = JSON.stringify([context.bap_id, context.bap_uri, context.bpp_id, context.bpp_uri]);
      let groupKey = baseKey;
      for (let index = 1; grouped.get(groupKey)?.some(order => order.order_id === snapshot.order_id); index++) groupKey = `${baseKey}#${index}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(snapshot);
    }
    const cases = [];
    for (const group of grouped.values()) {
      const caseId = newCaseId();
      const transactionId = newCaseId();
      const route = routesByKey.get(group[0]._id);
      const context = { ...group[0].context, bap_id: route.bap_id, bap_uri: route.bap_uri,
        bpp_id: route.bpp_id, bpp_uri: route.bpp_uri, transaction_id: transactionId,
        collector_app_id: group[0].collector_id, receiver_app_id: group[0].receiver_id };
      const record = {
        _id: caseId, source_type: 'unsolicited', subscriber_url: subscriber,
        transaction_id: transactionId, context, source_payload: null,
        source_order_keys: group.map(order => order._id),
        status: 'draft', version: 1,
        orders: group.map(order => createCaseOrder({ id: order.order_id, expectedMinor: order.expected_minor,
          reportedMinor: null, receivedMinor: 0, assessment: 'missing', source: 'Saved on_confirm' })),
        created_at: new Date(), updated_at: new Date()
      };
      await db().collection('reconciliation_cases').insertOne(record);
      cases.push(publicCase(record));
    }
    res.status(201).json({ cases });
  } catch (error) { next(error); }
});

app.get('/api/automatic/latest', async (_req, res, next) => {
  try {
    const outbound = await db().collection('outbound_messages').find({ action: 'receiver_recon' }).sort({ created_at: -1 }).limit(1).next();
    if (!outbound) return res.json({ transaction: null });
    const source = await db().collection('inbound_messages').findOne({ _id: outbound.source_message_id });
    const settlement = await db().collection('mock_settlements').findOne({ _id: outbound.settlement_id });
    res.json({ transaction: { source_payload: source?.raw_payload, receiver_recon: outbound.payload, delivery: outbound.status, response: outbound.response, settlement } });
  } catch (error) { next(error); }
});

app.get('/api/transactions', async (req, res, next) => {
  try {
    const transactionId = String(req.query.transaction_id || '').trim();
    if (!transactionId) throw new InputError('transaction_id is required.');
    const cases = await db().collection('reconciliation_cases').find({ transaction_id: { $regex: transactionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }).sort({ created_at: -1 }).limit(25).toArray();
    res.json({ cases: cases.map(doc => ({ id: doc._id, transaction_id: doc.transaction_id, source_type: doc.source_type, status: doc.status, order_count: doc.orders.length, created_at: doc.created_at })) });
  } catch (error) { next(error); }
});

app.get('/api/cases/:id', async (req, res, next) => {
  try {
    const record = await db().collection('reconciliation_cases').findOne({ _id: req.params.id });
    if (!record) throw new InputError('Reconciliation case not found.', 404);
    res.json({ case: publicCase(record) });
  } catch (error) { next(error); }
});

app.delete('/api/cases/:id', async (req, res, next) => {
  try {
    const subscriber = subscriberFromQuery(req);
    const result = await db().collection('reconciliation_cases').deleteOne({ _id: req.params.id, subscriber_url: subscriber });
    if (!result.deletedCount) throw new InputError('Reconciliation case not found.', 404);
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

app.post('/api/cases/manual', async (req, res, next) => {
  try {
    const raw = req.body.payload;
    if (!raw || typeof raw !== 'object') throw new InputError('Paste an on_confirm payload.');
    const normalized = normalizeOnConfirm(raw);
    const caseId = newCaseId();
    const inboundId = `manual:${caseId}`;
    const record = {
      _id: caseId, source_type: 'manual_on_confirm', source_message_id: inboundId,
      transaction_id: normalized.transactionId, context: normalized.context, source_payload: unwrapPayload(raw),
      status: 'draft', version: 1,
      orders: [createCaseOrder({
        id: normalized.orderId, expectedMinor: normalized.expectedSettlementMinor,
        reportedMinor: null, receivedMinor: normalized.expectedSettlementMinor,
        assessment: 'matched', source: 'Pasted on_confirm'
      })],
      created_at: new Date(), updated_at: new Date()
    };
    await db().collection('inbound_messages').insertOne({
      _id: inboundId, action: 'on_confirm', message_id: normalized.context.message_id || inboundId,
      transaction_id: normalized.transactionId, source: 'manual', received_at: new Date(), raw_payload: raw
    });
    await db().collection('reconciliation_cases').insertOne(record);
    res.status(201).json({ case: publicCase(record) });
  } catch (error) { next(error); }
});

app.put('/api/cases/:id/draft', async (req, res, next) => {
  try {
    const collection = db().collection('reconciliation_cases');
    const record = await collection.findOne({ _id: req.params.id });
    if (!record) throw new InputError('Reconciliation case not found.', 404);
    if (record.status === 'sent' || record.status === 'sending') throw new InputError('This reconciliation can no longer be edited.', 409);
    if (req.body.version !== record.version) throw new InputError('This draft changed elsewhere. Reload before saving.', 409);
    if (!Array.isArray(req.body.orders)) throw new InputError('orders must be an array.');
    const existing = new Map(record.orders.map(order => [order.id, order]));
    const submitted = req.body.orders.map(row => {
      const original = existing.get(row.id);
      if (!original && row.source !== 'Added missing order') throw new InputError(`Unexpected order ${row.id}.`);
      const assessment = row.assessment;
      const difference = assessment === 'unknown' ? null : amountToMinor(row.difference_amount, true);
      const saved = { ...(original || {}), id: row.id, difference_minor: difference, assessment, notes: String(row.notes || '').slice(0, 1000) };
      if (!original) { saved.source = 'Added missing order'; saved.reported_minor = null; saved.settlement_id = null; saved.settlement_reference_no = null; }
      if (record.source_type === 'received_receiver_recon' && assessment === 'missing' && original) throw new InputError(`Add a separate row for missing order ${row.id}.`);
      if (assessment === 'unknown' && record.source_type !== 'received_receiver_recon') throw new InputError('Unknown order applies only to a received receiver_recon order.');
      validateCaseOrder(saved);
      return saved;
    });
    if (new Set(submitted.map(order => order.id)).size !== submitted.length) throw new InputError('Order IDs must be unique in a case.');
    const unchanged = submitted.length === record.orders.length && submitted.every((order, index) => {
      const current = record.orders[index];
      return order.id === current.id && order.assessment === current.assessment &&
        order.expected_minor === current.expected_minor && order.received_minor === current.received_minor && order.difference_minor === current.difference_minor &&
        order.notes === (current.notes || '') && order.source === current.source;
    });
    if (unchanged) return res.json({ case: publicCase(record) });
    const result = await collection.findOneAndUpdate({ _id: record._id, version: record.version }, {
      $set: { orders: submitted, status: 'draft', updated_at: new Date() }, $inc: { version: 1 }
    }, { returnDocument: 'after' });
    if (!result) throw new InputError('This draft changed elsewhere. Reload before saving.', 409);
    res.json({ case: publicCase(result) });
  } catch (error) { next(error); }
});

app.post('/api/cases/:id/preview', async (req, res, next) => {
  try {
    const record = await db().collection('reconciliation_cases').findOne({ _id: req.params.id });
    if (!record) throw new InputError('Reconciliation case not found.', 404);
    const draft = buildOnReceiverRecon(record, record.orders);
    res.json({ version: record.version, ...draft });
  } catch (error) { next(error); }
});

app.post('/api/cases/:id/submit', async (req, res, next) => {
  try {
    const cases = db().collection('reconciliation_cases');
    const record = await cases.findOne({ _id: req.params.id });
    if (!record) throw new InputError('Reconciliation case not found.', 404);
    if (req.body.version !== record.version) throw new InputError('Draft changed after preview. Save and preview again.', 409);
    const draft = buildOnReceiverRecon(record, record.orders);
    if (draft.noResponseRequired) {
      await cases.updateOne({ _id: record._id, version: record.version }, { $set: { status: 'no_response_required', updated_at: new Date() } });
      return res.json({ status: 'no_response_required' });
    }
    const messageId = draft.messageId;
    const target = resolveDeliveryTarget(req.body.use_tunnel, record.subscriber_url);
    const outbound = db().collection('outbound_messages');
    const filter = { message_id: messageId };
    await outbound.updateOne(filter, { $setOnInsert: {
      _id: messageId, message_id: messageId, action: 'on_receiver_recon', transaction_id: record.transaction_id,
      case_id: record._id, payload: draft.payload, status: 'queued', attempt_count: 0, created_at: new Date()
    } }, { upsert: true });
    let sent = await outbound.findOne(filter);
    if (sent.status === 'sent') return res.json({ status: sent.status, payload: sent.payload, response: sent.response });
    const claimed = await outbound.findOneAndUpdate(
      { ...filter, status: { $in: ['queued', 'send_failed'] } },
      { $set: { status: 'sending', delivery_mode: target.mode, destination_url: `${target.baseUrl}/on_receiver_recon`, updated_at: new Date() }, $inc: { attempt_count: 1 } },
      { returnDocument: 'after' }
    );
    if (!claimed) return res.json({ status: sent.status, payload: sent.payload, response: sent.response });
    sent = claimed;
    {
      const sourceKeys = record.source_type === 'unsolicited' ? record.source_order_keys || [] : [];
      if (sourceKeys.length) {
        const snapshots = db().collection('order_snapshots');
        const sourceClaim = await snapshots.updateMany({ _id: { $in: sourceKeys },
          $or: [{ unsolicited_send_state: { $exists: false }, unsolicited_send_state: 'unsent' },
            { unsolicited_send_state: 'send_failed', unsolicited_case_id: record._id }] },
        { $set: { unsolicited_send_state: 'sending', unsolicited_case_id: record._id, updated_at: new Date() } });
        if (sourceClaim.modifiedCount !== sourceKeys.length) {
          await snapshots.updateMany({ _id: { $in: sourceKeys }, unsolicited_case_id: record._id, unsolicited_send_state: 'sending' },
            { $set: { unsolicited_send_state: 'unsent', updated_at: new Date() }, $unset: { unsolicited_case_id: '' } });
          await outbound.updateOne(filter, { $set: { status: 'send_failed', error: 'One or more source orders were claimed by another case.', updated_at: new Date() } });
          await cases.updateOne({ _id: record._id }, { $set: { status: 'send_failed', updated_at: new Date() } });
          throw new InputError('One or more source orders were claimed by another case. Refresh the saved orders.', 409);
        }
      }
      await cases.updateOne({ _id: record._id, version: record.version }, { $set: { status: 'sending', updated_at: new Date() } });
      try {
        const response = await deliverPayload('on_receiver_recon', sent.payload, target);
        if (response.status !== 200) throw Object.assign(new Error(`${target.mode === 'tunnel' ? 'Tunnel' : 'Subscriber'} returned HTTP ${response.status}.`), { downstream_status: response.status, response: response.body });
        await outbound.updateOne(filter, { $set: { status: 'sent', response: response.body, downstream_status: 200, sent_at: new Date(), updated_at: new Date() } });
        await cases.updateOne({ _id: record._id }, { $set: { status: 'sent', updated_at: new Date() } });
        if (sourceKeys.length) await db().collection('order_snapshots').updateMany({ _id: { $in: sourceKeys }, unsolicited_case_id: record._id }, { $set: { unsolicited_sent: true, unsolicited_send_state: 'sent', updated_at: new Date() } });
      } catch (error) {
        await outbound.updateOne(filter, { $set: { status: 'send_failed', error: error.message, downstream_status: error.downstream_status || null, response: error.response || null, updated_at: new Date() } });
        await cases.updateOne({ _id: record._id }, { $set: { status: 'send_failed', updated_at: new Date() } });
        if (sourceKeys.length) await db().collection('order_snapshots').updateMany({ _id: { $in: sourceKeys }, unsolicited_case_id: record._id }, { $set: { unsolicited_send_state: 'send_failed', updated_at: new Date() } });
        throw error;
      }
    }
    sent = await outbound.findOne(filter);
    res.json({ status: sent.status, payload: sent.payload, response: sent.response });
  } catch (error) { next(error); }
});

app.get('/api/messages/:id', async (req, res, next) => {
  try {
    const inbound = await db().collection('inbound_messages').findOne({ _id: req.params.id });
    const outbound = await db().collection('outbound_messages').findOne({ _id: req.params.id });
    const message = inbound || outbound;
    if (!message) throw new InputError('Message not found.', 404);
    res.json({ message });
  } catch (error) { next(error); }
});

app.post('/mock-np/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['receiver_recon', 'on_receiver_recon'].includes(action)) throw new InputError('Unsupported mock NP action.');
    const payload = req.body;
    await verifyOnDcAuthorization({ header: req.get('authorization'), bodyText: req.rawBody, context: payload?.context });
    if (payload?.context?.action !== action) throw new InputError('Mock NP action does not match payload context.action.');
    await db().collection('mock_np_messages').updateOne({ _id: payload.context.message_id }, { $setOnInsert: {
      _id: payload.context.message_id, action, transaction_id: payload.context.transaction_id,
      payload, received_at: new Date()
    } }, { upsert: true });
    res.json({ message: { ack: { status: 'ACK' } } });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  const status = error instanceof InputError || error instanceof AuthError ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: { message: error.message || 'Internal server error' } });
});

validateAuthConfig();
await connectDatabase();
await seedDemoData();
const server = app.listen(port, '0.0.0.0', async error => {
  if (error) {
    console.error(`RSF API could not listen on ${port}: ${error.message}`);
    await closeDatabase();
    process.exit(1);
  }
  console.log(`RSF API listening on ${port}`);
});

async function shutdown() {
  server.close(async () => { await closeDatabase(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
