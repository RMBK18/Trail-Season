// ─────────────────────────────────────────────────────────────
// Test the deployed (or local) RSVP Worker. Needs Node 18+.
//
//   node test.mjs https://fall-hike-rsvp.<your-subdomain>.workers.dev
//   node test.mjs http://localhost:8787                 (after `npx wrangler dev`)
//
// Writes only to a hidden test hike ("_selftest"): no alerts, not shown in
// the app, and the test removes its own replies at the end.
// ─────────────────────────────────────────────────────────────

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
const base = url.replace(/\/+$/, '');

async function call(method, path, { device, body, origin = ORIGIN, raw } = {}) {
  const headers = { Origin: origin };
  if (device) headers['X-Device'] = device;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const put = (device, body) => call('PUT', `/rsvps/${HIKE}`, { device, body });
const list = async (device) => (await call('GET', `/rsvps/${HIKE}`, { device })).data.list || [];

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
  check('Lists come back for all five hikes', all.status === 200 && Object.keys(all.data.hikes || {}).length === 5, Object.keys(all.data.hikes || {}).join(', '));
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
} catch (err) {
  console.error(`\nCould not reach ${base}: ${err.message}`);
  process.exit(1);
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
