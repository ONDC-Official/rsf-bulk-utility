import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { isHeaderValid } from 'ondc-crypto-sdk-nodejs';
const sodium = createRequire(import.meta.url)('libsodium-wrappers');
await sodium.ready;
const pair = sodium.crypto_sign_keypair();
process.env.ONDC_AUTH_MODE = 'optional';
process.env.ONDC_SUBSCRIBER_ID = 'tunnel-signer.example';
process.env.ONDC_UNIQUE_KEY_ID = 'tunnel-key';
process.env.ONDC_SIGNING_PRIVATE_KEY = sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL);
const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
const { resolveDeliveryTarget, deliverPayload } = await import('./delivery.js');

test('all delivery uses the tunnel and supports the lowercase environment alias', () => {
  assert.deepEqual(resolveDeliveryTarget({ TUNNEL_URL: 'https://tunnel.example/ondc/', MOCK_NP_URL: 'https://mock.example' }), {
    mode: 'tunnel', baseUrl: 'https://tunnel.example/ondc'
  });
  assert.equal(resolveDeliveryTarget({ tunnel_url: 'https://lowercase.example' }).baseUrl, 'https://lowercase.example');
});

test('missing or invalid tunnel config fails without subscriber or mock fallback', () => {
  for (const tunnelUrl of [undefined, '', ' ', 'not-a-url', 'ftp://example.com', 'https://example.com?token=1', 'https://user:password@example.com']) {
    assert.throws(() => resolveDeliveryTarget({ TUNNEL_URL: tunnelUrl, MOCK_NP_URL: 'https://mock.example' }), /TUNNEL_URL/);
  }
});

test('posts both reconciliation actions to the tunnel with unchanged context and valid authorization', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(await isHeaderValid({ header: req.headers.authorization, body, publicKey }), true);
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
    {
      const target = resolveDeliveryTarget({ TUNNEL_URL: `${origin}/tunnel/` });
      const response = await deliverPayload(action, payload, target);
      assert.deepEqual(response, { status: 200, body: { message: { ack: { status: 'ACK' } } } });
      assert.deepEqual(received.at(-1), {
        path: `/tunnel/${action}`,
        method: 'POST', type: 'application/json', body: JSON.stringify(payload)
      });
    }
  }
  assert.equal(received.length, 2);
});
