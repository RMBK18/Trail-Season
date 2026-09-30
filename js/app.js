import { HIKES, BASICS, APP, KIDS_LABELS, hikeById } from './data.js';
import { esc, mapsUrl, meetMs, endMs, statusOf, nextHike, isHikeDay, countdownParts } from './lib.js';
import { answer, askLiveAI, isLiveAIOn, DONT_KNOW, FORWARDED, OFF_TOPIC_REPLY, SUGGESTIONS } from './ask.js';
import {
  isRsvpLive, setRsvp, removeRsvp, subscribeRsvps, refreshAll, countsFor, myReply,
  onRsvpChange, onRsvpProblem, RSVP_STATUSES, RSVP_LABELS, MAX_GUESTS, MAX_SEATS,
} from './rsvp.js';
import { I } from './icons.js';
import { getWeather, describeWeather } from './weather.js';
import { showAdminPanel } from './editor.js';
import { getHikes } from './admin.js';

// ── Tiny helpers ────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: ignore */ }
  },
};
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const badge = (level, opt = false) =>
  `<span class="badge badge-${level.toLowerCase()}${opt ? ' badge-opt' : ''}">${esc(level)}${opt ? ' option' : ''}</span>`;
const levelBadges = (h) => badge(h.level) + (h.optionLevel ? badge(h.optionLevel, true) : '');
const kidsTag = (h) =>
  KIDS_LABELS[h.kids] ? `<span class="kids-tag kids-${esc(h.kids)}">${I.users}${esc(KIDS_LABELS[h.kids])}</span>` : '';
const easiestTrail = (h) => h.trails.find((t) => t.level === 'EASY') || h.trails[0];
// Credit line the photo licences require (author, licence, source; photos are cropped).
const photoCredit = (p, what = 'Photo') =>
  p ? `${what}: <a href="${esc(p.source)}" target="_blank" rel="noopener">${esc(p.author)}</a>, ${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}" target="_blank" rel="noopener">${esc(p.license)}</a>` : esc(p.license)}, via Wikimedia Commons (cropped)` : '';
const pad2 = (n) => String(n).padStart(2, '0');

// ── Platform detection (install instructions) ───────────────
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|Line\//i.test(ua);
const iosNotSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
const iosMajor = (() => {
  const m = ua.match(/Version\/(\d+)/) || ua.match(/OS (\d+)_/);
  return m ? Number(m[1]) : null;
})();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let deferredInstall = null;

// ── Toast ───────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to legacy copy */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ── Invite messages (built only from data.js) ───────────────
function trailsSummary(h) {
  const fmt = (t) => [t.name, t.length, t.time ? `(${t.time})` : null].filter(Boolean).join(' ');
  const main = h.trails.filter((t) => t.level === h.level).map(fmt).join(' + ');
  const opt = h.trails.filter((t) => t.level !== h.level).map(fmt).join(' + ');
  return `${h.level}: ${main}${opt ? `. ${h.optionLevel} option: ${opt}` : ''}`;
}

function inviteText(h) {
  const alerts = h.alerts.filter((a) => a.kind !== 'time' && a.kind !== 'permit');
  return [
    `🍂 Fall hike: ${h.dateShort}`,
    `${h.park}, ${h.area}`,
    '',
    `⏰ Meet ${h.meet.time}${h.meet.place ? ` at ${h.meet.place}` : ''}.${h.meet.note ? ` ${h.meet.note}` : ''}`,
    ...(h.meet.address ? [`📍 ${h.meet.address}: ${mapsUrl(h.maps)}`] : []),
    `🥾 ${trailsSummary(h)}`,
    `🍁 ${h.fallLine}`,
    `🚗 Drive: ${h.drive.text}`,
    `🎟️ ${h.fee.amount}. ${h.fee.note}${h.booking ? ` ${h.booking.url}` : ''}`,
    ...alerts.map((a) => `⚠️ ${a.title}. ${a.text}`),
    `🔁 Backup: ${h.backup.name}`,
    '',
    ...(isRsvpLive()
      ? ['Are you in? Tap "Coming" here:', `${appUrl()}#/hike/${h.id}/rsvp`]
      : ['Are you in? Reply here.', `Details: ${appUrl()}#/hike/${h.id}`]),
  ].join('\n');
}

function seasonText() {
  return [
    '🍂 Fall Hike App: five Saturday hikes near Toronto',
    '',
    ...HIKES.map((h) => `${h.dateShort}: ${h.park}, meet ${h.meet.time} (${h.level}${h.optionLevel ? ` / ${h.optionLevel} option` : ''})`),
    '',
    `Details and install: ${appUrl()}`,
  ].join('\n');
}

// ═════════════════════════════════════════════════════════════
// HIKES TAB
// ═════════════════════════════════════════════════════════════
let homeKey = '';
let homeShown = false; // cards rise in once, on first open

function homeStateKey(now) {
  const nx = nextHike(now);
  return nx ? `${nx.id}:${statusOf(nx, now)}` : 'done';
}

function cardHTML(h, now, nx) {
  const st = statusOf(h, now);
  const isNext = nx && nx.id === h.id;
  const chip =
    st === 'done' ? '<span class="chip chip-done">Done</span>'
      : isNext && (st === 'live' || isHikeDay(h, now)) ? '<span class="chip chip-today">Today</span>'
        : isNext ? '<span class="chip chip-next">Next up</span>' : '';
  return `
  <li class="stop stop-${st}${isNext ? ' stop-next' : ''}">
    <span class="blaze blaze-${h.level.toLowerCase()}" aria-hidden="true"></span>
    <a class="card${h.photo ? ' has-photo' : ''}" href="#/hike/${h.id}" data-push>
      ${h.photo
        ? `<span class="card-media"><img class="card-photo" src="${esc(h.photo.src)}" alt="" loading="lazy" decoding="async"><span class="card-date">${esc(h.dateShort)}</span>${chip}</span>`
        : `<span class="card-top"><span class="card-date">${esc(h.dateShort)}</span>${chip}</span>`}
      <h3 class="card-park">${esc(h.park)}</h3>
      <span class="card-area">${esc(h.area)}</span>
      <span class="card-badges">${levelBadges(h)}${kidsTag(h)}</span>
      <span class="card-facts">
        <span class="fact-inline">${I.clock}Meet ${esc(h.meet.time)}</span>
        <span class="fact-inline">${I.car}${esc(h.drive.short)}</span>
        ${isRsvpLive() ? `<span class="fact-inline going" data-going="${h.id}" hidden>${I.users}<span></span></span>` : ''}
      </span>
      <span class="card-chev">${I.chevR}</span>
    </a>
  </li>`;
}

