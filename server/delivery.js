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
  const url = `${target.baseUrl}/${action}`;
  const headers = { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) };
  const tunnelRequest = target.mode === 'tunnel'
    ? { url, method: 'POST', headers, body }
    : null;

  if (tunnelRequest) console.info('[TUNNEL request]', JSON.stringify(tunnelRequest));

  let response;
  try {
    response = await fetch(url, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    if (tunnelRequest) {
      console.error('[TUNNEL transport error]', JSON.stringify({
        request: tunnelRequest,
        error: { name: error.name, message: error.message, cause: error.cause?.message }
      }));
    }
    throw error;
  }

  const responseText = await response.text();
  let responseBody = {};
  try { responseBody = responseText ? JSON.parse(responseText) : {}; }
  catch { responseBody = {}; }

  if (tunnelRequest) {
    console.info('[TUNNEL response]', JSON.stringify({
      url,
      status: response.status,
      status_text: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseText
    }));
  }

  return { status: response.status, body: responseBody };
}
