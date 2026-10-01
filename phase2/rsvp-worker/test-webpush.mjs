// ─────────────────────────────────────────────────────────────
// Checks src/webpush.js without a phone or a network. Needs Node 20+.
//   node test-webpush.mjs
// 1. Encryption matches the RFC 8291 test vector byte for byte.
// 2. A phone could decrypt a real message (decrypted here with Node's own crypto).
// 3. The VAPID signature verifies, and its claims are what push services expect.
// ─────────────────────────────────────────────────────────────

import nodeCrypto from 'node:crypto';
import { encryptPayload, vapidAuth, b64url, fromB64url, subscriptionKeysOk } from './src/webpush.js';

let failed = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failed++;
}

// ── 1. RFC 8291, Appendix A ──
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const jwkFor = (pub, d) => {
  const p = fromB64url(pub);
  return { kty: 'EC', crv: 'P-256', x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ...(d ? { d } : {}), ext: true };
};
const asKeyPair = {
  privateKey: await crypto.subtle.importKey('jwk', jwkFor(V.asPublic, V.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  publicKey: await crypto.subtle.importKey('raw', fromB64url(V.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
};
const body = await encryptPayload(V.plaintext, V.uaPublic, V.auth, { salt: fromB64url(V.salt), asKeyPair });
check('Encryption matches the RFC 8291 test vector', b64url(body) === V.body);

// ── 2. Decrypt as the phone would, with Node's crypto (independent of webpush.js) ──
function decrypt(buf, uaPrivateB64, uaPublicB64, authB64) {
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(fromB64url(uaPrivateB64)));
  const shared = ecdh.computeSecret(asPublic);
  const uaPublic = Buffer.from(fromB64url(uaPublicB64));
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, Buffer.from(fromB64url(authB64)), info, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = buf.subarray(21 + idlen);
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  const end = plain.lastIndexOf(2);
  return { rs, text: plain.subarray(0, end).toString('utf8'), delimiter: plain[end] };
}
const v = decrypt(Buffer.from(body), V.uaPrivate, V.uaPublic, V.auth);
check('The RFC message decrypts with Node crypto', v.text === V.plaintext && v.rs === 4096 && v.delimiter === 2);

// A fresh "phone" and a real notification, as the Worker sends it
const phone = nodeCrypto.createECDH('prime256v1');
phone.generateKeys();
const sub = { p256dh: b64url(phone.getPublicKey()), auth: b64url(nodeCrypto.randomBytes(16)) };
const message = JSON.stringify({ title: '🚗 Zoë (Downtown) wants a ride with you', body: 'to Forks of the Credit on Sat Oct 3.', url: '#/hike/forks-of-the-credit/rides' });
const a = await encryptPayload(message, sub.p256dh, sub.auth);
const b = await encryptPayload(message, sub.p256dh, sub.auth);
const got = decrypt(Buffer.from(a), b64url(phone.getPrivateKey()), sub.p256dh, sub.auth);
check('A real notification (emoji, accents) decrypts on the phone side', got.text === message);
check('Every message uses a fresh salt and key', b64url(a.slice(0, 86)) !== b64url(b.slice(0, 86)));
check('Message size stays well under the 4 KB push limit', a.length < 1000, `${a.length} bytes`);
check('Good subscription keys are accepted', subscriptionKeysOk(sub.p256dh, sub.auth));
check('Bad subscription keys are refused', !subscriptionKeysOk('abc', sub.auth) && !subscriptionKeysOk(sub.p256dh, b64url(new Uint8Array(15))) && !subscriptionKeysOk('!!!', '!!!'));
let threw = false;
try { await encryptPayload('x'.repeat(4000), sub.p256dh, sub.auth); } catch { threw = true; }
check('An oversized message is refused', threw);

// ── 3. VAPID ──
const server = nodeCrypto.createECDH('prime256v1');
server.generateKeys();
const vapid = { publicKey: b64url(server.getPublicKey()), privateKey: b64url(server.getPrivateKey()), subject: 'https://fallhike.pages.dev/' };
const now = Math.floor(Date.now() / 1000);
const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc:def', vapid, now);
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
check('Authorization header has the vapid t=…, k=… form', Boolean(m));
const claims = JSON.parse(Buffer.from(fromB64url(m[2])).toString());
const head = JSON.parse(Buffer.from(fromB64url(m[1])).toString());
check('JWT header is ES256', head.alg === 'ES256' && head.typ === 'JWT');
check('Audience is the push service origin', claims.aud === 'https://fcm.googleapis.com');
check('Expires in an hour (Apple and Google allow at most 24 h)', claims.exp === now + 3600);
check('Subject is the app link', claims.sub === vapid.subject);
check('k= is the public key', m[4] === vapid.publicKey);
const pubKey = nodeCrypto.createPublicKey({ key: jwkFor(vapid.publicKey), format: 'jwk' });
const sigOk = nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(m[3])));
check('Signature verifies with the public key', sigOk);
const tampered = nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}x`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(m[3])));
check('A changed token fails to verify', !tampered);

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