function signHTML(now, allHikes = getHikes()) {
  const nx = allHikes.find((h) => now.getTime() <= endMs(h)) || null;
  if (!nx) {
    return `<div class="sign sign-end">
      <span class="sign-label">Fall plan complete</span>
      <span class="sign-park">Five Saturdays, five parks. Thanks for hiking.</span>
    </div>`;
  }
  const st = statusOf(nx, now);
  const meetText = `Meet ${esc(nx.meet.time)}${nx.meet.place ? ` at ${esc(nx.meet.place)}` : ''}`;
  if (st === 'live') {
    return `<a class="sign" href="#/hike/${nx.id}" data-push>
      <span class="sign-label">Today, ${esc(nx.dateShort)}</span>
      <span class="sign-park">${esc(nx.park)}</span>
      <span class="sign-live">On the trail today. ${meetText}.</span>
      <span class="sign-cta">See the plan${I.chevR}</span>
    </a>`;
  }
  const label = isHikeDay(nx, now) ? `Today, ${esc(nx.dateShort)}` : `Next hike, ${esc(nx.dateShort)}`;
  return `<a class="sign" href="#/hike/${nx.id}" data-push aria-describedby="sign-count">
    <span class="sign-label">${label}</span>
    <span class="sign-park">${esc(nx.park)}</span>
    <span class="sign-count" id="sign-count" role="timer" aria-label="Time until meet">
      <span class="unit"><b data-u="days">0</b><small>days</small></span>
      <span class="unit"><b data-u="hours">00</b><small>hrs</small></span>
      <span class="unit"><b data-u="minutes">00</b><small>min</small></span>
      <span class="unit"><b data-u="seconds">00</b><small>sec</small></span>
    </span>
    <span class="sign-meet">${I.clock}${meetText}</span>
    <span class="sign-cta">See the plan${I.chevR}</span>
  </a>`;
}

// "Five weekends. Five shades of fall." → the second sentence in italics
function taglineHTML(text) {
  const m = /^(.+?[.!?])\s+(.+)$/.exec(text);
  return m ? `${esc(m[1])} <em>${esc(m[2])}</em>` : esc(text);
}

// "Oct 3 – Oct 31" from the first and last hike
function dateSpan(hikes) {
  if (!hikes.length) return '';
  const d = (h) => h.dateShort.replace(/^[A-Za-z]{3}\s+/, '');
  return hikes.length > 1 ? `${d(hikes[0])} – ${d(hikes[hikes.length - 1])}` : d(hikes[0]);
}

function renderHome() {
  const now = new Date();
  const allHikes = getHikes();
  const nx = allHikes.find((h) => now.getTime() <= endMs(h)) || null;
  homeKey = homeStateKey(now);
  const showGetApp = !isStandalone() && (isIOS || isAndroid);
  $('#view-hikes').innerHTML = `
    <header class="canopy${APP.photo ? ' has-photo' : ''}">
      ${APP.photo ? `<img class="canopy-photo" src="${esc(APP.photo.src)}" alt="" decoding="async">` : ''}
      <button id="admin-btn" class="glass-btn" type="button" title="Edit hikes" aria-label="Edit hikes">${I.sliders}</button>
      <p class="canopy-eyebrow">${esc(APP.name)}</p>
      <h1 class="large-title">${taglineHTML(APP.tagline || APP.name)}</h1>
      <p class="canopy-sub">${esc(APP.intro || 'Five Saturdays near Toronto, Oct 3 to Oct 31')}</p>
      ${APP.chips ? `<div class="glass-chips">${APP.chips.map((c) => `<span class="glass-chip">${esc(c)}</span>`).join('')}</div>` : ''}
      ${signHTML(now, allHikes)}
    </header>
    <section class="list-wrap" aria-labelledby="list-h">
      ${showGetApp ? `<button class="get-app" type="button" data-open-install>${I.download}<span><b>Add to your home screen</b><span>Opens full screen and works without signal</span></span>${I.chevR}</button>` : ''}
      <p class="section-eyebrow">${esc(dateSpan(allHikes))}</p>
      <h2 id="list-h" class="section-h">${allHikes.length === 5 ? 'The five Saturdays' : 'Upcoming Hikes'}</h2>
      <ol class="trail${homeShown ? '' : ' rise'}">${allHikes.map((h) => cardHTML(h, now, nx)).join('')}</ol>
      <p class="list-foot">Tap a hike for trails, fees, directions and what to bring.</p>
      ${APP.photo ? `<p class="photo-credit">${photoCredit(APP.photo, 'Top photo')}. Park photos are credited on each hike page.</p>` : ''}
    </section>`;
  fillGoing();
  if (!homeShown) {
    homeShown = true;
    setTimeout(() => $('#view-hikes .trail')?.classList.remove('rise'), 1200);
  }
  tickSign();
}

function tickSign() {
  const now = new Date();
  if (homeStateKey(now) !== homeKey) return renderHome();
  const nx = nextHike(now);
  if (!nx) return;
  const p = countdownParts(meetMs(nx) - now.getTime());
  const set = (u, v) => { const el = $(`[data-u="${u}"]`); if (el && el.textContent !== v) el.textContent = v; };
  set('days', String(p.days));
  set('hours', pad2(p.hours));
  set('minutes', pad2(p.minutes));
  set('seconds', pad2(p.seconds));
}

// ═════════════════════════════════════════════════════════════
// HIKE DETAIL
// ═════════════════════════════════════════════════════════════
const ACCENTS = {
  rust: ['#B04A1E', '#E4A338'],
  forest: ['#3F7A4F', '#E4A338'],
  amber: ['#D8952C', '#B04A1E'],
  falls: ['#C8702A', '#F2C46B'],
  dawn: ['#D9835A', '#F2C46B'],
};

function heroArt(h) {
  const [a, b] = ACCENTS[h.accent] || ACCENTS.rust;
  const k = h.n * 37;
  const y = (i) => 70 + ((k * (i + 3)) % 38);
  return `<svg class="hero-art" viewBox="0 0 400 160" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 ${y(1)} C60 ${y(2) - 30} 110 ${y(3)} 170 ${y(4) - 22} S290 ${y(5)} 400 ${y(6) - 26} V160 H0Z" fill="${a}" opacity=".45"/>
    <path d="M0 ${y(7) + 30} C80 ${y(8) + 4} 150 ${y(9) + 40} 240 ${y(10) + 14} S350 ${y(11) + 36} 400 ${y(12) + 20} V160 H0Z" fill="${a}" opacity=".75"/>
    <path d="M0 150 C90 128 200 146 300 132 S380 140 400 136 V160 H0Z" fill="var(--hero-floor)"/>
    <g fill="${b}">
      <path d="M318 34c10 4 14 14 10 24-10-2-16-12-10-24Z" transform="rotate(${h.n * 23} 322 46)"/>
      <path d="M352 62c8 3 11 11 8 19-8-2-12-9-8-19Z" transform="rotate(${h.n * -31} 356 72)" opacity=".8"/>
    </g>
  </svg>`;
}

function alertsHTML(h) {
  if (!h.alerts.length) return '';
  return `<div class="alerts">${h.alerts
    .map((a) => `<div class="alert alert-${a.kind}" role="note">${a.kind === 'time' ? I.clock : a.kind === 'road' ? I.route : a.kind === 'permit' ? I.ticket : I.alert}<div><b>${esc(a.title)}</b><span>${esc(a.text)}</span></div></div>`)
    .join('')}</div>`;
}

function trailRow(t) {
  const meta = [t.length, t.time].filter(Boolean).map(esc).join(' · ');
  return `<li class="trail-row">
    ${badge(t.level)}
    <div><b>${esc(t.name)}</b>${meta ? `<span class="trail-meta">${meta}</span>` : ''}${t.note ? `<span class="trail-note">${esc(t.note)}</span>` : ''}</div>
  </li>`;
}

function checklistHTML(h) {
  const saved = new Set(store.get(`fh:check:${h.id}`, []));
  const item = (label) =>
    `<li><label class="check"><input type="checkbox" data-check="${esc(label)}"${saved.has(label) ? ' checked' : ''}><span class="box">${I.check}</span><span class="check-label">${esc(label)}</span></label></li>`;
  return `
    <h3 class="sub-h">For this hike</h3>
    <ul class="checklist">${h.bring.map(item).join('')}</ul>
    <h3 class="sub-h">Every hike</h3>
    <ul class="checklist">${BASICS.map(item).join('')}</ul>
    <p class="fine">Checks are saved on this phone only.</p>`;
}

