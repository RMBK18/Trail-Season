// ─────────────────────────────────────────────────────────────
// Test the deployed (or local) RSVP Worker. Needs Node 18+.
//
//   node test.mjs https://fall-hike-rsvp.<your-subdomain>.workers.dev
//   node test.mjs http://localhost:8787                 (after `npx wrangler dev`)
//
// Writes only to a hidden test hike ("_selftest"): no alerts, not shown in
// the app, and the test removes its own replies at the end.
//
// LOCAL=1 (local Worker only) also runs a mock push service and a mock ntfy,
// to check the ride alert a driver's phone gets and that phone numbers never
// reach the organizer's alerts. Start the Worker with .dev.vars holding
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, ALLOW_HTTP_PUSH=1, NTFY_TOPIC and
// NTFY_URL=http://127.0.0.1:8799 (see README.md).
// ─────────────────────────────────────────────────────────────

import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { HIKES } from '../../js/data.js';

const [url] = process.argv.slice(2);
const ORIGIN = process.env.ORIGIN || 'https://rmbk18.github.io';
const HIKE = '_selftest';

if (!url) {
  console.error('Usage: node test.mjs <worker-url>');
  process.exit(1);
}

let failed = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failed++;
}

const newDevice = () => `test-${crypto.randomUUID()}`;
const A = newDevice();
const B = newDevice();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Names end with a run id, so leftovers from an interrupted run can't clash.
const RUN = Math.random().toString(36).slice(2, 6);
const N = { D: `Test Driver ${RUN}`, D2: `Test Driver Two ${RUN}`, R1: `Test Rider One ${RUN}`, R2: `Test Rider Two ${RUN}`, R3: `Test Rider Three ${RUN}`, R4: `Test Rider Four ${RUN}` };
const cleanup = [A, B]; // phones whose test replies are removed at the end, even after a failure
const base = url.replace(/\/+$/, '');

// The Worker allows 30 changes a minute per network; this test makes more, so it
// waits when told to ("429 Too many changes") and tries again.
let waitedNote = false;
async function call(method, path, { device, body, origin = ORIGIN, raw } = {}) {
  const headers = { Origin: origin };
  if (device) headers['X-Device'] = device;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 429 || attempt === 3) return { status: res.status, data };
    if (!waitedNote) { console.log('…  waiting for the rate limit (30 changes a minute), then carrying on'); waitedNote = true; }
    await sleep((Number(res.headers.get('Retry-After')) || 60) * 1000 + 1000);
  }
}
const put = (device, body) => call('PUT', `/rsvps/${HIKE}`, { device, body });
const list = async (device) => (await call('GET', `/rsvps/${HIKE}`, { device })).data.list || [];
const me = async (device) => (await list(device)).find((e) => e.mine);
const who = async (name, device = A) => (await list(device)).find((e) => e.name === name);
const seat = (device, driver) => call('PUT', `/rides/${HIKE}`, { device, body: { driver } });

console.log(`Testing ${base} as origin ${ORIGIN}\n`);

