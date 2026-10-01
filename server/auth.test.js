import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');
await sodium.ready;
const pair = sodium.crypto_sign_keypair();
const subscriberId = 'auth-test.example';
const uniqueKeyId = 'test-key-1';
process.env.ONDC_AUTH_MODE = 'required';
process.env.ONDC_SUBSCRIBER_ID = subscriberId;
process.env.ONDC_UNIQUE_KEY_ID = uniqueKeyId;
process.env.ONDC_SIGNING_PRIVATE_KEY = sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL);
process.env.ONDC_SIGNING_PUBLIC_KEY = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
process.env.ONDC_TRUSTED_PUBLIC_KEYS_JSON = '{}';

const { createOnDcAuthorization, validateAuthConfig, verifyOnDcAuthorization } = await import('./auth.js');

test('signs and verifies the exact serialized request body', async () => {
  validateAuthConfig();
  const body = JSON.stringify({ context: { action: 'on_receiver_recon' }, message: { orderbook: {} } });
  const header = await createOnDcAuthorization(body);
  assert.match(header, /keyId="auth-test\.example\|test-key-1\|ed25519"/);
  assert.equal(await verifyOnDcAuthorization({ header, bodyText: body }), true);
  await assert.rejects(verifyOnDcAuthorization({ header, bodyText: `${body} ` }), /signature verification failed/);
});

test('rejects unsigned inbound requests in required mode', async () => {
  await assert.rejects(verifyOnDcAuthorization({ header: undefined, bodyText: '{}' }), /Authorization header is required/);
});