// ═════════════════════════════════════════════════════════════
// SHARED RSVP UI ("Who's coming")
// Live when CONFIG.rsvpEndpoint is set (js/rsvp.js talks to the RSVP Worker).
// Otherwise the section offers "Copy my reply" for the group chat.
// ═════════════════════════════════════════════════════════════
let rsvpUnsub = null;

const stepperHTML = (key, label, hint, value, min, max) => `
  <div class="stepper-row" data-row="${key}">
    <span class="stepper-label">${label}${hint ? `<small>${hint}</small>` : ''}</span>
    <span class="stepper" data-stepper="${key}" data-min="${min}" data-max="${max}">
      <button type="button" data-step="-1" aria-label="${label}: one less">−</button>
      <output aria-live="polite">${value}</output>
      <button type="button" data-step="1" aria-label="${label}: one more">+</button>
    </span>
  </div>`;

const SEG_LABELS = { coming: 'Coming', maybe: 'Maybe', cant: "Can't go" };

function rsvpFormHTML(h) {
  const mine = myReply(h.id);
  const status = mine?.status || 'coming';
  const carpool = mine?.carpool || '';
  const seg = (attr, value, label, on) => `<button type="button" class="seg-btn" ${attr}="${value}" aria-pressed="${on}">${label}</button>`;
  return `
    <form class="rsvp-form" data-rsvp-form="${h.id}" data-dirty="false" novalidate>
      <label class="rsvp-name"><span>Your name</span><input type="text" maxlength="40" autocomplete="given-name" enterkeyhint="done" data-rsvp-name value="${esc(mine?.name || store.get('fh:name', ''))}"></label>
      <div class="seg" role="group" aria-label="Your answer">
        ${RSVP_STATUSES.map((st) => seg('data-rsvp-pick', st, esc(SEG_LABELS[st]), st === status)).join('')}
      </div>
      <div class="rsvp-extras" data-rsvp-extras ${status === 'cant' ? 'hidden' : ''}>
        ${stepperHTML('guests', 'People with you', 'Friends or kids', mine?.guests || 0, 0, MAX_GUESTS)}
        <div class="carpool-row">
          <span class="stepper-label">Carpool</span>
          <div class="seg seg-sm" role="group" aria-label="Carpool">
            ${seg('data-rsvp-carpool', '', 'Sorted', carpool === '')}
            ${seg('data-rsvp-carpool', 'driving', 'I can drive', carpool === 'driving')}
            ${seg('data-rsvp-carpool', 'need-ride', 'Need a ride', carpool === 'need-ride')}
          </div>
        </div>
        <div data-seats ${carpool === 'driving' ? '' : 'hidden'}>${stepperHTML('seats', 'Spare seats', '', mine?.seats || 3, 1, MAX_SEATS)}</div>
      </div>
      <div class="rsvp-claim" data-rsvp-claim hidden></div>
      <button class="btn btn-primary" type="submit" data-rsvp-send>${mine ? 'Update my reply' : 'Send my reply'}</button>
      <button class="btn btn-text" type="button" data-rsvp-remove ${mine ? '' : 'hidden'}>Remove my reply</button>
      <p class="fine">Everyone with the app sees your name. Replies are deleted a week after the hike.</p>
    </form>`;
}

function rsvpSectionHTML(h) {
  if (isRsvpLive()) {
    const over = statusOf(h) === 'done';
    return `<div class="rsvp" data-rsvp="${h.id}">
      <p class="rsvp-tally" data-rsvp-tally></p>
      ${over ? '<p class="muted">This hike is over, so replies are closed.</p>' : rsvpFormHTML(h)}
      <div class="rsvp-list" aria-live="polite"></div>
    </div>`;
  }
  return `<div class="rsvp-reply" data-reply="${h.id}">
    <p>RSVPs aren't shared in the app yet — but you can reply in one tap and paste it into the group chat.</p>
    <label class="rsvp-name"><span>Your name</span><input type="text" maxlength="40" autocomplete="given-name" data-reply-name value="${esc(store.get('fh:name', ''))}"></label>
    <div class="btn-row">${RSVP_STATUSES.map((s, i) => `<button class="btn btn-secondary btn-choice" type="button" data-reply-status="${s}" aria-pressed="${i === 0}">${esc(RSVP_LABELS[s])}</button>`).join('')}</div>
    <button class="btn btn-primary" type="button" data-copy-reply="${h.id}">${I.copy}<span>Copy my reply</span></button>
    <p class="muted">This copies a message for you to paste in the group chat. It doesn't publish a shared guest list.</p>
  </div>`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr} h ago` : `${Math.round(hr / 24)} days ago`;
}

function whoChip(e) {
  const tags = [];
  if (e.carpool === 'driving') tags.push(`driving${e.seats ? `, ${plural(e.seats, 'seat', 'seats')}` : ''}`);
  if (e.carpool === 'need-ride') tags.push('needs a ride');
  return `<li class="who${e.mine ? ' who-me' : ''}"><b>${esc(e.name)}</b>${e.guests ? `<em>+${e.guests}</em>` : ''}${e.mine ? '<span class="who-you">you</span>' : ''}${tags.length ? `<span class="who-tag">${esc(tags.join(' · '))}</span>` : ''}${e.pending ? '<span class="who-tag">not sent yet</span>' : ''}</li>`;
}

function renderRsvpList({ list, at, pending }, error) {
  const box = $('#view-detail .rsvp-list');
  const tally = $('#view-detail [data-rsvp-tally]');
  if (!box) return;
  const c = { coming: 0, maybe: 0, cant: 0, people: 0 };
  for (const e of list) { c[e.status] += 1; if (e.status === 'coming') c.people += 1 + (e.guests || 0); }
  if (tally) {
    tally.innerHTML = list.length
      ? `<span><b>${c.people}</b> coming</span><span><b>${c.maybe}</b> maybe</span><span><b>${c.cant}</b> can't</span>`
      : '';
  }

  const groups = RSVP_STATUSES.map((st) => {
    const people = list.filter((e) => e.status === st);
    if (!people.length) return '';
    const count = st === 'coming' ? plural(c.people, 'person', 'people') : String(people.length);
    return `<div class="who-group"><h3 class="sub-h">${esc(RSVP_LABELS[st])} <span>${count}</span></h3><ul class="who-list">${people.map(whoChip).join('')}</ul></div>`;
  }).join('');

  const going = list.filter((e) => e.status !== 'cant');
  const drivers = going.filter((e) => e.carpool === 'driving');
  const riders = going.filter((e) => e.carpool === 'need-ride');
  const seats = drivers.reduce((n, e) => n + (e.seats || 0), 0);
  const carpool = drivers.length || riders.length
    ? `<p class="carpool-sum">${I.car}<span>${drivers.length ? `${plural(drivers.length, 'driver', 'drivers')} with ${plural(seats, 'spare seat', 'spare seats')}` : 'No drivers yet'}${riders.length ? ` · ${plural(riders.length, 'person needs', 'people need')} a ride: ${riders.map((e) => esc(e.name)).join(', ')}` : ''}</span></p>`
    : '';

  let status = '';
  if (error && !at) status = `Couldn't load the list. ${error.code === 'network' ? 'No signal right now.' : esc(error.message)}`;
  else if (error) status = `No signal. Showing the list from ${ago(at)}.`;
  else if (at) status = `Updated ${ago(at)}`;
  if (pending) status += `${status ? ' · ' : ''}Your reply sends when you have signal.`;

  box.innerHTML = (list.length ? groups + carpool : at ? '<p class="muted">No replies yet. Be the first!</p>' : '')
    + (status ? `<p class="fine">${status}</p>` : at ? '' : '<p class="muted">Loading who\'s coming…</p>');

  // Fill the form with this phone's reply once it's known, unless they've started editing.
  const form = $('#view-detail [data-rsvp-form]');
  const mine = list.find((e) => e.mine);
  if (form && form.dataset.dirty !== 'true' && mine) setFormReply(form, mine);
  if (form) {
    $('[data-rsvp-remove]', form).hidden = !mine;
    const send = $('[data-rsvp-send]', form);
    if (!send.disabled) send.textContent = mine ? 'Update my reply' : 'Send my reply'; // not while "Sending…"
  }
}

