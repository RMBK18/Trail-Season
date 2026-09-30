// ─────────────────────────────────────────────────────────────
// Ask tab: offline "smart FAQ".
// Matches keywords in the question against js/data.js and builds the answer
// only from those facts. If the plan doesn't cover it, the answer says so.
// ─────────────────────────────────────────────────────────────

import { HIKES, BASICS, APP, GROUP } from './data.js';
import { CONFIG } from './config.js';
import { esc, mapsUrl, nextHike, torontoDateISO } from './lib.js';
import { isRsvpLive, countsFor } from './rsvp.js';

export const DONT_KNOW = `I don't know that one — ask ${APP.askPerson}!`;
export const FORWARDED = `I don't know that one yet, so I've passed it on to ${APP.askPerson}. To get a reply, send it yourself too:`;
export const OFF_TOPIC_REPLY = `I can only help with the fall hikes.`;

export const SUGGESTIONS = [
  'What time do we meet on Oct 3?',
  'How much is Balls Falls?',
  'Can I bring my dog?',
  'Parking at Rouge Park?',
  'How hard is Rattlesnake Point?',
  'What should I bring?',
  'How long is the drive to Dundas?',
  "What's the backup for Oct 17?",
];

// ── Normalising and keyword helpers ─────────────────────────
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9$'.:/#\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const kwRe = new Map();
function hasKw(q, kw) {
  if (!kwRe.has(kw)) {
    kwRe.set(kw, /^[$#]/.test(kw) ? new RegExp(reEsc(kw)) : new RegExp(`(^|[^a-z0-9])${reEsc(kw)}($|[^a-z0-9])`));
  }
  return kwRe.get(kw).test(q);
}

// ── Which hike is the question about? ───────────────────────
const ALIASES = {
  'forks-of-the-credit': ['forks of the credit', 'forks', 'credit', 'caledon', 'kettle lake', 'kettle trail', 'kettle', 'meadow trail', 'cataract falls', 'mono cliffs'],
  'dundas-valley': ['dundas valley', 'dundas', 'hermitage ruins', 'hermitage', 'main loop', 'heritage trail', 'trail centre', 'trail center', 'thanksgiving', 'headwaters', 'monarch', 'hilton falls'],
  'rattlesnake-point': ['rattlesnake point', 'rattlesnake', 'buffalo crag', 'nassagaweya', 'vista adventure', 'appleby line', 'appleby', 'milton', 'mount nemo', 'mt nemo'],
  'balls-falls': ['balls falls', "ball's falls", 'ball falls', 'balls', 'jordan', 'niagara', 'glen elgin', 'cataract trail', 'upper falls', 'lower falls', 'rock point'],
  rouge: ['rouge national urban park', 'rouge park', 'rouge valley', 'rouge', 'scarborough', 'twyn rivers', 'vista trail', 'mast trail', 'orchard trail', 'glen rouge', 'zoo road', 'halloween', 'crawford lake'],
};

// Phrases removed before topic detection so "Balls Falls" doesn't trigger "falls" (highlights), etc.
const NAME_PHRASES = [
  "ball's falls", 'balls falls', 'ball falls', 'cataract falls', 'upper falls', 'lower falls', 'hilton falls',
  'cataract trail', 'kettle trail', 'meadow trail', 'heritage trail', 'main loop trail', 'main loop', 'buffalo crag trail',
  'vista adventure trail', 'vista trail', 'mast trail', 'orchard trail', 'trail centre', 'trail center',
  'forks of the credit', 'rouge national urban park', 'twyn rivers drive', 'twyn rivers', 'zoo road', 'glen rouge',
];

const BACKUP_NAMES = ['mono cliffs', 'hilton falls', 'mount nemo', 'mt nemo', 'rock point', 'crawford lake', 'headwaters', 'monarch', 'glen rouge'];

const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: 5, final: 5 };

function detectHikes(q, now) {
  const ids = new Set();
  let badDate = null;
  let none = null;

  // "Hilton Falls, Milton" is Dundas's backup, not the Milton hike (Rattlesnake Point).
  const qa = q.replace(/(hilton falls|crawford lake),?\s*milton/g, '$1');
  for (const h of HIKES) for (const a of ALIASES[h.id]) if (hasKw(qa, a)) ids.add(h.id);

  let rest = q;
  // "first hike", "3rd weekend", "last one"
  rest = rest.replace(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\s+(hike|hikes|weekend|week|saturday|one|trip|outing)\b/g, (_, o) => {
    ids.add(HIKES[ORDINALS[o] - 1].id);
    return ' ';
  });
  // "hike 2", "week #3"
  rest = rest.replace(/\b(?:hike|week|weekend)\s*#?\s*([1-5])\b/g, (_, n) => {
    ids.add(HIKES[+n - 1].id);
    return ' ';
  });

  const days = [];
  rest = rest.replace(/\b(?:oct|october)\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b/g, (_, d) => { days.push(+d); return ' '; });
  rest = rest.replace(/\b10\/(\d{1,2})\b/g, (_, d) => { days.push(+d); return ' '; });
  rest = rest.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, (_, d) => { days.push(+d); return ' '; });
  for (const d of days) {
    const h = HIKES.find((x) => x.day === d);
    if (h) ids.add(h.id);
    else badDate = `Oct ${d}`;
  }

  // Relative: "next hike", "this weekend", "tomorrow", "today"
  if (/\b(next|upcoming|this|coming)\s+(hike|weekend|saturday|week|one|trip|outing)\b/.test(q) || /\bcoming up\b/.test(q)) {
    const nx = nextHike(now);
    if (nx) ids.add(nx.id);
    else none = 'coming up';
  }
  for (const [word, offset] of [['today', 0], ['tonight', 0], ['tomorrow', 1]]) {
    if (hasKw(q, word)) {
      const iso = torontoDateISO(new Date(now.getTime() + offset * 86400000));
      const h = HIKES.find((x) => x.dateISO === iso);
      if (h) ids.add(h.id);
      else none = word;
    }
  }

  const hikes = HIKES.filter((h) => ids.has(h.id));
  return { hikes, badDate: hikes.length ? null : badDate, none: hikes.length ? null : none };
}