try {
  // 1. Health and access rules
  const health = await fetch(base).then((r) => r.json());
  check('Worker is live', health.ok === true);
  check('Storage is connected', health.storageConfigured === true);
  if (!health.alertsConfigured) console.log('NOTE  NTFY_TOPIC is not set, so replies send no alert');
  if (!health.removeLinks) console.log('NOTE  ADMIN_SECRET is not set, so alerts have no "Remove reply" link');

  const pre = await fetch(`${base}/rsvps`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-device' },
  });
  check('CORS preflight allows the app', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN, `status ${pre.status}`);
  check('Other websites are blocked', (await call('GET', '/rsvps', { device: A, origin: 'https://evil.example' })).status === 403);
  check('A missing phone id is rejected', (await call('GET', '/rsvps')).status === 400);

  const all = await call('GET', '/rsvps', { device: A });
  check(`Lists come back for all ${HIKES.length} hikes in the plan`, all.status === 200 && HIKES.every((h) => Array.isArray(all.data.hikes?.[h.id])), Object.keys(all.data.hikes || {}).join(', '));
  check('The test hike is hidden from the app', !(HIKE in (all.data.hikes || {})));

  // 2. Replying
  const r1 = await put(A, { name: 'Test Alex', status: 'coming', guests: 1, carpool: 'driving', seats: 3 });
  check('Phone A replies "Coming +1, driving"', r1.status === 200 && r1.data.change === 'new', `${r1.status} ${r1.data.change ?? r1.data.error}`);
  check('Test replies send no alert', r1.data.alerted === false);
  check('Counts include guests', r1.data.counts?.people === 2, JSON.stringify(r1.data.counts));
  const r2 = await put(A, { name: 'Test Alex', status: 'coming', guests: 1, carpool: 'driving', seats: 3 });
  check('Sending the same reply again changes nothing', r2.status === 200 && r2.data.change === 'same');

  const seenByB = await list(B);
  check('Phone B sees Phone A\'s reply', seenByB.length === 1 && seenByB[0].name === 'Test Alex' && seenByB[0].mine === false);
  check('Phone ids are never sent back', seenByB.every((e) => !('device' in e) && !('id' in e)));
  check('Phone A sees it as its own', (await list(A))[0]?.mine === true);

  // 3. Same name from another phone: "Is that you?"
  const clash = await put(B, { name: '  test   ALEX ', status: 'maybe' });
  check('Same name from another phone asks first', clash.status === 409 && clash.data.error === 'name_taken' && clash.data.name === 'Test Alex', `${clash.status} ${clash.data.error}`);
  check('…and says what that reply was', clash.data.existing?.status === 'coming' && clash.data.existing?.guests === 1 && clash.data.existing?.seats === 3);
  const claim = await put(B, { name: 'Test Alex', status: 'maybe', claim: true });
  check('Confirming takes the reply over', claim.status === 200 && claim.data.list.length === 1 && claim.data.list[0].status === 'maybe' && claim.data.list[0].mine === true);
  check('Phone A no longer owns it', (await list(A))[0]?.mine === false);

  const cant = await put(B, { name: 'Test Alex', status: 'cant', guests: 3, carpool: 'driving', seats: 2 });
  check('"Can\'t make it" drops guests and carpool', cant.status === 200 && cant.data.list[0].guests === 0 && cant.data.list[0].carpool === '');

  // 4. Bad input
  const bad = [
    ['empty name', { name: '   ', status: 'coming' }],
    ['name over 40 characters', { name: 'x'.repeat(41), status: 'coming' }],
    ['unknown status', { name: 'Test Sam', status: 'yes' }],
    ['9 guests', { name: 'Test Sam', status: 'coming', guests: 9 }],
    ['fractional guests', { name: 'Test Sam', status: 'coming', guests: 1.5 }],
    ['9 seats', { name: 'Test Sam', status: 'coming', carpool: 'driving', seats: 9 }],
    ['unknown carpool', { name: 'Test Sam', status: 'coming', carpool: 'bus' }],
  ];
  for (const [what, body] of bad) {
    const r = await put(A, body);
    check(`Rejects ${what}`, r.status === 400, `${r.status} ${r.data.error}`);
  }
  check('Rejects broken JSON', (await call('PUT', `/rsvps/${HIKE}`, { device: A, raw: '{nope' })).status === 400);
  check('Rejects a huge request', (await call('PUT', `/rsvps/${HIKE}`, { device: A, raw: JSON.stringify({ name: 'x', status: 'coming', pad: 'x'.repeat(3000) }) })).status === 413);
  check('Rejects an unknown hike', (await call('PUT', '/rsvps/not-a-hike', { device: A, body: { name: 'Test Sam', status: 'coming' } })).status === 404);

  // 5. Names are stored as plain text: accents and emoji kept, invisible characters dropped
  const fancy = await put(A, { name: 'Zoë\u200b <b>🍂</b>', status: 'maybe' });
  const zoe = fancy.data.list?.find((e) => e.mine);
  check('Accents, emoji and markup come back as plain text', fancy.status === 200 && zoe?.name === 'Zoë <b>🍂</b>', zoe?.name);

  // 6. Removing my reply
  const delA = await call('DELETE', `/rsvps/${HIKE}`, { device: A });
  check('Phone A removes its reply', delA.status === 200 && delA.data.removed === true);
  const delB = await call('DELETE', `/rsvps/${HIKE}`, { device: B });
  check('Phone B removes its reply', delB.status === 200 && delB.data.removed === true && delB.data.list.length === 0);
  const again = await call('DELETE', `/rsvps/${HIKE}`, { device: B });
  check('Removing twice is harmless', again.status === 200 && again.data.removed === false);

  // 7. Organizer links can't be forged
  const forged = await fetch(`${base}/remove?e=abc&s=def`);
  check('A made-up "Remove reply" link is refused', forged.status === 403);

  // 8. Carpool: areas, WhatsApp numbers, seats
  const D = newDevice(), D2 = newDevice(), R1 = newDevice(), R2 = newDevice(), R3 = newDevice(), R4 = newDevice();
  const everyone = cleanup;
  everyone.push(D, D2, R1, R2, R3, R4);

  const d1 = await put(D, { name: N.D, status: 'coming', guests: 0, carpool: 'driving', seats: 3, area: 'downtown', phone: '(416) 555-0100' });
  check('A driver saves area and WhatsApp number', d1.status === 200, `${d1.status} ${d1.data.error ?? ''}`);
  let dEntry = await who(N.D);
  check('…area is matched to the list ("downtown" → Downtown)', dEntry?.area === 'Downtown', dEntry?.area);
  check('…the number gets +1 and is shared for the Message button', dEntry?.phone === '14165550100', dEntry?.phone);
  check('…seats left start at the spare seats', dEntry?.seatsLeft === 3);
  check('Rejects a number that isn\'t a phone number', (await put(D, { name: N.D, status: 'coming', carpool: 'driving', seats: 3, phone: '555-0100' })).status === 400);
  check('Rejects an area over 30 characters', (await put(D, { name: N.D, status: 'coming', carpool: 'driving', seats: 3, area: 'x'.repeat(31) })).status === 400);
  await put(D, { name: N.D, status: 'coming', guests: 0, carpool: 'driving', seats: 3 });
  dEntry = await who(N.D);
  check('An older app version that sends no area or number keeps them', dEntry?.area === 'Downtown' && dEntry?.phone === '14165550100');

  const r3 = await put(R3, { name: N.R3, status: 'coming', carpool: 'need-ride', area: 'Leslieville', phone: '+44 7700 900123' });
  let r3e = await who(N.R3);
  check('A typed "Other" area and an international number are kept', r3.status === 200 && r3e?.area === 'Leslieville' && r3e?.phone === '447700900123', `${r3e?.area} ${r3e?.phone}`);
  await put(R3, { name: N.R3, status: 'coming', carpool: '', area: 'Leslieville', phone: '+44 7700 900123' });
  r3e = await who(N.R3);
  check('Picking "Sorted" removes the number and area', !('phone' in r3e) && !('area' in r3e));
  await put(R3, { name: N.R3, status: 'coming', carpool: 'need-ride', area: 'Scarborough', phone: '' });
  check('A rider who doesn\'t share a number has no phone in the list', !('phone' in (await who(N.R3))));

  await put(R1, { name: N.R1, status: 'coming', guests: 1, carpool: 'need-ride', area: 'North York', phone: '647 555 0111' });
  const s1 = await seat(R1, N.D.toLowerCase());
  check('Ride with: a rider (+1 guest) saves a seat', s1.status === 200 && s1.data.change === 'new' && s1.data.driver === N.D, `${s1.status} ${s1.data.message ?? s1.data.change}`);
  check('…the driver had no alerts on, so none was sent', s1.data.driverAlerted === false);
  dEntry = s1.data.list?.find((e) => e.name === N.D);
  check('…seats left count down by the rider and their guest (3 → 1)', dEntry?.seatsLeft === 1, String(dEntry?.seatsLeft));
  check('…everyone sees who rides with whom', (await who(N.R1))?.ride === N.D);
  check('Tapping Ride with again changes nothing', (await seat(R1, N.D)).data.change === 'same');

  await put(R2, { name: N.R2, status: 'coming', guests: 1, carpool: 'need-ride', area: 'Downtown' });
  const full2 = await seat(R2, N.D);
  check('A rider needing 2 seats can\'t take the last 1', full2.status === 409 && full2.data.error === 'car_full' && full2.data.left === 1 && full2.data.need === 2, `${full2.status} ${full2.data.message}`);
  await put(R2, { name: N.R2, status: 'coming', guests: 0, carpool: 'need-ride', area: 'Downtown' });
  const s2 = await seat(R2, N.D);
  check('…without the guest, the last seat is theirs', s2.status === 200);
  check('…the car shows full (0 seats left)', s2.data.list?.find((e) => e.name === N.D)?.seatsLeft === 0);
  const full3 = await seat(R3, N.D);
  check('A full car takes no more riders', full3.status === 409 && full3.data.error === 'car_full' && full3.data.left === 0, full3.data.message);

  const fewer = await put(D, { name: N.D, status: 'coming', carpool: 'driving', seats: 2 });
  check('A driver can\'t offer fewer seats than are taken', fewer.status === 409 && fewer.data.error === 'seats_taken' && fewer.data.taken === 3, fewer.data.message);
  const more = await put(R1, { name: N.R1, status: 'coming', guests: 2, carpool: 'need-ride', area: 'North York' });
  check('A rider can\'t add guests the car has no room for', more.status === 409 && more.data.error === 'car_full', more.data.message);
  check('…and their reply stays as it was', (await who(N.R1))?.guests === 1);

  const c1 = await call('DELETE', `/rides/${HIKE}`, { device: R1 });
  check('Cancel my seat frees it straight away (0 → 2 left)', c1.status === 200 && c1.data.cancelled === true && c1.data.list.find((e) => e.name === N.D)?.seatsLeft === 2);
  check('…and the rider is back under Need a ride', !('ride' in (await who(N.R1))));
  check('Re-saving the seat works', (await seat(R1, N.D)).status === 200);

  await put(R4, { name: N.R4, status: 'maybe', carpool: 'need-ride', area: 'Etobicoke' });
  const maybe = await seat(R4, N.D);
  check('A "Maybe" can\'t hold a seat', maybe.status === 409 && maybe.data.error === 'not_rider');
  check('…but shows under Need a ride with their area', (await who(N.R4))?.area === 'Etobicoke');
  check('A driver can\'t save a seat', (await seat(D, N.D)).data.error === 'not_rider');
  check('An unknown driver is refused', (await seat(R3, 'Nobody Here')).status === 404);
  check('No reply yet: told to reply first', (await seat(newDevice(), N.D)).data.error === 'no_reply');
  check('A missing driver name is refused', (await call('PUT', `/rides/${HIKE}`, { device: R3, body: {} })).status === 400);

  await put(D2, { name: N.D2, status: 'coming', carpool: 'driving', seats: 2, area: 'Scarborough' });
  const sw = await seat(R2, N.D2);
  check('A rider can switch cars', sw.status === 200 && sw.data.change === 'switched' && sw.data.from === N.D, `${sw.data.change} from ${sw.data.from}`);
  check('…which frees the old seat', sw.data.list.find((e) => e.name === N.D)?.seatsLeft === 1);
  check('A rider holds only one seat at a time', (await list(A)).filter((e) => e.ride).length === 2);

  // Driver drops out: riders lose their seats and see why
  await put(D, { name: N.D, status: 'coming', carpool: '' });
  const r1me = await me(R1);
  check('Driver stops driving: their rider loses the seat', !('ride' in r1me) && r1me.carpool === 'need-ride');
  check('…and is told who stopped driving (only they see it)', r1me.lostRide === N.D && !('lostRide' in (await who(N.R1))));
  check('…their WhatsApp number is gone too', !('phone' in (await who(N.D))));
  const okLost = await call('DELETE', `/rides/${HIKE}`, { device: R1 });
  check('Dismissing the notice clears it', okLost.status === 200 && !('lostRide' in (await me(R1))));

  // Ride alerts sign-up (no notification is sent for the test hike on the live Worker)
  const status = await fetch(base).then((r) => r.json());
  const keys = () => {
    const e = nodeCrypto.createECDH('prime256v1');
    e.generateKeys();
    return { phone: e, p256dh: e.getPublicKey('base64url'), auth: nodeCrypto.randomBytes(16).toString('base64url') };
  };
  const k = keys();
  const subBody = (endpoint) => ({ endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
  if (status.rideAlerts) {
    check('Ride alerts: a rider can\'t turn them on', (await call('PUT', `/push/${HIKE}`, { device: R1, body: subBody('https://fcm.googleapis.com/fcm/send/test-abc') })).data.error === 'not_driver');
    check('Ride alerts: other websites can\'t be used as the push address', (await call('PUT', `/push/${HIKE}`, { device: D2, body: subBody('https://evil.example/push') })).status === 400);
    check('Ride alerts: bad keys are refused', (await call('PUT', `/push/${HIKE}`, { device: D2, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'abc', auth: 'def' } } })).status === 400);
    const on = await call('PUT', `/push/${HIKE}`, { device: D2, body: subBody('https://fcm.googleapis.com/fcm/send/test-abc') });
    check('Ride alerts: a driver turns them on', on.status === 200 && on.data.list.find((e) => e.mine)?.alerts === true);
    check('…only the driver\'s own phone sees that', !('alerts' in (await who(N.D2))));
    const off = await call('DELETE', `/push/${HIKE}`, { device: D2 });
    check('Ride alerts: and off again', off.status === 200 && off.data.list.find((e) => e.mine)?.alerts === false);
    await call('PUT', `/push/${HIKE}`, { device: D2, body: subBody('https://fcm.googleapis.com/fcm/send/test-abc') });
    await put(D2, { name: N.D2, status: 'coming', carpool: 'driving', seats: 2, area: 'Scarborough' });
    check('…they stay on while still driving', (await me(D2)).alerts === true);
    const claimer = newDevice();
    everyone.push(claimer);
    await put(claimer, { name: N.D2, status: 'coming', carpool: 'driving', seats: 2, claim: true });
    check('"Is that you?" on a new phone: alerts don\'t follow to it', (await me(claimer))?.alerts === false);
    check('…but the rider keeps their seat in that car', (await who(N.R2))?.ride === N.D2);
    await call('PUT', `/push/${HIKE}`, { device: claimer, body: subBody('https://fcm.googleapis.com/fcm/send/test-abc') });
    await put(claimer, { name: N.D2, status: 'maybe', carpool: 'driving', seats: 2 });
    check('A driver who changes to Maybe: alerts off and riders released', (await me(claimer)).alerts === false && (await me(R2)).lostRide === N.D2);
    await put(claimer, { name: N.D2, status: 'coming', carpool: 'driving', seats: 2, area: 'Scarborough' });
    await seat(R2, N.D2);
    await call('DELETE', `/rsvps/${HIKE}`, { device: claimer });
    check('Removing a driver\'s reply releases their riders', (await me(R2)).lostRide === N.D2 && !('ride' in (await me(R2))));
  } else {
    console.log('NOTE  Ride alerts are not set up (no VAPID keys), so their checks were skipped');
  }

  if (process.env.LOCAL === '1') await localChecks();

  for (const dev of everyone) await call('DELETE', `/rsvps/${HIKE}`, { device: dev });
  check('Test carpool replies cleaned up', (await list(A)).length === 0);
} catch (err) {
  console.error(`\nCould not reach ${base}: ${err.message}`);
  failed++;
} finally {
  for (const dev of cleanup) await call('DELETE', `/rsvps/${HIKE}`, { device: dev }).catch(() => {});
}