function setPressed(form, attr, value) {
  $$(`[${attr}]`, form).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value)));
}

function setFormReply(form, r) {
  const name = $('[data-rsvp-name]', form);
  if (name && !name.value) name.value = r.name;
  setPressed(form, 'data-rsvp-pick', r.status);
  setPressed(form, 'data-rsvp-carpool', r.carpool || '');
  $('[data-stepper="guests"] output', form).textContent = String(r.guests || 0);
  if (r.seats) $('[data-stepper="seats"] output', form).textContent = String(r.seats);
  syncForm(form);
}

// Show the extras only when they apply
function syncForm(form) {
  const status = $('[data-rsvp-pick][aria-pressed="true"]', form)?.dataset.rsvpPick || 'coming';
  const carpool = $('[data-rsvp-carpool][aria-pressed="true"]', form)?.dataset.rsvpCarpool || '';
  $('[data-rsvp-extras]', form).hidden = status === 'cant';
  $('[data-seats]', form).hidden = carpool !== 'driving';
}

function readForm(form) {
  const status = $('[data-rsvp-pick][aria-pressed="true"]', form)?.dataset.rsvpPick || 'coming';
  const going = status !== 'cant';
  const carpool = going ? $('[data-rsvp-carpool][aria-pressed="true"]', form)?.dataset.rsvpCarpool || '' : '';
  return {
    name: $('[data-rsvp-name]', form).value.replace(/\s+/g, ' ').trim(),
    status,
    guests: going ? Number($('[data-stepper="guests"] output', form).textContent) : 0,
    carpool,
    seats: carpool === 'driving' ? Number($('[data-stepper="seats"] output', form).textContent) : 0,
  };
}

const replySummary = (r) => [
  RSVP_LABELS[r.status],
  r.guests ? `+${r.guests}` : '',
  r.carpool === 'driving' ? `driving${r.seats ? `, ${plural(r.seats, 'seat', 'seats')}` : ''}` : r.carpool === 'need-ride' ? 'needs a ride' : '',
].filter(Boolean).join(' · ');

const savedToast = (r) => ({
  coming: `You're in${r.guests ? ` (+${r.guests})` : ''}! Everyone can see it now.`,
  maybe: 'Saved as a maybe. Everyone can see it now.',
  cant: "Saved: can't make it. Thanks for letting everyone know.",
})[r.status];