// ── What is the question about? ─────────────────────────────
// A keyword starting with "~" is soft: it only counts when no other
// (non-weak) topic has a hard match. "weak" topics only answer on their own.
const TOPICS = [
  { id: 'emergency', kws: ['emergency', '911', 'ambulance', 'injured', 'injury', 'accident', 'bleeding', 'broken leg', 'broken arm', 'broke my', 'sprained', "i'm lost", 'im lost', 'i am lost', 'we are lost', "we're lost", 'were lost', 'got lost'] },
  { id: 'cancel', kws: ['cancel', 'cancels', 'cancelled', 'canceled', 'cancellation', 'postpone', 'postponed', 'reschedule', 'rescheduled', 'rain or shine', 'rain date', 'rain plan', 'if it rains', "if it's raining", 'if its raining', 'in the rain', 'bad weather', 'still on', 'still happening', 'called off', 'call it off'] },
  { id: 'carpool', kws: ['carpool', 'carpools', 'carpooling', 'car pool', 'rideshare', 'ride share', 'need a ride', 'get a ride', 'give me a ride', 'give a ride', 'a lift', 'who is driving', "who's driving", 'whos driving', 'spare seat', 'spare seats', 'empty seat', 'empty seats'] },
  { id: 'rsvp', kws: ['rsvp', 'who is coming', "who's coming", 'whos coming', 'who is going', "who's going", 'whos going', 'attending', 'sign up', 'signup', 'count me in', 'headcount', "i'm in", 'im in', 'how many people', 'how many of us', 'who else'] },
  { id: 'ticks', kws: ['tick', 'ticks', 'lyme'] },
  { id: 'kids', kws: ['kid', 'kids', 'child', 'children', 'toddler', 'toddlers', 'baby', 'babies', 'little one', 'little ones', 'son', 'daughter', 'family', 'families', 'family-friendly', 'family friendly'] },
  { id: 'access', kws: ['wheelchair', 'stroller', 'strollers', 'accessible', 'accessibility', 'barrier-free', 'barrier free', 'mobility'] },
  { id: 'washrooms', kws: ['washroom', 'washrooms', 'bathroom', 'bathrooms', 'toilet', 'toilets', 'restroom', 'restrooms', 'loo', 'outhouse', 'outhouses', 'pee', 'privy', 'facilities'] },
  { id: 'dogs', kws: ['dog', 'dogs', 'puppy', 'puppies', 'pup', 'pups', 'pet', 'pets', 'leash', 'leashed', 'doggo'] },
  { id: 'parking', kws: ['parking', 'parking lot', 'parking lots', 'park the car', 'park my car', 'where to park', 'where do we park', 'where do i park', 'where should we park', 'where should i park'] },
  { id: 'fees', kws: ['fee', 'fees', 'cost', 'costs', 'price', 'prices', 'pay', 'paying', 'paid', '$', 'money', 'how much', 'permit', 'permits', 'book', 'booking', 'reserve', 'reservation', 'reservations', 'pass', 'passes', 'ticket', 'tickets', 'free', 'admission', 'entry', 'hst', 'cash', 'expensive'] },
  { id: 'where', kws: ['where', 'location', 'address', 'directions', 'direction', 'map', 'maps', 'google maps', 'meeting spot', 'meeting point', 'gps', 'navigate', 'navigation', 'get there'] },
  { id: 'time', kws: ['what time', 'time', 'times', 'when', 'early', 'earliest', 'start', 'starts', 'starting', 'sunrise', "o'clock", 'arrive', 'arrival', 'gate open', 'gate opens', 'opens', 'opening', '~meet', '~meeting'] },
  { id: 'drive', kws: ['drive', 'driving', 'drives', 'far', 'how far', '~car', '~cars', 'commute', '~away', '~travel', 'road', 'roads', 'traffic', 'detour', 'construction', 'appleby', '~ride', '~rides', 'from toronto', 'from north york', 'north york', 'highway'] },
  { id: 'difficulty', kws: ['hard', 'hardest', 'easy', 'easiest', 'difficult', 'difficulty', 'moderate', 'tough', 'toughest', 'beginner', 'beginners', '~level', '~levels', 'challenging', 'strenuous', 'intense', 'steep'] },
  { id: 'trails', kws: ['trail', 'trails', 'km', 'distance', '~how long', 'loop', 'length', 'kilometres', 'kilometers', 'miles', 'route', 'routes'] },
  { id: 'highlights', kws: ['~see', 'view', 'views', 'highlight', 'highlights', 'beautiful', 'pretty', 'scenic', 'scenery', 'waterfall', 'waterfalls', 'falls', 'special', 'colours', 'colors', 'colour', 'color', 'leaves', 'foliage', 'photo', 'photos', 'pictures', 'lookout', 'worth it'] },
  { id: 'bring', kws: ['~bring', 'pack', 'packing', 'wear', 'wearing', 'clothes', 'clothing', 'gear', 'checklist', 'shoes', 'boots', 'pants', 'prepare', 'prep', 'what do i need', 'what should i need'] },
  { id: 'backup', kws: ['backup', 'back up', 'back-up', 'plan b', 'alternative', 'alternatives', 'alternate', 'fallback', 'fall back', 'instead', 'crowd', 'crowds', 'crowded', 'busy', 'full'] },
  { id: 'food', kws: ['food', 'restaurant', 'restaurants', 'coffee', 'cafe', 'cafes', 'eat', 'eating', 'lunch', 'breakfast', 'brunch', 'dinner', 'snack bar', 'tim hortons', 'tims', 'starbucks', 'hungry', 'grab a bite', 'bite to eat'] },
  { id: 'swim', kws: ['swim', 'swimming', 'swimsuit', 'bathing suit', 'beach', 'beaches', 'wade', 'wading'] },
  { id: 'bikes', kws: ['bike', 'bikes', 'biking', 'bicycle', 'bicycles', 'cycling', 'cyclist', 'mountain bike', 'mountain biking', 'mtb', 'ebike', 'e-bike', 'scooter'] },
  { id: 'cell', kws: ['cell', 'cell service', 'cellphone', 'signal', 'reception', 'coverage', 'wifi', 'wi-fi', 'lte', '5g', 'data', 'phone service'] },
  { id: 'picnic', kws: ['picnic', 'picnics', 'picnic table', 'picnic tables', 'tables'] },
  { id: 'schedule', weak: true, kws: ['schedule', 'all hikes', 'all the hikes', 'hikes', 'list', 'dates', 'which weekends', 'what weekends', 'which saturdays', 'plan', 'itinerary', 'calendar', 'overview', 'season'] },
  { id: 'weather', kws: ['weather', 'rain', 'raining', 'rainy', 'snow', 'snowing', 'cold', 'warm', 'hot', 'sunny', 'wind', 'windy', 'forecast', 'temperature', 'temp'] },
  { id: 'greeting', weak: true, kws: ['hi', 'hello', 'hey', 'hiya', 'good morning', 'yo'] },
  { id: 'thanks', weak: true, kws: ['thanks', 'thank you', 'thx', 'ty', 'cheers', 'appreciate it'] },
];

