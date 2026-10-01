import { createAuthorizationHeader, isHeaderValid } from 'ondc-crypto-sdk-nodejs';

const mode = String(process.env.ONDC_AUTH_MODE || 'disabled').toLowerCase();
const registryCache = new Map();

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function signingConfig() {
  return {
    subscriberId: process.env.ONDC_SUBSCRIBER_ID || '',
    subscriberUniqueKeyId: process.env.ONDC_UNIQUE_KEY_ID || '',
    privateKey: process.env.ONDC_SIGNING_PRIVATE_KEY || ''
  };
}

export function validateAuthConfig() {
  if (!['disabled', 'optional', 'required'].includes(mode)) throw new Error('ONDC_AUTH_MODE must be disabled, optional, or required.');
  const config = signingConfig();
  if (!config.subscriberId) throw new Error('ONDC_SUBSCRIBER_ID is required for participant identity and role detection.');
  const anySigningValue = Boolean(config.privateKey || config.subscriberUniqueKeyId);
  const hasSigner = Object.values(config).every(Boolean);
  if (anySigningValue && !hasSigner) throw new Error('Set ONDC_SUBSCRIBER_ID, ONDC_UNIQUE_KEY_ID, and ONDC_SIGNING_PRIVATE_KEY together.');
  if (mode === 'required' && !hasSigner) throw new Error('ONDC_AUTH_MODE=required needs ONDC_SUBSCRIBER_ID, ONDC_UNIQUE_KEY_ID, and ONDC_SIGNING_PRIVATE_KEY.');
  if (mode === 'required' && !process.env.ONDC_TRUSTED_PUBLIC_KEYS_JSON && !process.env.ONDC_REGISTRY_LOOKUP_URL) {
    throw new Error('ONDC_AUTH_MODE=required needs ONDC_TRUSTED_PUBLIC_KEYS_JSON or ONDC_REGISTRY_LOOKUP_URL for inbound verification.');
  }
}

export async function createOnDcAuthorization(bodyText) {
  if (mode === 'disabled') return null;
  const config = signingConfig();
  if (!config.privateKey) {
    if (mode === 'optional') return null;
    throw new Error('ONDC signing credentials are not configured.');
  }
  return createAuthorizationHeader({ body: bodyText, ...config });
}

function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header.startsWith('Signature ')) throw new AuthError('Missing or malformed ONDC Authorization header.');
  const values = Object.fromEntries([...header.slice('Signature '.length).matchAll(/\s*([a-zA-Z]+)="?([^",]+)"?\s*,?/g)].map(match => [match[1], match[2]]));
  const [subscriberId, uniqueKeyId, keyAlgorithm, extra] = String(values.keyId || '').split('|');
  const created = Number(values.created);
  const expires = Number(values.expires);
  const now = Math.floor(Date.now() / 1000);
  if (!subscriberId || !uniqueKeyId || extra || keyAlgorithm !== 'ed25519' || values.algorithm !== 'ed25519') throw new AuthError('ONDC signature key ID or algorithm is invalid.');
  if (!Number.isInteger(created) || !Number.isInteger(expires) || created > now + 300 || expires < now || expires <= created) throw new AuthError('ONDC signature has invalid created/expires timestamps.');
  if (!values.signature) throw new AuthError('ONDC signature is missing.');
  return { subscriberId, uniqueKeyId, keyId: `${subscriberId}|${uniqueKeyId}`, created, expires };
}

function configuredPublicKey(keyId) {
  let trusted;
  try { trusted = JSON.parse(process.env.ONDC_TRUSTED_PUBLIC_KEYS_JSON || '{}'); }
  catch { throw new Error('ONDC_TRUSTED_PUBLIC_KEYS_JSON must be a JSON object keyed by subscriber_id|unique_key_id.'); }
  const own = signingConfig();
  if (keyId === `${own.subscriberId}|${own.subscriberUniqueKeyId}` && process.env.ONDC_SIGNING_PUBLIC_KEY) return process.env.ONDC_SIGNING_PUBLIC_KEY;
  return trusted[keyId] || null;
}

async function registryPublicKey({ keyId, subscriberId, uniqueKeyId, context }) {
  const registryUrl = process.env.ONDC_REGISTRY_LOOKUP_URL;
  if (!registryUrl) return null;
  const cached = registryCache.get(keyId);
  if (cached && cached.expires > Date.now()) return cached.publicKey;

  const body = JSON.stringify({
    country: context?.country?.code || context?.location?.country?.code || 'IND',
    domain: context?.domain
  });
  const authorization = await createOnDcAuthorization(body);
  if (!authorization) throw new Error('Registry lookup requires configured ONDC signing credentials.');
  const response = await fetch(registryUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization },
    body, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`ONDC registry lookup returned HTTP ${response.status}.`);
  const result = await response.json();
  const records = Array.isArray(result) ? result : result.records || result.data || [];
  const match = records.find(record => record.subscriber_id === subscriberId &&
    (record.ukId || record.unique_key_id) === uniqueKeyId && record.signing_public_key);
  if (!match) return null;
  registryCache.set(keyId, { publicKey: match.signing_public_key, expires: Date.now() + 5 * 60 * 1000 });
  return match.signing_public_key;
}

export async function verifyOnDcAuthorization({ header, bodyText, context }) {
  if (mode === 'disabled') return true;
  if (!header) {
    if (mode === 'optional') return true;
    throw new AuthError('ONDC Authorization header is required.');
  }
  const parsed = parseSignatureHeader(header);
  let publicKey = configuredPublicKey(parsed.keyId);
  if (!publicKey) publicKey = await registryPublicKey({ ...parsed, context });
  if (!publicKey) throw new AuthError(`No trusted ONDC signing key found for ${parsed.keyId}.`);
  let valid = false;
  try { valid = await isHeaderValid({ header, body: bodyText, publicKey }); }
  catch { valid = false; }
  if (!valid) throw new AuthError('ONDC request signature verification failed.');
  return true;
}