async function sendReply(form, { claim = false } = {}) {
  const hikeId = form.dataset.rsvpForm;
  const reply = readForm(form);
  const nameInput = $('[data-rsvp-name]', form);
  if (!reply.name) {
    toast('Add your name first');
    nameInput.focus();
    return;
  }
  store.set('fh:name', reply.name);
  const btn = $('[data-rsvp-send]', form);
  const claimBox = $('[data-rsvp-claim]', form);
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await setRsvp(hikeId, reply, { claim });
    claimBox.hidden = true;
    Object.assign(form.dataset, { dirty: 'false', statusTouched: 'false', extrasTouched: 'false' });
    toast(res.queued ? "No signal. Your reply will send when you're back online." : savedToast(reply));
  } catch (err) {
    if (err.code === 'name_taken') {
      // Same name from another phone: probably them on a second device, or a friend with the same name.
      const ex = err.data.existing || { name: err.data.name };
      claimBox.dataset.existing = JSON.stringify(ex);
      claimBox.innerHTML = `<p><b>${esc(ex.name)}</b> already replied from another phone${ex.status ? ` (${esc(replySummary(ex))})` : ''}. Is that you?</p>
        <div class="btn-row"><button class="btn btn-secondary" type="button" data-rsvp-claim-yes>Yes, that's me</button><button class="btn btn-secondary" type="button" data-rsvp-claim-no>No, I'm someone else</button></div>`;
      claimBox.hidden = false;
      claimBox.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    } else if (err.code === 'hike_over') {
      toast('This hike is over, so replies are closed.');
    } else {
      toast(err.message || "Couldn't save your reply.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = myReply(hikeId) ? 'Update my reply' : 'Send my reply';
  }
}

function startRsvp(h) {
  stopRsvp();
  if (!isRsvpLive()) return;
  rsvpUnsub = subscribeRsvps(h.id, (state) => renderRsvpList(state), (err, state) => renderRsvpList(state, err));
}

function stopRsvp() {
  if (rsvpUnsub) { try { rsvpUnsub(); } catch { /* already closed */ } }
  rsvpUnsub = null;
}

// Keep the lists (and the card counts) fresh: at start, when the phone comes
// back online, and when the app returns to the foreground.
function startRsvpSync() {
  if (!isRsvpLive()) return;
  onRsvpChange(fillGoing);
  onRsvpProblem(({ hikeId, error }) => {
    const h = hikeById(hikeId);
    const why = error.code === 'name_taken' ? `${error.data.name} already replied. Open the hike to confirm it's you.`
      : error.code === 'hike_over' ? 'the hike is over.' : error.message;
    toast(`Your reply for ${h ? h.dateShort : 'a hike'} wasn't sent: ${why}`);
  });
  let last = 0;
  const sync = () => {
    if (document.hidden || Date.now() - last < 20_000) return;
    last = Date.now();
    refreshAll().catch(() => { /* no signal: the saved lists stay on screen */ });
  };
  sync();
  window.addEventListener('online', () => { last = 0; sync(); });
  document.addEventListener('visibilitychange', sync);
}

// "7 coming" on each hike card
function fillGoing() {
  if (!isRsvpLive()) return;
  $$('[data-going]').forEach((el) => {
    const { people } = countsFor(el.dataset.going);
    el.hidden = !people;
    $('span', el).textContent = `${people} coming`;
  });
}
function replyText(h, name, status) {
  const verb = status === 'maybe' ? "I'm a maybe" : status === 'cant' ? "I can't make it" : "I'm in";
  return `🍂 Hi everyone, this is ${name} — ${verb} for ${h.dateShort} at ${h.park}! Meet ${h.meet.time}${h.meet.place ? ` at ${h.meet.place}` : ''}.`;
}

async function loadWeather(h) {
  const w = await getWeather(h.id);
  const box = $('#view-detail [data-weather]');
  if (!box || $('#view-detail').dataset.hike !== h.id) return;
  if (!w) {
    // Too far ahead for the forecast, or no signal
    box.innerHTML = `<p class="weather-none">${I.clock}<span>No forecast yet. It shows up here about a week before the hike, when you have signal.</span></p>`;
    return;
  }
  const { desc, icon } = describeWeather(w.code);
  const rain = w.rain > 0 ? ` · ${w.rain.toFixed(1)} mm rain` : '';
  box.innerHTML = `
    <div class="weather">
      <span class="weather-icon" aria-hidden="true">${icon}</span>
      <div class="weather-text">
        <span class="weather-k">Forecast for ${esc(h.dateShort)}</span>
        <b>${esc(desc)}</b>
        <span>${w.low.toFixed(0)}–${w.high.toFixed(0)}°C${rain}</span>
      </div>
    </div>`;
}

function kidsRow(h) {
  if (!KIDS_LABELS[h.kids]) return '';
  const t = easiestTrail(h);
  const tip = h.kids === 'no' ? '' : ` With kids, try the ${t.name}${t.length ? ` (${t.length})` : ''}.`;
  return `<li class="amen">${I.users}<div><b>Kids</b><span>${esc(KIDS_LABELS[h.kids] + '.' + tip + (h.kidsNote ? ' ' + h.kidsNote : ''))}</span></div></li>`;
}

function renderDetail(h) {
  const v = $('#view-detail');
  const washroomRow = h.noWashrooms
    ? `<li class="amen amen-warn">${I.wc}<div><b>Washrooms</b><span>${esc(h.washrooms)}</span></div></li>`
    : `<li class="amen">${I.wc}<div><b>Washrooms</b><span>${h.washrooms ? esc(h.washrooms) : 'Not listed in the plan'}</span></div></li>`;
  const road = h.alerts.find((a) => a.kind === 'road');

  v.dataset.hike = h.id;
  // Start fetching weather in the background
  if (!document.hidden) loadWeather(h);

  v.innerHTML = `
    <div class="navbar${h.photo && 'IntersectionObserver' in window ? ' clear' : ''}">
      <button class="nav-back" type="button" data-back>${I.chevL}<span>Hikes</span></button>
      <span class="nav-title">${esc(h.shortName)}</span>
      <button class="nav-action" type="button" data-copy-hike="${h.id}" aria-label="Copy invite">${I.share}</button>
    </div>
    <header class="hero hero-${h.accent}${h.photo ? ' has-photo' : ''}">
      ${h.photo ? `<img class="hero-photo" src="${esc(h.photo.src)}" alt="${esc(h.photo.alt)}" decoding="async">` : heroArt(h)}
      <p class="hero-date">${esc(h.dateLong)}</p>
      <h1 class="hero-title">${esc(h.park)}</h1>
      <p class="hero-area">${esc(h.area)}</p>
      <div class="hero-badges">${levelBadges(h)}${kidsTag(h)}</div>
    </header>

    <div class="detail-body">
      <div class="facts">
        <div class="fact">${I.clock}<span class="fact-k">Meet</span><span class="fact-v">${esc(h.meet.time)}</span></div>
        <div class="fact">${I.car}<span class="fact-k">Drive</span><span class="fact-v">${esc(h.drive.short)}</span></div>
        <div class="fact">${I.ticket}<span class="fact-k">Fee</span><span class="fact-v">${esc(h.fee.amount).replace('/', '/<wbr>')}</span></div>
      </div>

      ${alertsHTML(h)}

      <section class="block" data-weather aria-live="polite">
        <p class="muted">Loading weather…</p>
      </section>

      <section class="block">
        <h2>Meeting</h2>
        <p class="lead">Meet <b>${esc(h.meet.time)}</b>${h.meet.place ? ` at ${esc(h.meet.place)}` : ''}.</p>
        ${h.meet.note ? `<p>${esc(h.meet.note)}</p>` : ''}
        ${h.meet.place ? '' : `<p class="muted">The plan doesn't name a meeting spot inside the park. Ask ${esc(APP.askPerson)}.</p>`}
        ${h.meet.address ? `<a class="btn btn-secondary" href="${esc(mapsUrl(h.maps))}" target="_blank" rel="noopener">${I.pin}<span>${esc(h.meet.address)}</span></a><p class="fine">Opens the meeting spot in Google Maps</p>` : ''}
      </section>

      <section class="block block-rsvp" id="rsvp">
        <h2>Who's coming</h2>
        ${rsvpSectionHTML(h)}
      </section>

      <section class="block">
        <h2>Trails</h2>
        <ul class="trail-list">${h.trails.map(trailRow).join('')}</ul>
      </section>

      <section class="block block-fall">
        <h2>Why it's beautiful in fall</h2>
        <p class="lead">${esc(h.fallLine)}</p>
        <ul class="tags">${h.highlights.map((x) => `<li>${I.leaf}${esc(x)}</li>`).join('')}</ul>
      </section>

      <section class="block">
        <h2>Fees and booking</h2>
        <p class="lead"><b>${esc(h.fee.amount)}</b></p>
        <p>${esc(h.fee.note)}</p>
        ${h.booking ? `<a class="btn btn-primary" href="${esc(h.booking.url)}" target="_blank" rel="noopener">${I.ext}<span>${esc(h.booking.label)}</span></a><p class="fine">${esc(h.booking.host)}</p>` : ''}
      </section>

      <section class="block">
        <h2>Getting there</h2>
        <p class="lead">Drive: <b>${esc(h.drive.text)}</b></p>
        ${road ? `<div class="alert alert-road inline">${I.route}<div><b>${esc(road.title)}</b><span>${esc(road.text)}</span></div></div>` : ''}
        <a class="btn btn-secondary" href="${esc(mapsUrl(h.maps))}" target="_blank" rel="noopener">${I.pin}<span>Directions in Google Maps</span></a>
      </section>

      <section class="block">
        <h2>At the park</h2>
        <ul class="amenities">
          ${washroomRow}
          ${kidsRow(h)}
          <li class="amen">${I.paw}<div><b>Dogs</b><span>${h.dogs ? esc(h.dogs) : 'Not listed in the plan'}</span></div></li>
          ${h.picnic ? `<li class="amen">${I.table}<div><b>Picnic</b><span>${esc(h.picnic)}</span></div></li>` : ''}
        </ul>
      </section>

      <section class="block">
        <h2>What to bring</h2>
        ${checklistHTML(h)}
      </section>

      <section class="block">
        <h2>Backup plan</h2>
        <p class="lead"><b>${esc(h.backup.name)}</b></p>
        ${h.fallbackTrailheads ? `<p>If ${esc(h.shortName)} is too busy, fallback trailheads: ${esc(h.fallbackTrailheads.join(', '))}.</p>` : ''}
        <a class="btn btn-secondary" href="${esc(mapsUrl(h.backup.maps))}" target="_blank" rel="noopener">${I.swap}<span>Directions to ${esc(h.backup.name)}</span></a>
      </section>

      ${h.photo ? `<p class="photo-credit">${photoCredit(h.photo)}</p>` : ''}
    </div>`;

  // Show the park name in the nav bar once the big title scrolls away
  const title = $('.hero-title', v);
  const navTitle = $('.nav-title', v);
  const navbar = $('.navbar', v);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      navTitle.classList.toggle('show', !e.isIntersecting);
      if (h.photo) navbar.classList.toggle('clear', e.isIntersecting);
    }, {
      root: v,
      rootMargin: '-60px 0px 0px 0px',
    }).observe(title);
  }
}

// ═════════════════════════════════════════════════════════════
// ASK TAB
// ═════════════════════════════════════════════════════════════
// Ask and Share headers: a photo band like the home screen
function barHTML(title, photo) {
  return `<header class="bar${photo ? ' has-photo' : ''}">
    ${photo ? `<img class="bar-photo" src="${esc(photo.src)}" alt="" decoding="async">` : ''}
    <p class="bar-eyebrow">${esc(APP.name)}</p>
    <h1 class="bar-title">${esc(title)}</h1>
  </header>`;
}

function renderAsk() {
  $('#view-ask').innerHTML = `
    ${barHTML('Ask', APP.photo)}
    <div class="chat" id="chat" aria-live="polite">
      <div class="welcome">
        <span class="welcome-icon" aria-hidden="true">${I.leaf}</span>
        <h2 class="welcome-h">Questions about the hikes?</h2>
        <p>Ask about meeting times, fees and booking, dogs, difficulty, drive times, washrooms or what to bring.</p>
        <p class="msg-fine">Answers come from the hike plan and work offline.</p>
        <p class="welcome-try">Try asking</p>
        <div class="welcome-qs">${SUGGESTIONS.slice(0, 4).map((s) => `<button class="chip-q" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>
    </div>
    <div class="chips" role="list">${SUGGESTIONS.map((s) => `<button class="chip-q" type="button" role="listitem" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form class="composer" id="ask-form" autocomplete="off">
      <label for="ask-input" class="sr-only">Your question</label>
      <input id="ask-input" name="q" type="text" inputmode="text" enterkeyhint="send" maxlength="300" placeholder="e.g. Can I bring my dog on Oct 10?">
      <button class="send" type="submit" aria-label="Send">${I.send}</button>
    </form>`;
}

function addMsg(kind, content, { html = false } = {}) {
  const chat = $('#chat');
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (html) el.innerHTML = content;
  else {
    const p = document.createElement('p');
    p.textContent = content;
    el.appendChild(p);
  }
  chat.appendChild(el);
  requestAnimationFrame(() => el.scrollIntoView({ block: 'end', behavior: reduceMotion() ? 'auto' : 'smooth' }));
  return el;
}

// Step 3: a question nobody could answer goes to the organizer. The asker sends
// it through the phone's share menu (or it's copied), so the organizer can reply.
function addSendButton(el, q) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ans-link';
  b.dataset.sendQuestion = q;
  b.textContent = `Send to ${APP.askPerson}`;
  el.appendChild(b);
}

async function sendQuestion(q) {
  const text = `Question for ${APP.askPerson} about the fall hikes: ${q}`;
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // user closed the share menu
    }
  }
  const ok = await copyText(text);
  toast(ok ? `Copied. Paste it to ${APP.askPerson} or the group chat.` : 'Copy failed. Long-press your question to copy it.');
}

// Three steps: 1. offline answers from the plan, 2. live AI (answers only from
// the plan), 3. anything still unanswered goes to the organizer.
async function ask(question) {
  const q = question.trim();
  if (!q) return;
  $('#view-ask').classList.add('asked'); // the suggestion row replaces the welcome list
  addMsg('me', q);
  const res = answer(q);
  if (res.matched) {
    const el = addMsg('bot', res.html, { html: true });
    if (res.unsure) addSendButton(el, q);
    return;
  }
  // PHASE 2 hook: only runs when CONFIG.aiEndpoint is set (see js/ask.js → askLiveAI).
  if (!isLiveAIOn()) {
    addSendButton(addMsg('bot', DONT_KNOW), q);
    return;
  }
  const typing = addMsg('bot typing', '<span></span><span></span><span></span>', { html: true });
  const ai = await askLiveAI(q);
  typing.remove();
  if (ai?.answer) {
    const el = addMsg('bot', ai.answer);
    el.insertAdjacentHTML('beforeend', '<p class="msg-fine">Live answer, from the hike plan</p>');
    return;
  }
  const reply = ai?.offTopic ? OFF_TOPIC_REPLY : ai?.forwarded ? FORWARDED : DONT_KNOW;
  addSendButton(addMsg('bot', reply), q);
}

// ═════════════════════════════════════════════════════════════
// SHARE TAB + INSTALL INSTRUCTIONS
// ═════════════════════════════════════════════════════════════
const IOS_STEPS_NEW = [
  `Open the app link in <b>Safari</b>.`,
  `Tap <span class="glyph">${I.moreH}</span> next to the address bar, then tap <b>Share</b>.`,
  `Scroll down and tap <b>Add to Home Screen</b>. If it isn't listed, tap <b>More</b> first.`,
  `Keep <b>Open as Web App</b> switched on, then tap <b>Add</b>.`,
];
const IOS_STEPS_OLD = [
  `Open the app link in <b>Safari</b>.`,
  `Tap <span class="glyph">${I.iosShare}</span> <b>Share</b> in the toolbar.`,
  `Scroll down and tap <b>Add to Home Screen</b>.`,
  `Tap <b>Add</b>.`,
];
const ANDROID_STEPS = [
  `Open the app link in <b>Chrome</b>.`,
  `Tap <span class="glyph">${I.moreV}</span> in the top-right corner.`,
  `Tap <b>Install app</b>. If you see <b>Add to Home screen</b> instead, tap it, then choose <b>Install</b>.`,
  `Tap <b>Install</b> to confirm. The app appears on your home screen.`,
];
const stepsHTML = (steps) => `<ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;

function renderShare() {
  const photo = HIKES[0]?.photo;
  $('#view-share').innerHTML = `
    ${barHTML('Share', photo)}
    <div class="pad">
      <section class="block">
        <h2>Invite friends</h2>
        <p class="muted">Copy a ready-to-send message for any Saturday and paste it into your group chat.</p>
        <ul class="invites">
          ${HIKES.map((h) => `
          <li class="invite">
            <div class="invite-head">
              <span class="blaze blaze-sm blaze-${h.level.toLowerCase()}" aria-hidden="true"></span>
              <div class="invite-name"><b>${esc(h.dateShort)}</b><span>${esc(h.shortName)}</span></div>
              <button class="btn btn-copy" type="button" data-copy-hike="${h.id}">${I.copy}<span>Copy invite</span></button>
            </div>
            <details class="preview"><summary>Preview message</summary><pre>${esc(inviteText(h))}</pre></details>
          </li>`).join('')}
        </ul>
        <button class="btn btn-secondary" type="button" data-copy-season>${I.copy}<span>Copy all five dates</span></button>
      </section>

      <section class="block">
        <h2>App link</h2>
        <p class="linkbox">${esc(appUrl())}</p>
        <div class="btn-row">
          <button class="btn btn-secondary" type="button" data-copy-link>${I.link}<span>Copy link</span></button>
          ${navigator.share ? `<button class="btn btn-secondary" type="button" data-native-share>${I.share}<span>Share…</span></button>` : ''}
        </div>
      </section>

      <section class="block">
        <h2>Install on your phone</h2>
        <div class="install-install" ${deferredInstall ? '' : 'hidden'}>
          <button class="btn btn-primary" type="button" data-install>${I.download}<span>Install Fall Hike App</span></button>
        </div>
        <h3 class="sub-h">iPhone, iOS 26 or later</h3>
        ${stepsHTML(IOS_STEPS_NEW)}
        <h3 class="sub-h">iPhone, iOS 18 or earlier</h3>
        ${stepsHTML(IOS_STEPS_OLD)}
        <h3 class="sub-h">Android, Chrome</h3>
        ${stepsHTML(ANDROID_STEPS)}
        <p class="fine">Once installed, the app opens full screen and keeps working without signal.</p>
      </section>
      ${photo ? `<p class="photo-credit">${photoCredit(photo, 'Top photo')}</p>` : ''}
    </div>`;
}

// ── Install sheet ───────────────────────────────────────────
function installSheetBody() {
  if (inAppBrowser) {
    return `<p class="sheet-note">You're in an in-app browser. Open this link in ${isIOS ? 'Safari' : 'Chrome'} first: tap the menu and choose <b>Open in browser</b>.</p>`;
  }
  if (isIOS) {
    const note = iosNotSafari ? `<p class="sheet-note">For the smoothest install, open this link in <b>Safari</b>.</p>` : '';
    if (iosMajor && iosMajor >= 26) return note + stepsHTML(IOS_STEPS_NEW.slice(1));
    if (iosMajor && iosMajor < 26) return note + stepsHTML(IOS_STEPS_OLD.slice(1));
    return note + `<h3 class="sub-h">iOS 26 or later</h3>${stepsHTML(IOS_STEPS_NEW.slice(1))}<h3 class="sub-h">iOS 18 or earlier</h3>${stepsHTML(IOS_STEPS_OLD.slice(1))}`;
  }
  if (isAndroid) {
    return deferredInstall
      ? `<button class="btn btn-primary btn-big" type="button" data-install>${I.download}<span>Install Fall Hike App</span></button>`
      : stepsHTML(ANDROID_STEPS.slice(1));
  }
  return `<p class="sheet-note">Open this link on your phone to install it. Instructions for iPhone and Android are on the Share tab.</p>`;
}

function openInstallSheet() {
  const s = $('#install-sheet');
  s.innerHTML = `
    <div class="sheet-backdrop" data-close-install></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <img class="sheet-icon" src="icons/icon-192.png" width="72" height="72" alt="">
      <h2 id="install-title">Put Fall Hike App on your home screen</h2>
      <p class="sheet-sub">It opens full screen like any other app and keeps working without signal once it's loaded.</p>
      ${installSheetBody()}
      <button class="btn btn-text" type="button" data-close-install>Continue in browser</button>
    </div>`;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
  $('.sheet h2', s).setAttribute('tabindex', '-1');
  $('.sheet h2', s).focus({ preventScroll: true });
}

function closeInstallSheet() {
  const s = $('#install-sheet');
  store.set('fh:install-dismissed', true);
  s.classList.remove('open');
  setTimeout(() => { s.hidden = true; s.innerHTML = ''; }, reduceMotion() ? 0 : 260);
}

async function runInstallPrompt() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  $$('.install-install').forEach((el) => (el.hidden = true));
  if (outcome === 'accepted') closeInstallSheet();
}