// Subjects the plan says nothing about. If one of these is the point of the
// question, the app must not guess, so it answers DONT_KNOW.
const OFF_TOPIC = [
  'camping', 'camp', 'fish', 'fishing', 'bear', 'bears', 'hunting', 'gas', 'charger', 'uber', 'transit', 'bus', 'train',
  'bbq', 'fire', 'alcohol', 'beer', 'wine', 'drone', 'drones', 'horse', 'horses', 'sunset', 'colour report', 'peak colour',
];

// A specific topic replaces a broader one that the same question also triggers
// ("Where do we park?" is about parking, not the meeting spot).
const SUPERSEDES = { parking: ['fees', 'where'], food: ['where'], cancel: ['weather'], carpool: ['drive'] };

function detectTopics(q) {
  let t = ' ' + q + ' ';
  for (const p of NAME_PHRASES) t = t.split(p).join(' ');
  const hits = TOPICS.map((topic) => {
    let hard = false, soft = false;
    for (const raw of topic.kws) {
      const isSoft = raw.startsWith('~');
      if (hasKw(t, isSoft ? raw.slice(1) : raw)) (isSoft ? (soft = true) : (hard = true));
    }
    return { topic, hard, soft };
  }).filter((x) => x.hard || x.soft);

  const anyHardStrong = hits.some((x) => x.hard && !x.topic.weak);
  const found = hits
    .filter((x) => !x.topic.weak)
    .filter((x) => x.hard || !anyHardStrong)
    .map((x) => x.topic.id);
  const replaced = new Set(found.flatMap((id) => SUPERSEDES[id] || []));
  const strong = found.filter((id) => !replaced.has(id));
  const weak = hits.filter((x) => x.topic.weak).map((x) => x.topic.id);
  const offTopic = OFF_TOPIC.some((w) => hasKw(t, w));
  return { strong: strong.slice(0, 3), weak, offTopic, anyHardStrong };
}