// ── LOCAL=1: mock push service and mock ntfy ────────────────
async function localChecks() {
  const pushes = [];
  const ntfy = [];
  let pushStatus = 201;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith('/push/')) pushes.push({ url: req.url, headers: req.headers, body });
      else ntfy.push(JSON.parse(body.toString() || '{}'));
      res.writeHead(req.url.startsWith('/push/') ? pushStatus : 200);
      res.end();
    });
  });
  await new Promise((r) => mock.listen(8799, '127.0.0.1', r));
  try {
    const all = await call('GET', '/rsvps', { device: A });
    const pushKey = all.data.pushKey;
    check('LOCAL  The app gets the public VAPID key with the lists', typeof pushKey === 'string' && pushKey.length > 80);

    const phone = nodeCrypto.createECDH('prime256v1');
    phone.generateKeys();
    const auth = nodeCrypto.randomBytes(16);
    const LD = newDevice(), LR = newDevice(), LR2 = newDevice();
    cleanup.push(LD, LR, LR2);
    await put(LD, { name: `Local Driver ${RUN}`, status: 'coming', carpool: 'driving', seats: 2, area: 'Downtown' });
    const on = await call('PUT', `/push/${HIKE}`, { device: LD, body: { endpoint: 'http://127.0.0.1:8799/push/phone-1', keys: { p256dh: phone.getPublicKey('base64url'), auth: auth.toString('base64url') } } });
    check('LOCAL  Driver turns on ride alerts', on.status === 200);
    await put(LR, { name: `Zoë ${RUN}`, status: 'coming', carpool: 'need-ride', area: 'Markham', phone: '416 555 0199' });
    const s = await seat(LR, `Local Driver ${RUN}`);
    await sleep(400);
    check('LOCAL  Ride with → the driver\'s phone gets one notification', s.data.driverAlerted === true && pushes.length === 1, `${pushes.length} push(es)`);
    const p = pushes[0];
    if (p) {
      check('LOCAL  …encrypted (aes128gcm), with TTL and high urgency', p.headers['content-encoding'] === 'aes128gcm' && Number(p.headers.ttl) > 0 && p.headers.urgency === 'high');
      const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(p.headers.authorization || '');
      const pub = Buffer.from(pushKey, 'base64url');
      const key = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
      const sigOk = m && nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
      check('LOCAL  …signed with the app\'s VAPID key', Boolean(sigOk) && m[4] === pushKey);
      // Decrypt it as the phone would
      const b = p.body;
      const asPublic = b.subarray(21, 21 + b[20]);
      const shared = phone.computeSecret(asPublic);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), phone.getPublicKey(), asPublic]), 32));
      const salt = b.subarray(0, 16);
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const data = b.subarray(21 + b[20]);
      const dec = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
      dec.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([dec.update(data.subarray(0, data.length - 16)), dec.final()]);
      const msg = JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
      check('LOCAL  …the phone decrypts "🚗 Zoë … (Markham) wants a ride with you"', msg.title === `🚗 Zoë ${RUN} (Markham) wants a ride with you`, msg.title);
      check('LOCAL  …tapping it opens the hike\'s rides', msg.url === `#/hike/${HIKE}/rides`);
      check('LOCAL  …and it carries no phone number', !/5550199|555 0199/.test(JSON.stringify(msg)));
    }
    await call('DELETE', `/rides/${HIKE}`, { device: LR });
    await seat(LR, `Local Driver ${RUN}`);
    await sleep(300);
    check('LOCAL  Cancel and re-tap Ride with: no second notification', pushes.length === 1, `${pushes.length}`);
    await put(LR2, { name: `Local Rider Two ${RUN}`, status: 'coming', guests: 1, carpool: 'need-ride', area: 'Downtown' });
    const full = await seat(LR2, `Local Driver ${RUN}`);
    await sleep(300);
    check('LOCAL  A request the full car refuses sends nothing', full.status === 409 && pushes.length === 1);
    await put(LR2, { name: `Local Rider Two ${RUN}`, status: 'coming', guests: 0, carpool: 'need-ride', area: 'Downtown' });
    pushStatus = 410; // the driver's phone unsubscribed
    const s2 = await seat(LR2, `Local Driver ${RUN}`);
    await sleep(400);
    check('LOCAL  A second rider sends a second notification', s2.status === 200 && pushes.length === 2);
    check('LOCAL  Push service says "gone" (410): the sign-up is forgotten', (await me(LD)).alerts === false);

    // Organizer alerts on a real hike: numbers never included
    const real = HIKES[HIKES.length - 1].id;
    const RN = newDevice();
    cleanup.push(RN);
    ntfy.length = 0;
    await call('PUT', `/rsvps/${real}`, { device: RN, body: { name: `Local Ntfy Check ${RUN}`, status: 'coming', carpool: 'need-ride', area: 'Downtown', phone: '416 555 0177' } });
    await call('PUT', `/rsvps/${real}`, { device: RN, body: { name: `Local Ntfy Check ${RUN}`, status: 'coming', carpool: 'driving', seats: 2, area: 'Downtown', phone: '416 555 0177' } });
    await call('DELETE', `/rsvps/${real}`, { device: RN });
    await sleep(500);
    check('LOCAL  Organizer alerts were sent (new, changed, removed)', ntfy.length === 3, `${ntfy.length}`);
    check('LOCAL  …and none contains the phone number', ntfy.length > 0 && ntfy.every((n) => !/555.?0177|4165550177/.test(JSON.stringify(n))));
  } finally {
    mock.close();
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