// ═════════════════════════════════════════════════════════════
// NAVIGATION (hash routes: #/  #/hike/:id  #/ask  #/share)
// ═════════════════════════════════════════════════════════════
let currentTab = 'hikes';
let detailOpen = false;
let pushedDetail = false;

function showTab(tab) {
  currentTab = tab;
  for (const t of ['hikes', 'ask', 'share']) {
    $(`#view-${t}`).hidden = t !== tab;
    const btn = $(`.tab[data-tab="${t}"]`);
    btn.classList.toggle('active', t === tab);
    btn.setAttribute('aria-current', t === tab ? 'page' : 'false');
  }
  if (tab === 'hikes') tickSign();
}

function openDetail(h, animate) {
  const v = $('#view-detail');
  if (!detailOpen || v.dataset.hike !== h.id) {
    renderDetail(h);
    v.scrollTop = 0;
    startRsvp(h);
  }
  v.hidden = false;
  v.classList.remove('leaving', 'dragging');
  v.style.transform = '';
  if (animate && !reduceMotion()) {
    v.classList.remove('entering');
    void v.offsetWidth;
    v.classList.add('entering');
  }
  $('#view-hikes').classList.add('behind');
  detailOpen = true;
  document.title = `${h.shortName}: Fall Hike App`;
}