// ── HTML building blocks (data is escaped; user text never enters HTML) ──
const badge = (level) => `<span class="badge badge-${level.toLowerCase()}">${esc(level)}</span>`;
const list = (items) => `<ul class="ans-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const ext = (url, label) => `<a class="ans-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
const open = (h) => `<a class="ans-link ans-link-soft" href="#/hike/${esc(h.id)}">Open the ${esc(h.dateShort.replace('Sat ', ''))} hike</a>`;
const who = (h) => `<b>${esc(h.dateShort)}</b>, ${esc(h.shortName)}`;

// RSVP: how to reply, plus the latest counts this phone has seen
const rsvpHow = `<p>Open the hike and tap <b>Coming</b>, <b>Maybe</b> or <b>Can't make it</b> under Who's coming. Everyone sees the same list.</p>`;
const rsvpList = (hikes) => {
  const line = (h) => {
    const c = countsFor(h.id);
    const n = c.coming + c.maybe + c.cant;
    return `${who(h)}: ${n ? `${c.people} coming, ${c.maybe} maybe` : 'no replies yet'}`;
  };
  return list(hikes.map(line)) + hikes.slice(0, 2).map((h) => `<a class="ans-link ans-link-soft" href="#/hike/${esc(h.id)}/rsvp">Reply for ${esc(h.dateShort.replace('Sat ', ''))}</a>`).join('');
};
const dontKnow = () => `<p>${esc(DONT_KNOW)}</p>`;
const notInPlan = (what, h) => `<p>The plan doesn't list ${what} at ${esc(h.park)}.</p>` + dontKnow();

