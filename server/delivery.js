import { InputError, normalizeSubscriberUrl } from './domain.js';
import { createOnDcAuthorization } from './auth.js';

export function resolveDeliveryTarget(useTunnel, subscriberUrl, env = process.env) {
  if (useTunnel !== undefined && typeof useTunnel !== 'boolean') {
    throw new InputError('use_tunnel must be a boolean.');
  }
  const mode = useTunnel ? 'tunnel' : 'subscriber';
  const destination = useTunnel
    ? env.TUNNEL_URL || env.tunnel_url
    : subscriberUrl || env.MOCK_NP_URL || `http://localhost:${env.PORT || 3000}/mock-np`;
  if (useTunnel && !String(destination || '').trim()) {
    throw new InputError('Tunnel delivery is enabled, but TUNNEL_URL is not configured.');
  }
  try {
    return { mode, baseUrl: normalizeSubscriberUrl(destination) };
  } catch (error) {
    if (useTunnel) throw new InputError('TUNNEL_URL must be a valid HTTP or HTTPS base URL without credentials, query parameters, or a fragment.');
    throw error;
  }
}

export async function deliverPayload(action, payload, target) {
  const body = JSON.stringify(payload);
  const authorization = await createOnDcAuthorization(body);
  const response = await fetch(`${target.baseUrl}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body, signal: AbortSignal.timeout(30000)
  });
  const responseBody = await response.json().catch(() => ({}));
  return { status: response.status, body: responseBody };
}
