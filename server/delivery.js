import { InputError, normalizeSubscriberUrl } from './domain.js';
import { createOnDcAuthorization } from './auth.js';

export function resolveDeliveryTarget(env = process.env) {
  const destination = env.TUNNEL_URL || env.tunnel_url;
  if (!String(destination || '').trim()) throw new InputError('TUNNEL_URL is required for outbound delivery.');
  try {
    return { mode: 'tunnel', baseUrl: normalizeSubscriberUrl(destination) };
  } catch {
    throw new InputError('TUNNEL_URL must be a valid HTTP or HTTPS base URL without credentials, query parameters, or a fragment.');
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

  if (responseBody?.message?.ack?.status === 'NACK') {
    const reason = responseBody.error?.message || 'Request rejected';
    throw Object.assign(new Error(`Downstream NACK: ${reason}`), {
      downstream_status: response.status, response: responseBody
    });
  }

  return { status: response.status, body: responseBody };
}