const trailLine = (t) => {
  const bits = [t.length, t.time].filter(Boolean).map(esc).join(', ');
  return `${badge(t.level)} <b>${esc(t.name)}</b>${bits ? `: ${bits}` : ''}${t.note ? `. ${esc(t.note)}` : ''}`;
};
const easiestTrail = (h) => h.trails.find((t) => t.level === 'EASY') || h.trails[0];
const tickAlert = (h) => h.alerts.find((a) => a.kind === 'tick');
const barrierFree = (h) => h.trails.find((t) => /barrier-free/i.test(t.note || ''));
const levelText = (h) => `${badge(h.level)}${h.optionLevel ? ` with ${h.optionLevel === 'EASY' ? 'an' : 'a'} ${badge(h.optionLevel)} option` : ''}`;
const meetLine = (h) => `${esc(h.meet.time)}${h.meet.place ? ` at ${esc(h.meet.place)}` : ''}`;
const roadAlert = (h) => h.alerts.filter((a) => a.kind === 'road').map((a) => `<p class="ans-warn"><b>${esc(a.title)}.</b> ${esc(a.text)}</p>`).join('');

const ANSWERS = {
  time: {
    one: (h) => `<p>Meet <b>${meetLine(h)}</b> on ${esc(h.dateShort)}.${h.meet.note ? ' ' + esc(h.meet.note) : ''}</p>`,
    all: () => list(HIKES.map((h) => `${who(h)}: ${meetLine(h)}`)),
  },
  where: {
    one: (h) =>
      (h.meet.place
        ? `<p>Meet at <b>${esc(h.meet.place)}</b>, ${esc(h.park)}${h.meet.address ? ` (${esc(h.meet.address)})` : `, ${esc(h.area)}`}, at ${esc(h.meet.time)}.</p>`
        : `<p>Meet at ${esc(h.meet.time)}. The plan doesn't name a meeting spot inside ${esc(h.park)}.</p>` + dontKnow()) +
      roadAlert(h) + ext(mapsUrl(h.maps), 'Meeting spot in Google Maps'),
    all: () => list(HIKES.map((h) => `${who(h)}: ${h.meet.place ? esc(h.meet.place) + (h.meet.address ? `, ${esc(h.meet.address)}` : '') : 'meeting spot not in the plan'}`)),
  },
  fees: {
    one: (h) => `<p><b>${esc(h.fee.amount)}</b>. ${esc(h.fee.note)}</p>` + (h.booking ? ext(h.booking.url, h.booking.label) : ''),
    all: () => list(HIKES.map((h) => `${who(h)}: <b>${esc(h.fee.amount)}</b>, ${esc(h.fee.short)}`)),
  },
  dogs: {
    one: (h) => (h.dogs ? `<p>${esc(h.dogs)}.</p>` : notInPlan('whether dogs are allowed', h)),
    all: () => list(HIKES.map((h) => `${who(h)}: ${h.dogs ? esc(h.dogs) : 'not in the plan'}`)),
  },
  difficulty: {
    one: (h) => `<p>${levelText(h)}</p>` + list(h.trails.map(trailLine)),
    all: () => list(HIKES.map((h) => `${who(h)}: ${levelText(h)}`)),
  },
  trails: {
    one: (h) => list(h.trails.map(trailLine)),
    all: () => list(HIKES.map((h) => `${who(h)}: ${h.trails.map((t) => esc(t.name) + (t.length ? ` (${esc(t.length)})` : '')).join(', ')}`)),
  },
  drive: {
    one: (h) => `<p>Drive: <b>${esc(h.drive.text)}</b>.</p>` + roadAlert(h) + ext(mapsUrl(h.maps), 'Directions in Google Maps'),
    all: () =>
      list(HIKES.map((h) => `${who(h)}: ${esc(h.drive.text)}`)) +
      HIKES.flatMap((h) => h.alerts.filter((a) => a.kind === 'road').map((a) => `<p class="ans-warn"><b>${esc(h.dateShort)}: ${esc(a.title)}.</b> ${esc(a.text)}</p>`)).join(''),
  },
  washrooms: {
    one: (h) =>
      h.noWashrooms
        ? `<p><b>${esc(h.washrooms)}.</b> Stop before you arrive.</p>`
        : h.washrooms ? `<p>${esc(h.washrooms)}.</p>` : notInPlan('washrooms', h),
    all: () => list(HIKES.map((h) => `${who(h)}: ${h.washrooms ? esc(h.washrooms) : 'not in the plan'}`)),
  },
  bring: {
    one: (h) => `<p>For this hike:</p>` + list(h.bring.map(esc)) + `<p>Every hike: ${esc(BASICS.join(', ').toLowerCase().replace(/^./, (c) => c.toUpperCase()))}.</p>`,
    all: () => `<p>Every hike: ${esc(BASICS.join(', ').toLowerCase().replace(/^./, (c) => c.toUpperCase()))}. Plus:</p>` + list(HIKES.map((h) => `${who(h)}: ${esc(h.bring[0])}`)),
  },
  highlights: {
    one: (h) => `<p>${esc(h.fallLine)}</p>`,
    all: () => list(HIKES.map((h) => `${who(h)}: ${esc(h.fallLine)}`)),
  },
  backup: {
    one: (h) =>
      `<p>Backup: <b>${esc(h.backup.name)}</b>.</p>` +
      (h.alerts.find((a) => a.kind === 'crowd') ? `<p>${esc(h.alerts.find((a) => a.kind === 'crowd').title)}. ${esc(h.alerts.find((a) => a.kind === 'crowd').text)}</p>` : '') +
      ext(mapsUrl(h.backup.maps), `Directions to ${h.backup.name}`),
    all: () => list(HIKES.map((h) => `${who(h)}: ${esc(h.backup.name)}`)),
  },
  picnic: {
    one: (h) => (h.picnic ? `<p>Yes, ${esc(h.park)} has ${esc(h.picnic.toLowerCase())}.</p>` : notInPlan('picnic tables', h)),
    all: () => `<p>The plan lists picnic tables only at Forks of the Credit (Sat Oct 3).</p>`,
  },
  ticks: {
    one: (h) => {
      const a = tickAlert(h);
      return a ? `<p><b>${esc(a.title)}.</b> ${esc(a.text)}</p>` : `<p>The plan doesn't mention ticks at ${esc(h.park)}.</p>`;
    },
    all: () => {
      const hikes = HIKES.filter(tickAlert);
      return hikes.length
        ? list(hikes.map((h) => `${who(h)}: ${esc(tickAlert(h).text)}`))
        : `<p>The plan doesn't mention ticks on any of the hikes.</p>`;
    },
  },
  access: {
    one: (h) => {
      const t = barrierFree(h);
      return t ? `<p>The <b>${esc(t.name)}</b> is barrier-free${t.length ? `: ${esc(t.length)}` : ''}.</p>` : notInPlan('a barrier-free trail', h);
    },
    all: () => {
      const hikes = HIKES.filter(barrierFree);
      return hikes.length
        ? list(hikes.map((h) => `${who(h)}: ${esc(barrierFree(h).name)}`))
        : `<p>The plan doesn't list a barrier-free trail on any of the hikes.</p>` + dontKnow();
    },
  },
  emergency: { one: () => ANSWERS.emergency.all(), all: () => `<p><b>${esc(GROUP.emergency)}</b></p>` },
  kids: {
    one: (h) => {
      const t = easiestTrail(h);
      return `<p>${levelText(h)}. With kids, try the <b>${esc(t.name)}</b>${t.length ? ` (${esc(t.length)})` : ''}.${h.kidsNote ? ' ' + esc(h.kidsNote) : ''}</p>` +
        `<p>${esc(GROUP.kids)}</p>`;
    },
    all: () =>
      `<p>${esc(GROUP.kids)} The easiest trail on each hike:</p>` +
      list(HIKES.map((h) => { const t = easiestTrail(h); return `${who(h)}: ${esc(t.name)}${t.length ? ` (${esc(t.length)})` : ''}`; })),
  },
  parking: {
    one: (h) =>
      `<p>Park at ${esc(h.park)}${h.meet.place ? `, by ${esc(h.meet.place)}${h.meet.address ? ` (${esc(h.meet.address)})` : ''} where we meet` : ''}. <b>${esc(h.fee.amount)}</b>. ${esc(h.fee.note)}</p>` +
      (h.meet.place ? '' : `<p>The plan doesn't say which parking lot we meet at.</p>` + dontKnow()) +
      (h.booking ? ext(h.booking.url, h.booking.label) : ''),
    all: () => `<p>Every park has parking. What you pay to get in:</p>` + list(HIKES.map((h) => `${who(h)}: <b>${esc(h.fee.amount)}</b>, ${esc(h.fee.short)}`)),
  },
  food: {
    one: (h) =>
      `<p>The plan doesn't list food at ${esc(h.park)}, so pack snacks.</p>` +
      (h.food ? `<p>For coffee or a meal before or after: ${esc(h.food)}.</p>` : ''),
    all: () =>
      `<p>The plan doesn't list food at the parks, so pack snacks. For coffee or a meal before or after:</p>` +
      list(HIKES.filter((h) => h.food).map((h) => `${who(h)}: ${esc(h.food)}`)),
  },
  cancel: {
    one: (h) => `<p>${esc(GROUP.rain)}</p><p>Check the weather card on the ${esc(h.dateShort)} hike page.</p>`,
    all: () => `<p>${esc(GROUP.rain)}</p><p>Each hike page has a live weather forecast.</p>`,
  },
  carpool: {
    one: () => ANSWERS.carpool.all(),
    all: () => `<p>${esc(GROUP.carpool)}</p>`,
  },
  swim: { one: () => ANSWERS.swim.all(), all: () => `<p>${esc(GROUP.swim)}</p>` },
  bikes: { one: () => ANSWERS.bikes.all(), all: () => `<p>${esc(GROUP.bikes)}</p>` },
  cell: { one: () => ANSWERS.cell.all(), all: () => `<p>${esc(GROUP.cell)}</p>` },
  rsvp: {
    one: (h) => (isRsvpLive() ? rsvpHow + rsvpList([h]) : ANSWERS.rsvp.all()),
    all: () => (isRsvpLive()
      ? rsvpHow + rsvpList(HIKES.filter((h) => !nextHike() || h.dateISO >= nextHike().dateISO))
      : `<p>RSVPs aren't in the app yet. Reply to the group invite so everyone knows who's coming.</p>`),
  },
  weather: {
    one: (h) => `<p>Check the weather card on the ${esc(h.dateShort)} hike details. The forecast updates as the date approaches.</p>`,
    all: () => `<p>Each hike detail shows a live weather forecast (temperature, precipitation, conditions). Check back closer to the date for an updated forecast.</p>`,
  },
};

