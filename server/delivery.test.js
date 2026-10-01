import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolveDeliveryTarget, deliverPayload } from './delivery.js';

test('tunnel is opt-in and keeps existing subscriber and mock fallback routing', () => {
  const env = { TUNNEL_URL: 'https://tunnel.example/ondc/', MOCK_NP_URL: 'https://mock.example/np/' };
  for (const flag of [undefined, false]) {
    assert.deepEqual(resolveDeliveryTarget(flag, 'https://subscriber.example/np/', env), {
      mode: 'subscriber', baseUrl: 'https://subscriber.example/np'
    });
  }
  assert.equal(resolveDeliveryTarget(false, undefined, env).baseUrl, 'https://mock.example/np');
  assert.equal(resolveDeliveryTarget(false, undefined, { PORT: '3010' }).baseUrl, 'http://localhost:3010/mock-np');
  assert.deepEqual(resolveDeliveryTarget(true, 'https://subscriber.example', env), {
    mode: 'tunnel', baseUrl: 'https://tunnel.example/ondc'
  });
  assert.equal(resolveDeliveryTarget(true, undefined, { tunnel_url: 'https://lowercase.example' }).baseUrl, 'https://lowercase.example');
});

test('missing or invalid tunnel config fails instead of delivering to subscriber', () => {
  for (const tunnelUrl of [undefined, '', ' ', 'not-a-url', 'ftp://example.com', 'https://example.com?token=1', 'https://user:password@example.com']) {
    assert.throws(() => resolveDeliveryTarget(true, 'https://subscriber.example', { TUNNEL_URL: tunnelUrl }), /TUNNEL_URL/);
  }
  for (const flag of ['true', 'false', 1, null]) {
    assert.throws(() => resolveDeliveryTarget(flag, 'https://subscriber.example', {}), /use_tunnel must be a boolean/);
  }
});

test('posts the built payload to the selected endpoint for both reconciliation actions', async t => {
  process.env.ONDC_AUTH_MODE = 'disabled';
  const received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, method: req.method, type: req.headers['content-type'], body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { ack: { status: 'ACK' } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const action of ['receiver_recon', 'on_receiver_recon']) {
    const payload = { context: { action, bap_uri: 'https://original-bap.example', bpp_uri: 'https://original-bpp.example' }, message: { orderbook: { orders: [{ id: 'order-1' }] } } };
    for (const useTunnel of [false, true]) {
      const target = resolveDeliveryTarget(useTunnel, `${origin}/subscriber`, { TUNNEL_URL: `${origin}/tunnel/` });
      const response = await deliverPayload(action, payload, target);
      assert.deepEqual(response, { status: 200, body: { message: { ack: { status: 'ACK' } } } });
      assert.deepEqual(received.at(-1), {
        path: `/${useTunnel ? 'tunnel' : 'subscriber'}/${action}`,
        method: 'POST', type: 'application/json', body: JSON.stringify(payload)
      });
    }
  }
  assert.equal(received.length, 4);
});