function closeDetail(animate) {
  if (!detailOpen) return;
  const v = $('#view-detail');
  detailOpen = false;
  stopRsvp();
  $('#view-hikes').classList.remove('behind');
  document.title = 'Fall Hike App';
  if (animate && !reduceMotion()) {
    v.classList.remove('entering', 'dragging');
    v.classList.add('leaving');
    v.style.transform = '';
    setTimeout(() => { if (!detailOpen) { v.hidden = true; v.classList.remove('leaving'); } }, 280);
  } else {
    v.hidden = true;
  }
}

function route(animate = false) {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/hike\/([\w-]+)/);
  const h = m && hikeById(m[1]);
  if (h) {
    showTab('hikes');
    openDetail(h, animate);
    if (/\/rsvp$/.test(hash)) {
      requestAnimationFrame(() => $('#rsvp')?.scrollIntoView({ block: 'start', behavior: animate && !reduceMotion() ? 'smooth' : 'auto' }));
    }
    return;
  }
  closeDetail(animate);
  showTab(hash.startsWith('#/ask') ? 'ask' : hash.startsWith('#/share') ? 'share' : 'hikes');
}

function goBack() {
  if (pushedDetail) {
    pushedDetail = false;
    history.back();
  } else {
    location.replace('#/');
  }
}

// Edge-swipe back on the detail screen (standalone iOS apps have no browser swipe-back).
function enableSwipeBack() {
  const v = $('#view-detail');
  let startX = null, startY = 0, dx = 0, tracking = false;
  v.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t.clientX > 28) return;
    startX = t.clientX; startY = t.clientY; dx = 0; tracking = false;
  }, { passive: true });
  v.addEventListener('touchmove', (e) => {
    if (startX == null) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - startX);
    if (!tracking && Math.abs(t.clientY - startY) > Math.abs(dx)) { startX = null; return; }
    tracking = true;
    v.classList.add('dragging');
    v.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  v.addEventListener('touchend', () => {
    if (startX == null) return;
    startX = null;
    if (!tracking) return;
    v.classList.remove('dragging');
    if (dx > v.clientWidth * 0.3) goBack();
    else v.style.transform = '';
  });
}