function overview(h) {
  return (
    `<p><b>${esc(h.dateLong)}</b>: meet ${meetLine(h)}.</p>` +
    `<p>${levelText(h)}. ${h.trails.length > 1 ? 'Trails' : 'Trail'}: ${h.trails.map((t) => esc(t.name)).join(' or ')}.</p>` +
    `<p>${esc(h.fallLine)}</p>` +
    `<p>Drive ${esc(h.drive.text)}. ${esc(h.fee.amount)}.</p>` +
    roadAlert(h) +
    open(h)
  );
}

function schedule() {
  return `<p>Five Saturdays:</p>` + list(HIKES.map((h) => `${who(h)}: meet ${esc(h.meet.time)} ${badge(h.level)}`));
}

/**
 * Answer a question from the hike plan.
 * unsure: part of the question wasn't covered ("ask Summan"), so the app
 * offers to send it to the organizer.
 * @returns {{ html: string, matched: boolean, unsure: boolean }}
 */
export function answer(raw, now = new Date()) {
  const res = answerFromPlan(raw, now);
  return { ...res, unsure: res.html.includes(esc(DONT_KNOW)) };
}

function answerFromPlan(raw, now) {
  const q = norm(raw);
  if (!q) return { html: '', matched: false };

  const { hikes, badDate, none } = detectHikes(q, now);
  const { strong, weak, offTopic, anyHardStrong } = detectTopics(q);
  if (strong.includes('emergency')) return { matched: true, html: ANSWERS.emergency.all() };

  // The question is about something the plan doesn't cover: don't guess.
  if (offTopic && !anyHardStrong) return { html: dontKnow(), matched: false };
  const tail = offTopic ? `<p>The plan doesn't cover the rest of that.</p>` + dontKnow() : '';

  if (none) {
    const nx = nextHike(now);
    const lead = none === 'coming up' ? 'The fall plan is finished.' : `No hike ${esc(none)}.`;
    return {
      matched: true,
      html: `<p>${lead}${nx ? ` The next one is <b>${esc(nx.dateShort)}</b>: ${esc(nx.park)}, meet ${meetLine(nx)}.` : ''}</p>` + (nx ? open(nx) : ''),
    };
  }
  if (badDate) {
    return {
      matched: true,
      html: `<p>${esc(badDate)} isn't a hike day. The plan has five Saturdays: Oct 3, 10, 17, 24 and 31.</p>`,
    };
  }

  // Naming a backup park or fallback trailhead on its own means "tell me about the backup".
  if (!strong.length && hikes.length && BACKUP_NAMES.some((n) => hasKw(q, n))) strong.push('backup');

  if (!strong.length) {
    if (hikes.length) return { matched: true, html: hikes.slice(0, 2).map(overview).join('<hr>') };
    if (weak.includes('schedule')) return { matched: true, html: schedule() };
    if (weak.includes('greeting')) return { matched: true, html: `<p>Hi! Ask me about meeting times, fees and booking, dogs, difficulty, drive times, washrooms or what to bring.</p>` };
    if (weak.includes('thanks')) return { matched: true, html: `<p>Anytime. See you on the trail 🍂</p>` };
    return { html: dontKnow(), matched: false };
  }

  if (strong.includes('rsvp')) {
    return { matched: true, html: hikes.length ? ANSWERS.rsvp.one(hikes[0]) : ANSWERS.rsvp.all() };
  }

  if (!hikes.length) {
    return { matched: true, html: strong.map((id) => ANSWERS[id].all()).join('') + tail };
  }

  const html = hikes
    .map((h) => {
      const header = `<p class="ans-hike">${esc(h.dateShort)}: ${esc(h.park)}</p>`;
      return header + strong.map((id) => ANSWERS[id].one(h)).join('') + open(h);
    })
    .join('<hr>');
  return { matched: true, html: html + tail };
}

