// ─────────────────────────────────────────────────────────────
// Web Push, with only the Web Crypto API (no libraries, no push account).
//
//   encryptPayload()  RFC 8291 message encryption (aes128gcm, RFC 8188)
//   vapidAuth()       RFC 8292 VAPID: proves the message comes from this app
//   sendPush()        RFC 8030: one POST to the phone's push service
//
// Google (Chrome/Android), Apple (iPhone home-screen apps) and Mozilla all
// accept these directly. Kept apart from index.js so it can be tested in Node
// against the RFC 8291 test vector.
// ─────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

export const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) =>
  Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** True when the keys from PushSubscription.toJSON() have the right shape. */
export function subscriptionKeysOk(p256dh, auth) {
  try {
    const pub = fromB64url(p256dh);
    return pub.length === 65 && pub[0] === 4 && fromB64url(auth).length === 16;
  } catch {
    return false;
  }
}

/**
 * Encrypt a message for one phone (RFC 8291). Returns the request body.
 * `salt` and `asKeyPair` are only passed by tests; normally both are fresh and random.
 */
export async function encryptPayload(plaintext, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), asKeyPair } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (!subscriptionKeysOk(p256dh, auth)) throw new Error('Bad subscription keys');
  const as = asKeyPair || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : new Uint8Array(plaintext);
  if (data.length > RECORD_SIZE - 17 - 86) throw new Error('Push message too long');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the message, then the 0x02 "last record" delimiter.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/**
 * The Authorization header value for one push service (RFC 8292).
 * publicKey: the app's VAPID public key (base64url, 65 bytes); privateKey: its private
 * scalar d (base64url, 32 bytes); subject: an https: or mailto: contact for the push service.
 */
export async function vapidAuth(endpoint, { publicKey, privateKey, subject }, nowSec = Math.floor(Date.now() / 1000)) {
  const pub = fromB64url(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const part = (obj) => b64url(enc.encode(JSON.stringify(obj)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: nowSec + 3600, sub: subject })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${publicKey}`;
}

/**
 * Send one notification. Returns the push service's HTTP status:
 * 201 = accepted; 404 or 410 = the phone unsubscribed, so forget it.
 */
export async function sendPush(sub, message, vapid, { ttl = 12 * 3600 } = {}) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