// ═════════════════════════════════════════════════════════════
// EVENTS
// ═════════════════════════════════════════════════════════════
function flashCopied(btn, ok, doneLabel) {
  const label = $('span', btn);
  if (!label || !ok) return;
  const was = label.textContent;
  label.textContent = doneLabel;
  btn.classList.add('copied');
  setTimeout(() => { label.textContent = was; btn.classList.remove('copied'); }, 1600);
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('a, button, [data-close-install]');
  if (!t) return;

  if (t.matches('a[data-push]')) {
    e.preventDefault();
    pushedDetail = true;
    location.hash = t.getAttribute('href');
    return;
  }
  if (t.matches('a.ans-link-soft')) {
    e.preventDefault();
    pushedDetail = true; // back returns to the Ask chat
    location.hash = t.getAttribute('href');
    return;
  }
  if (t.matches('.tab')) {
    e.preventDefault();
    const tab = t.dataset.tab;
    if (tab === currentTab && tab === 'hikes' && detailOpen) return goBack();
    if (tab === currentTab) {
      $(`#view-${tab}`).scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
      return;
    }
    pushedDetail = false;
    location.replace(tab === 'hikes' ? '#/' : `#/${tab}`);
    return;
  }
  if (t.matches('[data-back]')) return goBack();

  if (t.matches('[data-copy-hike]')) {
    const h = hikeById(t.dataset.copyHike);
    const ok = await copyText(inviteText(h));
    toast(ok ? `Invite for ${h.dateShort} copied` : 'Copy failed. On the Share tab, long-press the preview to copy it.');
    flashCopied(t, ok, 'Copied');
    return;
  }
  if (t.matches('[data-copy-season]')) {
    const ok = await copyText(seasonText());
    toast(ok ? 'All five dates copied' : 'Copy failed. Try again.');
    flashCopied(t, ok, 'Copied');
    return;
  }
  if (t.matches('[data-copy-link]')) {
    const ok = await copyText(appUrl());
    toast(ok ? 'Link copied' : 'Copy failed. Long-press the link to copy it.');
    flashCopied(t, ok, 'Copied');
    return;
  }
  if (t.matches('[data-reply-status]')) {
    $$('#view-detail [data-reply-status]').forEach((b) => b.setAttribute('aria-pressed', b === t ? 'true' : 'false'));
    return;
  }
  if (t.matches('[data-copy-reply]')) {
    const h = hikeById(t.dataset.copyReply);
    const input = $('#view-detail [data-reply-name]');
    const name = (input?.value || '').trim().slice(0, 40);
    if (!name) { toast('Add your name first'); input?.focus(); return; }
    store.set('fh:name', name);
    const sel = $('#view-detail [data-reply-status][aria-pressed="true"]');
    const ok = await copyText(replyText(h, name, sel ? sel.dataset.replyStatus : 'coming'));
    toast(ok ? 'Reply copied — paste it in the group chat' : 'Copy failed. Long-press to copy manually.');
    flashCopied(t, ok, 'Copied');
    return;
  }
  if (t.matches('[data-native-share]')) {
    try {
      await navigator.share({ title: APP.name, text: 'Five Saturday hikes near Toronto, Oct 3 to Oct 31.', url: appUrl() });
    } catch { /* user cancelled */ }
    return;
  }
  if (t.matches('[data-suggest]')) {
    ask(t.dataset.suggest);
    return;
  }
  if (t.matches('[data-send-question]')) {
    sendQuestion(t.dataset.sendQuestion);
    return;
  }
  if (t.matches('[data-rsvp-pick], [data-rsvp-carpool]')) {
    const form = t.closest('[data-rsvp-form]');
    const attr = t.hasAttribute('data-rsvp-pick') ? 'data-rsvp-pick' : 'data-rsvp-carpool';
    setPressed(form, attr, t.getAttribute(attr));
    form.dataset.dirty = 'true';
    form.dataset[attr === 'data-rsvp-pick' ? 'statusTouched' : 'extrasTouched'] = 'true';
    syncForm(form);
    return;
  }
  if (t.matches('[data-step]')) {
    const box = t.closest('[data-stepper]');
    const out = $('output', box);
    const v = Math.min(Number(box.dataset.max), Math.max(Number(box.dataset.min), Number(out.textContent) + Number(t.dataset.step)));
    out.textContent = String(v);
    Object.assign(t.closest('[data-rsvp-form]').dataset, { dirty: 'true', extrasTouched: 'true' });
    return;
  }
  if (t.matches('[data-rsvp-claim-yes]')) {
    // Take over the earlier reply: keep its name and whatever this phone didn't change.
    const form = t.closest('[data-rsvp-form]');
    const ex = JSON.parse($('[data-rsvp-claim]', form).dataset.existing || '{}');
    const merged = { ...readForm(form), name: ex.name || readForm(form).name };
    if (form.dataset.statusTouched !== 'true' && ex.status) merged.status = ex.status;
    if (form.dataset.extrasTouched !== 'true') Object.assign(merged, { guests: ex.guests || 0, carpool: ex.carpool || '', seats: ex.seats || 0 });
    $('[data-rsvp-name]', form).value = merged.name;
    setFormReply(form, merged);
    sendReply(form, { claim: true });
    return;
  }
  if (t.matches('[data-rsvp-claim-no]')) {
    const form = t.closest('[data-rsvp-form]');
    $('[data-rsvp-claim]', form).hidden = true;
    const input = $('[data-rsvp-name]', form);
    toast('Add your last initial so people can tell you apart, e.g. "Alex K"');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  if (t.matches('[data-rsvp-remove]')) {
    const form = t.closest('[data-rsvp-form]');
    t.disabled = true;
    try {
      const res = await removeRsvp(form.dataset.rsvpForm);
      form.dataset.dirty = 'false';
      toast(res.queued ? 'No signal. Your reply will be removed when you are back online.' : 'Your reply is removed.');
    } catch (err) {
      toast(err.message || "Couldn't remove your reply.");
    } finally {
      t.disabled = false;
    }
    return;
  }
  if (t.matches('[data-open-install]')) return openInstallSheet();
  if (t.matches('[data-close-install]')) return closeInstallSheet();
  if (t.matches('[data-install]')) return runInstallPrompt();
});

// Tapping a suggestion or Send must not blur the question box: the blur would
// bring the tab bar back mid-tap, shift the layout and swallow the click.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.chip-q, .send') && document.activeElement?.id === 'ask-input') e.preventDefault();
});

document.addEventListener('input', (e) => {
  const form = e.target.closest?.('[data-rsvp-form]');
  if (form) form.dataset.dirty = 'true';
});

document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-check]');
  if (!cb) return;
  const id = $('#view-detail').dataset.hike;
  const checked = $$('input[data-check]', $('#view-detail')).filter((x) => x.checked).map((x) => x.dataset.check);
  store.set(`fh:check:${id}`, checked);
});

document.addEventListener('submit', (e) => {
  if (e.target.matches('[data-rsvp-form]')) {
    e.preventDefault();
    sendReply(e.target);
    return;
  }
  if (e.target.id !== 'ask-form') return;
  e.preventDefault();
  const input = $('#ask-input');
  const q = input.value;
  input.value = '';
  ask(q);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#install-sheet').hidden) closeInstallSheet();
});

// Keep the layout above the on-screen keyboard (iOS standalone doesn't resize for it)
const vv = window.visualViewport;
function fitViewport() {
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return;
  document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
  if (window.scrollY) window.scrollTo(0, 0);
}
if (vv) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
}
document.addEventListener('focusin', (e) => { if (e.target.id === 'ask-input') document.body.classList.add('kb'); });
// Wait for the tap that caused the blur to finish before the tab bar comes back.
document.addEventListener('focusout', (e) => {
  if (e.target.id !== 'ask-input') return;
  setTimeout(() => { if (document.activeElement?.id !== 'ask-input') document.body.classList.remove('kb'); }, 250);
});

window.addEventListener('hashchange', () => route(true));
window.addEventListener('offline', () => toast("You're offline. The hike plan still works."));
window.addEventListener('online', () => toast('Back online'));

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $$('.install-install').forEach((el) => (el.hidden = false));
  if (!$('#install-sheet').hidden) openInstallSheet();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (!$('#install-sheet').hidden) closeInstallSheet();
  toast('Installed. Open Fall Hike App from your home screen.');
});

// ═════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════
document.documentElement.classList.toggle('standalone', isStandalone());
renderHome();
renderAsk();
renderShare();
route(false);
enableSwipeBack();
fitViewport();
startRsvpSync();

setInterval(() => {
  if (document.hidden || currentTab !== 'hikes' || detailOpen) return;
  tickSign();
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickSign(); });

if (!isStandalone() && (isIOS || isAndroid) && !store.get('fh:install-dismissed', false)) {
  setTimeout(openInstallSheet, 700);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable */ });
  });
}