// ═════════════════════════════════════════════════════════════
// PHASE 2 INTEGRATION POINT: LIVE AI ANSWERS
// ═════════════════════════════════════════════════════════════
// Called ONLY when the offline FAQ above has no match AND CONFIG.aiEndpoint
// is set AND the phone is online. In Phase 1 aiEndpoint is null, so this
// always returns null and the user sees DONT_KNOW.
//
// CONFIG.aiEndpoint must point at YOUR server (the Cloudflare Worker in /phase2/ai-worker/).
// That server runs Cloudflare Workers AI, answers only from the hike plan, and
// returns { status: 'answered', answer } or { status: 'unanswered' | 'off_topic',
// forwarded } (forwarded = the organizer got an alert).
// Never call an AI API from this file and never put a key here.
//
// Returns { answer } or { answer: null, forwarded, offTopic }, or null when the
// Worker can't be reached. The answer is shown with textContent (never innerHTML).
// ═════════════════════════════════════════════════════════════
export const isLiveAIOn = () => Boolean(CONFIG.aiEndpoint);

export async function askLiveAI(question) {
  if (!CONFIG.aiEndpoint || !navigator.onLine) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(CONFIG.aiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: String(question).slice(0, 500) }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'answered' && typeof data.answer === 'string' && data.answer.trim()) {
      return { answer: data.answer.trim() };
    }
    return { answer: null, forwarded: data.forwarded === true, offTopic: data.status === 'off_topic' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
