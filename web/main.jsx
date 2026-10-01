import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

const asAmount = minor => minor == null ? '' : (minor / 100).toFixed(2);
const money = minor => minor == null ? '-' : `INR ${asAmount(minor)}`;
const demoUrl = 'http://localhost:3000/mock-np';
const statuses = ['PAID', 'NOT-PAID', 'UNDERPAID', 'OVERPAID'];
const assessments = ['matched', 'underpaid', 'overpaid', 'missing', 'unknown'];

function normalizeUrl(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Enter a valid HTTP or HTTPS subscriber URL.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function editableCaseRows(record) {
  return record.orders.map(order => ({ ...order, difference_amount: asAmount(order.difference_minor) }));
}

function App() {
  const [screen, setScreen] = useState('subscriber');
  const [urlInput, setUrlInput] = useState('');
  const [subscriberMatches, setSubscriberMatches] = useState([]);
  const [subscriberLookup, setSubscriberLookup] = useState(false);
  const [showSubscriberMatches, setShowSubscriberMatches] = useState(false);
  const [subscriber, setSubscriber] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const [receiverFilter, setReceiverFilter] = useState('unsent');
  const [receiverQuery, setReceiverQuery] = useState('');
  const [receiverData, setReceiverData] = useState({ orders: [], counts: { unsent: 0, sent: 0 }, next_cursor: null });
  const [receiverSelection, setReceiverSelection] = useState({});
  const [receiverDraft, setReceiverDraft] = useState(null);
  const [receiverReload, setReceiverReload] = useState(0);

  const [unsolicitedCases, setUnsolicitedCases] = useState([]);
  const [knownReload, setKnownReload] = useState(0);
  const [queuedCases, setQueuedCases] = useState([]);

  const [caseDoc, setCaseDoc] = useState(null);
  const [rows, setRows] = useState([]);
  const [reviewQuery, setReviewQuery] = useState('');
  const [reviewFilter, setReviewFilter] = useState('all');
  const [newOrderId, setNewOrderId] = useState('');
  const [newDifference, setNewDifference] = useState('');

  useEffect(() => {
    const prefix = urlInput.trim();
    if (screen !== 'subscriber' || !prefix) {
      setSubscriberMatches([]);
      setSubscriberLookup(false);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setSubscriberLookup(true);
      api(`/api/subscriber-urls?${new URLSearchParams({ prefix })}`)
        .then(data => { if (active) setSubscriberMatches(data.subscriber_urls || []); })
        .catch(() => { if (active) setSubscriberMatches([]); })
        .finally(() => { if (active) setSubscriberLookup(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [screen, urlInput]);

  useEffect(() => {
    if (screen !== 'receiver' || !subscriber) return;
    let active = true;
    const params = new URLSearchParams({ subscriber_url: subscriber, state: receiverFilter, query: receiverQuery });
    api(`/api/subscriber/orders?${params}`).then(data => { if (active) setReceiverData(data); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [screen, subscriber, receiverFilter, receiverQuery, receiverReload]);

  useEffect(() => {
    if (!['choose', 'review'].includes(screen) || !subscriber) return;
    let active = true;
    api(`/api/subscriber/unsolicited-cases?${new URLSearchParams({ subscriber_url: subscriber })}`)
      .then(data => { if (active) setUnsolicitedCases(data.cases); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [screen, subscriber, knownReload]);

  const visibleReviewRows = useMemo(() => rows.filter(row => row.id.toLowerCase().includes(reviewQuery.toLowerCase()) && (reviewFilter === 'all' || row.assessment === reviewFilter)), [rows, reviewQuery, reviewFilter]);
  const outgoingCount = rows.filter(row => row.assessment !== 'matched').length;

  function clearMessages() { setError(''); setNotice(''); }
  function go(next) { clearMessages(); setScreen(next); }
  function continueSubscriber(event) {
    event.preventDefault();
    try {
      const value = normalizeUrl(urlInput);
      setSubscriber(value);
      setReceiverSelection({});
      setReceiverDraft(null);
      setUnsolicitedCases([]);
      go('choose');
    } catch (err) { setError(err.message); }
  }

  async function loadMoreOrders(kind) {
    try {
      if (kind === 'receiver') {
        const params = new URLSearchParams({ subscriber_url: subscriber, state: receiverFilter, query: receiverQuery, cursor: receiverData.next_cursor });
        const data = await api(`/api/subscriber/orders?${params}`);
        setReceiverData(current => ({ ...data, orders: [...current.orders, ...data.orders] }));
      }
    } catch (err) { setError(err.message); }
  }

  function editReceiver(order, patch) {
    setReceiverSelection(current => ({ ...current, [order.key]: { status: 'PAID', amounts: [asAmount(order.expected_minor)], ...(current[order.key] || {}), ...patch } }));
    setReceiverDraft(null);
  }
  function toggleReceiver(order) {
    setReceiverSelection(current => {
      const next = { ...current };
      if (next[order.key]) delete next[order.key];
      else next[order.key] = { status: 'PAID', amounts: [asAmount(order.expected_minor)] };
      return next;
    });
    setReceiverDraft(null);
  }
  function selectedReceiverOrders() {
    return Object.entries(receiverSelection).map(([key, value]) => ({ key, ...value }));
  }
  async function previewReceiver() {
    clearMessages();
    setBusy(true);
    try {
      const result = await api('/api/receiver-recon/preview', { method: 'POST', body: JSON.stringify({ subscriber_url: subscriber, orders: selectedReceiverOrders() }) });
      setReceiverDraft(result);
      setModal({ title: 'receiver_recon preview', payload: result.groups.map(group => group.payload) });
      return result;
    } catch (err) { setError(err.message); return null; }
    finally { setBusy(false); }
  }
  async function sendReceiver() {
    clearMessages();
    setSending(true);
    try {
      const draft = receiverDraft || await api('/api/receiver-recon/preview', { method: 'POST', body: JSON.stringify({ subscriber_url: subscriber, orders: selectedReceiverOrders() }) });
      setReceiverDraft(draft);
      const result = await api('/api/receiver-recon/send', { method: 'POST', body: JSON.stringify({ draft_id: draft.draft_id }) });
      const sentIds = new Set(result.groups.filter(group => group.downstream_status === 200).map(group => group.message_id));
      const sentKeys = new Set(draft.groups.filter(group => sentIds.has(group.message_id)).flatMap(group => group.order_keys));
      setReceiverSelection(current => Object.fromEntries(Object.entries(current).filter(([key]) => !sentKeys.has(key))));
      setReceiverDraft(result.groups.some(group => group.status !== 'sent') ? draft : null);
      setReceiverReload(value => value + 1);
      setNotice(result.groups.map(group => `${group.message_id}: ${group.status}${group.downstream_status ? ` (HTTP ${group.downstream_status})` : ''}${group.error ? ` - ${group.error}` : ''}`).join(' | '));
    } catch (err) { setError(err.message); }
    finally { setSending(false); }
  }
  async function inspectSent(order) {
    try {
      const params = new URLSearchParams({ order_key: order.key });
      const result = await api(`/api/receiver-recon/sent?${params}`);
      setModal({ title: 'Sent receiver_recon', payload: result });
    } catch (err) { setError(err.message); }
  }
  async function retryReceiver(order) {
    clearMessages();
    setSending(true);
    try {
      const result = await api('/api/receiver-recon/send', { method: 'POST', body: JSON.stringify({ draft_id: order.receiver_draft_id }) });
      setNotice(result.groups.map(group => `${group.message_id}: ${group.status}${group.downstream_status ? ` (HTTP ${group.downstream_status})` : ''}${group.error ? ` - ${group.error}` : ''}`).join(' | '));
      setReceiverReload(value => value + 1);
    } catch (err) { setError(err.message); }
    finally { setSending(false); }
  }

  function hydrateCase(record) {
    setCaseDoc(record);
    setRows(editableCaseRows(record));
    setReviewQuery('');
    setReviewFilter('all');
    setNewOrderId('');
    setNewDifference('');
    go('review');
  }
  async function openCase(id) {
    try { const result = await api(`/api/cases/${encodeURIComponent(id)}`); hydrateCase(result.case); }
    catch (err) { setError(err.message); }
  }
  async function startUnsolicited() {
    clearMessages();
    setQueuedCases([]);
    hydrateCase({ id: null, source_type: 'unsolicited', subscriber_url: subscriber, orders: [], status: 'draft', version: 1 });
    requestAnimationFrame(() => document.querySelector('[aria-label="Missing order ID"]')?.focus());
  }
  async function deleteReview(id) {
    clearMessages();
    setBusy(true);
    try {
      if (id) await api(`/api/cases/${encodeURIComponent(id)}?${new URLSearchParams({ subscriber_url: subscriber })}`, { method: 'DELETE' });
      setUnsolicitedCases(current => current.filter(item => item.id !== id));
      if (!id || caseDoc?.id === id) { setCaseDoc(null); setRows([]); go('choose'); }
      setKnownReload(value => value + 1);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  function changeRow(id, patch) {
    setRows(current => current.map(row => {
      if (row.id !== id) return row;
      const next = { ...row, ...patch };
      return next;
    }));
  }
  function addMissing(event) {
    event.preventDefault();
    clearMessages();
    const difference = Number(newDifference);
    const id = newOrderId.trim();
    if (!id || !Number.isFinite(difference) || rows.some(row => row.id === id)) {
      setError('Enter a unique order ID and a numeric difference amount.');
      return;
    }
    setRows(current => [...current, { id, difference_amount: newDifference.trim(), reported_minor: null,
      assessment: 'missing', source: 'Added missing order', settlement_id: null, settlement_reference_no: null, notes: '' }]);
    setNewOrderId('');
    setNewDifference('');
  }
  async function saveReview() {
    let record = caseDoc;
    if (!record.id) {
      const created = await api('/api/cases/unsolicited', { method: 'POST', body: JSON.stringify({ subscriber_url: subscriber, order_keys: [] }) });
      record = created.cases[0];
      setCaseDoc(record);
    }
    const result = await api(`/api/cases/${encodeURIComponent(record.id)}/draft`, { method: 'PUT', body: JSON.stringify({
      version: record.version, orders: rows.map(row => ({ id: row.id, assessment: row.assessment,
        difference_amount: row.difference_amount, notes: row.notes, source: row.source }))
    }) });
    setCaseDoc(result.case);
    setRows(editableCaseRows(result.case));
    return result.case;
  }
  async function previewReview() {
    clearMessages();
    setBusy(true);
    try {
      const saved = await saveReview();
      const result = await api(`/api/cases/${encodeURIComponent(saved.id)}/preview`, { method: 'POST' });
      setModal({ title: result.noResponseRequired ? 'No response required' : 'on_receiver_recon preview', payload: result.payload || { no_response_required: true } });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function sendReview() {
    clearMessages();
    setSending(true);
    try {
      const saved = await saveReview();
      const result = await api(`/api/cases/${encodeURIComponent(saved.id)}/submit`, { method: 'POST', body: JSON.stringify({ version: saved.version }) });
      const refreshed = await api(`/api/cases/${encodeURIComponent(saved.id)}`);
      setCaseDoc(refreshed.case);
      setRows(editableCaseRows(refreshed.case));
      if (result.status === 'sent') {
        setNotice('HTTP 200. on_receiver_recon sent successfully.');
        setKnownReload(value => value + 1);
        setModal({ title: 'Sent on_receiver_recon', payload: { request: result.payload, response: result.response } });
      } else setNotice(result.status === 'no_response_required' ? 'All orders matched; no response was sent.' : `Delivery status: ${result.status}`);
    } catch (err) { setError(`${err.message} The review is preserved for retry.`); }
    finally { setSending(false); }
  }

  return <>
    <header className="topbar"><button className="brand" onClick={() => go('subscriber')}>ONDC Workbench</button><nav><span>Scenarios</span><strong>Reconciliation</strong><span>History</span></nav><div className="env">LOCAL MOCK</div></header>
    <main>
      <div className="eyebrow">Reconciliation / {screen === 'subscriber' ? 'Subscriber' : screen === 'choose' ? 'Send' : screen === 'receiver' ? 'receiver_recon' : 'on_receiver_recon'}</div>
      {screen === 'subscriber' && <><h1>Subscriber URL</h1><p className="subtitle">Enter the external NP subscriber URL.</p><form className="search-panel" onSubmit={continueSubscriber}><div className="subscriber-url-control"><label htmlFor="subscriber-url">Subscriber URL</label><div className="subscriber-url-field"><input id="subscriber-url" type="url" value={urlInput} onFocus={() => setShowSubscriberMatches(true)} onChange={event => { setUrlInput(event.target.value); setShowSubscriberMatches(true); }} onBlur={() => setTimeout(() => setShowSubscriberMatches(false), 120)} aria-autocomplete="list" aria-expanded={showSubscriberMatches && subscriberMatches.length > 0} aria-controls="subscriber-url-matches" placeholder="https://subscriber.example/ondc" />{showSubscriberMatches && urlInput.trim() && <div className="subscriber-url-matches" id="subscriber-url-matches" role="listbox">{subscriberLookup && <div className="subscriber-url-hint">Searching saved URLs…</div>}{!subscriberLookup && subscriberMatches.map(value => <button type="button" role="option" aria-selected="false" key={value} onMouseDown={event => event.preventDefault()} onClick={() => { setUrlInput(value); setShowSubscriberMatches(false); }}>{value}</button>)}{!subscriberLookup && !subscriberMatches.length && <div className="subscriber-url-hint">No saved subscriber URLs match.</div>}</div>}</div></div><button className="button primary">Continue</button></form><button className="link-button demo-link" onClick={() => setUrlInput(demoUrl)}>Use demo subscriber URL</button></>}
      {screen === 'choose' && <><button className="back" onClick={() => go('subscriber')}>Change subscriber</button><h1>Send reconciliation</h1><p className="subtitle scope-url">{subscriber}</p><div className="flow-grid two-flow"><button className="flow-card" onClick={() => go('receiver')}><span className="tag">Collector flow</span><h2>Send receiver_recon</h2><p>Select unsent on_confirm orders, enter settlement status and amounts, then send.</p></button><button className="flow-card" onClick={startUnsolicited} disabled={busy}><span className="tag">Receiver flow</span><h2>Send on_receiver_recon</h2><p>Create custom order entries and send a reconciliation response.</p></button></div></>}
      {screen === 'receiver' && <><button className="back" onClick={() => go('choose')}>Back to send options</button><h1>Send receiver_recon</h1><p className="subtitle scope-url">{subscriber}</p><section className="panel"><div className="panel-head"><h2>on_confirm orders</h2><span className="muted">Unsent {receiverData.counts.unsent} &nbsp; Sent {receiverData.counts.sent}</span></div><div className="table-tools"><input value={receiverQuery} onChange={event => setReceiverQuery(event.target.value)} placeholder="Order or transaction ID" aria-label="Find order or transaction" /><div className="segmented">{['unsent', 'sent', 'all'].map(value => <button key={value} className={receiverFilter === value ? 'active' : ''} onClick={() => { setReceiverFilter(value); setReceiverSelection({}); setReceiverDraft(null); }}>{value}</button>)}</div></div><div className="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select visible unsent orders" checked={receiverData.orders.some(order => order.receiver_send_state === 'unsent') && receiverData.orders.filter(order => order.receiver_send_state === 'unsent').every(order => receiverSelection[order.key])} onChange={event => { const next = { ...receiverSelection }; receiverData.orders.filter(order => order.receiver_send_state === 'unsent').forEach(order => { if (event.target.checked) next[order.key] = next[order.key] || { status: 'PAID', amounts: [asAmount(order.expected_minor)] }; else delete next[order.key]; }); setReceiverSelection(next); setReceiverDraft(null); }} /></th><th>Order / transaction</th><th>Provider</th><th>Expected INR</th><th>Settlement status</th><th>Settlement amounts INR</th><th>Send state</th></tr></thead><tbody>{receiverData.orders.map(order => { const value = receiverSelection[order.key] || { status: 'PAID', amounts: [asAmount(order.expected_minor)] }; const locked = order.receiver_send_state === 'sent'; return <tr key={order.key} className={locked ? 'sent-row' : ''}><td><input type="checkbox" aria-label={`Select ${order.order_id}`} checked={Boolean(receiverSelection[order.key])} disabled={order.receiver_send_state !== 'unsent'} onChange={() => toggleReceiver(order)} /></td><td><strong>{order.order_id}</strong><small>{order.transaction_id}</small></td><td>{order.provider}</td><td>{money(order.expected_minor)}</td><td><select value={value.status} disabled={order.receiver_send_state !== 'unsent'} onChange={event => editReceiver(order, { status: event.target.value })} aria-label={`Settlement status ${order.order_id}`}>{statuses.map(status => <option key={status}>{status}</option>)}</select></td><td><div className="amount-list">{value.amounts.map((amount, index) => <div className="amount-line" key={index}><input className="cell-input" type="number" step="0.01" value={amount} disabled={order.receiver_send_state !== 'unsent'} onChange={event => editReceiver(order, { amounts: value.amounts.map((entry, position) => position === index ? event.target.value : entry) })} aria-label={`Settlement amount ${index + 1} ${order.order_id}`} />{order.receiver_send_state === 'unsent' && value.amounts.length > 1 && <button className="small-icon" title="Remove amount" aria-label={`Remove amount ${index + 1} ${order.order_id}`} onClick={() => editReceiver(order, { amounts: value.amounts.filter((_, position) => position !== index) })}>-</button>}</div>)}{order.receiver_send_state === 'unsent' && <button className="small-icon" title="Add amount" aria-label={`Add amount ${order.order_id}`} onClick={() => editReceiver(order, { amounts: [...value.amounts, '0.00'] })}>+</button>}</div></td><td><Status value={order.receiver_send_state} />{locked && <button className="link-button" onClick={() => inspectSent(order)}>Inspect</button>}{order.receiver_send_state === 'send_failed' && order.receiver_draft_id && <button className="link-button" onClick={() => retryReceiver(order)}>Retry group</button>}</td></tr>; })}{!receiverData.orders.length && <tr><td className="empty-cell" colSpan="7">No orders for this subscriber and filter.</td></tr>}</tbody></table></div>{receiverData.next_cursor && <button className="load-more" onClick={() => loadMoreOrders('receiver')}>Load more orders</button>}</section><div className="action-bar"><span>{Object.keys(receiverSelection).length} orders selected</span><div><button className="button" disabled={busy || sending || !Object.keys(receiverSelection).length} onClick={previewReceiver}>Preview payload</button><button className="button primary" disabled={busy || sending || !Object.keys(receiverSelection).length} onClick={sendReceiver}>Send selected</button></div></div></>}
      {screen === 'review' && caseDoc && <><button className="back" onClick={() => go('choose')}>Back to send options</button><h1>Send on_receiver_recon</h1><p className="subtitle scope-url">{subscriber}</p>{caseDoc.source_type === 'received_receiver_recon' && <section className="panel source-summary"><div className="panel-head"><h2>Source payload</h2><button className="button" onClick={() => setModal({ title: 'Received receiver_recon', payload: caseDoc.source_payload })}>View payload</button></div><div className="facts"><Fact label="Transaction ID" value={caseDoc.transaction_id} /><Fact label="Loaded from" value="Received receiver_recon" /><Fact label="Orders" value={rows.length} /><Fact label="Status" value={caseDoc.status} /></div></section>}<div className="review-layout"><section className="panel order-panel"><div className="panel-head"><h2>Orders to reconcile <span className="muted">({rows.length})</span></h2><button className="button" onClick={() => document.getElementById('missing-order-form')?.scrollIntoView({ behavior: 'smooth' })}>+ Add custom order</button></div><div className="table-tools"><input value={reviewQuery} onChange={event => setReviewQuery(event.target.value)} placeholder="Search order ID" aria-label="Search orders" /><select value={reviewFilter} onChange={event => setReviewFilter(event.target.value)} aria-label="Filter orders"><option value="all">All orders</option>{assessments.filter(value => value !== 'unknown' || caseDoc.source_type === 'received_receiver_recon').map(value => <option key={value} value={value}>{value === 'missing' ? 'Missing / unpaid' : value}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>Order ID</th><th>Difference</th><th>Assessment</th></tr></thead><tbody>{visibleReviewRows.map(row => { return <tr key={row.id}><td><strong>{row.id}</strong><small>{row.source}</small></td><td>{row.assessment === 'unknown' ? '-' : <input className="cell-input" type="number" step="0.01" value={row.difference_amount} disabled={caseDoc.status === 'sent'} onChange={event => changeRow(row.id, { difference_amount: event.target.value })} aria-label={`Difference amount ${row.id}`} />}</td><td><select value={row.assessment} disabled={caseDoc.status === 'sent'} onChange={event => changeRow(row.id, { assessment: event.target.value })} aria-label={`Assessment ${row.id}`}><option value="matched">Matched</option><option value="underpaid">Underpaid</option><option value="overpaid">Overpaid</option>{(caseDoc.source_type === 'unsolicited' || row.source === 'Added missing order') && <option value="missing">Missing / unpaid</option>}{caseDoc.source_type === 'received_receiver_recon' && row.source !== 'Added missing order' && <option value="unknown">Unknown order</option>}</select></td></tr>; })}{!visibleReviewRows.length && <tr><td colSpan="3" className="empty-cell">No orders match this filter.</td></tr>}</tbody></table></div><form noValidate id="missing-order-form" className="add-order-form" onSubmit={addMissing}><strong>Add custom order</strong><input value={newOrderId} onChange={event => setNewOrderId(event.target.value)} placeholder="Order ID" aria-label="Missing order ID" disabled={caseDoc.status === 'sent'} /><input value={newDifference} onChange={event => setNewDifference(event.target.value)} type="number" step="0.01" placeholder="Difference amount INR" aria-label="New order difference amount" disabled={caseDoc.status === 'sent'} /><button className="button" disabled={caseDoc.status === 'sent' || !newOrderId.trim() || !newDifference}>Add order</button></form></section></div>{queuedCases.length > 0 && caseDoc.status === 'sent' && <button className="button next-group" onClick={() => { const [next, ...rest] = queuedCases; setQueuedCases(rest); openCase(next); }}>Review next routing group ({queuedCases.length})</button>}<div className="action-bar"><span>{rows.length} reviewed · {outgoingCount} outgoing · {caseDoc.status.replaceAll('_', ' ')}</span><div><button className="button" onClick={() => deleteReview(caseDoc.id)} disabled={busy}>Delete review</button><button className="button" onClick={previewReview} disabled={busy || sending || !rows.length || caseDoc.status === 'sent'}>Preview payload</button><button className="button primary" onClick={sendReview} disabled={busy || sending || !rows.length || caseDoc.status === 'sent'}>Submit and send</button></div></div></>}
      {['choose', 'review'].includes(screen) && unsolicitedCases.length > 0 &&
        <section className="results"><div className="section-title">Unfinished reviews <span>{unsolicitedCases.length}</span></div>
          {unsolicitedCases.map(item => <div className="unfinished-review-row" key={item.id}><button className="result-row" onClick={() => openCase(item.id)}>
            <span><strong>{item.order_count} orders</strong><small>{new Date(item.updated_at).toLocaleString()}</small></span>
            <span className="result-meta"><Status value={item.status} />Open</span>
          </button><button className="button delete-review-button" title="Delete review" aria-label={`Delete review ${item.id}`} onClick={() => deleteReview(item.id)} disabled={busy}>Delete</button></div>)}
        </section>}
      {error && <p className="error-line" role="alert">{error}</p>}
      {notice && <p className="success-line" role="status">{notice}</p>}
    </main>
    {sending && <div className="sending-overlay" role="status" aria-live="polite"><div className="sending-panel"><span className="spinner" /><h2>Sending reconciliation</h2><p>Waiting for the subscriber response...</p></div></div>}
    {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}><section className="modal" role="dialog" aria-modal="true"><header><h2>{modal.title}</h2><button className="icon-button" aria-label="Close" onClick={() => setModal(null)}>×</button></header><pre>{JSON.stringify(modal.payload, null, 2)}</pre><footer><button className="button" onClick={() => setModal(null)}>Close</button></footer></section></div>}
  </>;
}

function Fact({ label, value }) { return <div className="fact"><span>{label}</span><strong>{value || '-'}</strong></div>; }
function Status({ value }) { return <span className={`status status-${String(value).replaceAll('_', '-')}`}>{String(value || 'unsent').replaceAll('_', ' ')}</span>; }

createRoot(document.getElementById('root')).render(<App />);
