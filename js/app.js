import { HIKES, BASICS, APP, KIDS_LABELS, hikeById } from './data.js';
import { esc, mapsUrl, meetMs, endMs, statusOf, nextHike, isHikeDay, countdownParts } from './lib.js';
import { answer, askLiveAI, isLiveAIOn, rideTarget, updateNoteFor, DONT_KNOW, FORWARDED, OFF_TOPIC_REPLY, SUGGESTIONS } from './ask.js';
import {
  isRsvpLive, setRsvp, removeRsvp, subscribeRsvps, refreshAll, countsFor, myReply, listFor,
  onRsvpChange, onRsvpProblem, RSVP_STATUSES, RSVP_LABELS, MAX_GUESTS, MAX_SEATS,
  requestSeat, cancelSeat, setRideAlerts, pushKey,
  allUpdates, updateAlertsOn, setUpdateAlerts, organizerKey, setOrganizerKey, clearOrganizerKey, organizerView, postUpdate, deleteUpdate,
} from './rsvp.js';
import { AREAS, findArea, areaKm, nearestFirst, normalizePhone, formatPhone, waLink } from './carpool.js';
import { I } from './icons.js';
import { getWeather, describeWeather } from './weather.js';
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
  // Longer messages stay up longer (2.2 to 6 seconds)
  toastTimer = setTimeout(() => t.classList.remove('show'), Math.min(6000, Math.max(2200, msg.length * 55)));
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
      ? ['Are you in? Tap "Coming" here:', `${appUrl()}#/hike/${h.id}/rsvp`, '🚗 Need a ride or have spare seats? Use Rides on the same page.']
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

// "New: Carpool" banner, until it's closed on this phone (or the season ends)
function carpoolBannerHTML(nx) {
  if (!isRsvpLive() || !nx || store.get('fh:carpool-banner', '') === 'closed') return '';
  return `<div class="carpool-banner" role="note">
    <span class="cb-icon" aria-hidden="true">${I.car}</span>
    <p class="cb-text"><b>New: Carpool.</b> Find a ride or offer seats for any hike.</p>
    <button class="cb-x" type="button" data-carpool-close aria-label="Hide this">${I.close}</button>
    <div class="cb-actions"><button class="cb-btn" type="button" data-carpool-how>How it works</button><button class="cb-btn" type="button" data-carpool-scout>${I.ask}<span>Ask Scout</span></button></div>
  </div>`;
}

function openCarpoolHow() {
  const nx = nextHike();
  openSheet('carpool', `
    <span class="sheet-badge" aria-hidden="true">${I.car}</span>
    <h2 id="sheet-title">How carpooling works</h2>
    <p class="sheet-sub">Drivers and riders find each other directly. Nothing goes through ${esc(APP.askPerson)}.</p>
    <ol class="steps">
      <li>Open a hike and reply <b>Coming</b>. Under Carpool, pick <b>I can drive</b> or <b>Need a ride</b>, and your area.</li>
      <li>Need a ride? Drivers from your area show first. Tap <b>Message</b> to WhatsApp them, or <b>Ride with</b> to save a seat.</li>
      <li>Driving? Your seats left count down as people join. Turn on 🔔 to get a notification when someone wants a ride.</li>
      <li>Sort out pickup on WhatsApp. Plans changed? Tap <b>Cancel my seat</b> any time.</li>
    </ol>
    <p class="fine">Sharing your WhatsApp number is optional: only one of you needs to share one. Everything is deleted a week after each hike.</p>
    ${nx ? `<a class="btn btn-primary" href="#/hike/${nx.id}/rides" data-push>${I.car}<span>See rides for ${esc(nx.dateShort)}</span></a>` : ''}
    <button class="btn btn-text" type="button" data-close-sheet>Got it</button>`);
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
      ${organizerKey() ? `<a id="org-btn" class="glass-btn" href="#/organizer" title="Send an update" aria-label="Send an update">${I.megaphone}</a>` : ''}
      <p class="canopy-eyebrow">${esc(APP.name)}</p>
      <h1 class="large-title">${taglineHTML(APP.tagline || APP.name)}</h1>
      <p class="canopy-sub">${esc(APP.intro || 'Five Saturdays near Toronto, Oct 3 to Oct 31')}</p>
      <div class="updates-pin" data-updates-pin aria-live="polite" hidden></div>
      ${carpoolBannerHTML(nx)}
      <div class="my-rides" data-my-rides hidden></div>
      <a class="scout-cta" href="#/ask">${I.ask}<span><b>Got a question? Ask Scout.</b><small>Times, fees, parking, trails: it knows the whole plan.</small></span>${I.chevR}</a>
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
  fillMyRides();
  fillUpdates();
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

// ── Carpool fields: area, WhatsApp number, ride alerts (drivers and riders only) ──
const areaOptions = (value) => {
  const typed = value && !findArea(value);
  return `<option value="">Pick one</option>${AREAS.map((a) => `<option${(typed ? a.name === 'Other' : a.name === value) ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}`;
};

function rideFieldsHTML(mine, status, carpool) {
  const typed = mine?.area && !findArea(mine.area) ? mine.area : '';
  // Ticked by default for drivers, unticked for riders. The number always starts empty.
  const share = mine?.phone ? true : carpool === 'driving';
  return `
    <div class="ride-fields" data-ride-fields ${status !== 'cant' && carpool ? '' : 'hidden'}>
      <label class="field"><span>Your area</span><select data-rsvp-area>${areaOptions(mine?.area || '')}</select></label>
      <label class="field" data-area-other ${typed ? '' : 'hidden'}><span>Which area?</span><input type="text" maxlength="30" enterkeyhint="done" data-rsvp-area-other value="${esc(typed)}" placeholder="e.g. Leslieville"></label>
      <label class="check check-sm"><input type="checkbox" data-rsvp-share ${share ? 'checked' : ''}><span class="box">${I.check}</span><span class="check-label">Show my WhatsApp so people can message me</span></label>
      <label class="field" data-phone-row ${share ? '' : 'hidden'}><span>WhatsApp number</span><input type="tel" inputmode="tel" autocomplete="tel" maxlength="20" enterkeyhint="done" data-rsvp-phone value="${esc(mine?.phone ? formatPhone(mine.phone) : '')}" placeholder="416 555 0123"></label>
      <p class="fine" data-share-note>Optional. No logins here, so anyone with the app link can see your number when they tap Message. It's deleted a week after the hike.</p>
      <p class="fine" data-maybe-note hidden>Riders can save a seat with you once you pick Coming.</p>
      <div class="alerts-row" data-alerts-row hidden>
        <label class="check check-sm"><input type="checkbox" data-rsvp-alerts ${mine?.alerts ? 'checked' : ''}><span class="box">${I.check}</span><span class="check-label">🔔 Tell me when someone wants a ride</span></label>
        <p class="fine" data-alerts-note></p>
      </div>
    </div>`;
}

function rsvpFormHTML(h) {
  const mine = myReply(h.id);
  const status = mine?.status || 'coming';
  const carpool = mine?.carpool || '';
  const seg = (attr, value, label, on) => `<button type="button" class="seg-btn" ${attr}="${value}" aria-pressed="${on}">${label}</button>`;
  return `
    <form class="rsvp-form" data-rsvp-form="${h.id}" data-dirty="false" data-last-carpool="${carpool}" novalidate>
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
        ${rideFieldsHTML(mine, status, carpool)}
      </div>
      <div class="rsvp-claim" data-rsvp-claim hidden></div>
      <div class="rsvp-claim" data-rsvp-confirm hidden></div>
      <div class="updates-ask" data-updates-ask hidden></div>
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
const andList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

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
  if (e.carpool === 'need-ride') tags.push(e.ride ? `riding with ${e.ride}` : 'needs a ride');
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

  // One line about rides; the Rides section below has the details.
  const drivers = list.filter(isDriving);
  const waiting = list.filter(needsRide);
  const free = drivers.reduce((n, e) => n + (e.seatsLeft ?? e.seats ?? 0), 0);
  const carpool = drivers.length || waiting.length
    ? `<button class="carpool-sum" type="button" data-scroll-to="rides">${I.car}<span>${drivers.length ? `${plural(drivers.length, 'driver', 'drivers')}, ${plural(free, 'seat', 'seats')} left` : 'No drivers yet'}${waiting.length ? ` · ${plural(waiting.length, 'person needs', 'people need')} a ride` : ''}</span><span class="carpool-sum-cta">See rides${I.chevR}</span></button>`
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
    syncForm(form);
    // Replied before plan updates existed: ask once here too (no jump).
    if (mine && !mine.pending && mine.status !== 'cant' && $('[data-updates-ask]', form).hidden) askAboutUpdates(form, { scroll: false });
  }
  const h = hikeById($('#view-detail').dataset.hike);
  if (h) renderRides(h, list, at, error);
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
  if (r.area !== undefined) {
    const known = findArea(r.area);
    $('[data-rsvp-area]', form).value = r.area ? (known ? known.name : 'Other') : '';
    $('[data-rsvp-area-other]', form).value = r.area && !known ? r.area : '';
  }
  if (r.carpool) {
    $('[data-rsvp-share]', form).checked = Boolean(r.phone) || r.carpool === 'driving';
    $('[data-rsvp-phone]', form).value = r.phone ? formatPhone(r.phone) : '';
  }
  $('[data-rsvp-alerts]', form).checked = Boolean(r.alerts);
  form.dataset.lastCarpool = r.carpool || '';
  syncForm(form);
}

// Ride alerts: what this phone can do
function alertSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS && !isStandalone() ? 'ios-install' : 'unsupported';
  }
  return Notification.permission === 'denied' ? 'denied' : 'ok';
}
const ALERT_NOTES = {
  ok: "One notification when someone taps Ride with you. You'll only get ride requests and Summan's plan updates.",
  'ios-install': 'On iPhone, alerts work once the app is on your Home Screen (iOS 16.4 or later). <button class="link-btn" type="button" data-open-install>How to add it</button>',
  unsupported: "This browser can't show alerts. You'll still see ride requests here when you open the app.",
  denied: "Notifications are blocked for this app in your phone's settings. You'll still see ride requests here.",
};

// Show the extras only when they apply
function syncForm(form) {
  const status = $('[data-rsvp-pick][aria-pressed="true"]', form)?.dataset.rsvpPick || 'coming';
  const carpool = $('[data-rsvp-carpool][aria-pressed="true"]', form)?.dataset.rsvpCarpool || '';
  $('[data-rsvp-extras]', form).hidden = status === 'cant';
  $('[data-seats]', form).hidden = carpool !== 'driving';
  $('[data-ride-fields]', form).hidden = status === 'cant' || !carpool;
  $('[data-area-other]', form).hidden = $('[data-rsvp-area]', form).value !== 'Other';
  const share = $('[data-rsvp-share]', form);
  if (form.dataset.lastCarpool !== carpool) {
    // Switching between driving and riding: back to that choice's default, unless they've chosen.
    if (form.dataset.shareTouched !== 'true') share.checked = carpool === 'driving' || Boolean($('[data-rsvp-phone]', form).value.trim());
    form.dataset.lastCarpool = carpool;
  }
  $('[data-phone-row]', form).hidden = !share.checked;
  $('[data-maybe-note]', form).hidden = !(status === 'maybe' && carpool === 'driving');
  const row = $('[data-alerts-row]', form);
  row.hidden = !(status === 'coming' && carpool === 'driving' && pushKey());
  if (!row.hidden) {
    const support = alertSupport();
    const box = $('[data-rsvp-alerts]', form);
    box.disabled = support !== 'ok' && !box.checked;
    $('[data-alerts-note]', form).innerHTML = ALERT_NOTES[support];
  }
}

function readForm(form) {
  const status = $('[data-rsvp-pick][aria-pressed="true"]', form)?.dataset.rsvpPick || 'coming';
  const going = status !== 'cant';
  const carpool = going ? $('[data-rsvp-carpool][aria-pressed="true"]', form)?.dataset.rsvpCarpool || '' : '';
  const rides = Boolean(carpool);
  const picked = $('[data-rsvp-area]', form).value;
  const area = !rides ? '' : picked === 'Other' ? $('[data-rsvp-area-other]', form).value.replace(/\s+/g, ' ').trim() || 'Other' : picked;
  return {
    name: $('[data-rsvp-name]', form).value.replace(/\s+/g, ' ').trim(),
    status,
    guests: going ? Number($('[data-stepper="guests"] output', form).textContent) : 0,
    carpool,
    seats: carpool === 'driving' ? Number($('[data-stepper="seats"] output', form).textContent) : 0,
    area,
    phone: rides && $('[data-rsvp-share]', form).checked ? $('[data-rsvp-phone]', form).value.trim() : '',
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

// A reply change that would cost someone a seat: say so first.
function seatWarning(hikeId, next) {
  const { list } = listFor(hikeId);
  const me = list.find((e) => e.mine);
  if (!me) return '';
  const stillRider = next && next.status === 'coming' && next.carpool === 'need-ride';
  const stillDriver = next && next.status === 'coming' && next.carpool === 'driving';
  if (me.ride && !stillRider) return `This gives up your seat with ${me.ride}. Message ${me.ride} so they know.`;
  const riders = list.filter((e) => e.ride === me.name);
  if (isDriving(me) && riders.length && !stillDriver) {
    return `${andList(riders.map((r) => r.name))} ${riders.length === 1 ? 'has a seat' : 'have seats'} in your car and will lose ${riders.length === 1 ? 'it' : 'them'}. Message them first so they can find another ride.`;
  }
  return '';
}

function askToConfirm(form, text, action) {
  const box = $('[data-rsvp-confirm]', form);
  box.innerHTML = `<p>${esc(text)}</p><div class="btn-row"><button class="btn btn-secondary" type="button" data-rsvp-confirm-yes="${action}">${action === 'remove' ? 'Remove anyway' : 'Save anyway'}</button><button class="btn btn-secondary" type="button" data-rsvp-confirm-no>Keep it as it is</button></div>`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

async function sendReply(form, { claim = false, confirmed = false, keepPhone = false } = {}) {
  const hikeId = form.dataset.rsvpForm;
  const reply = readForm(form);
  if (keepPhone) delete reply.phone; // the Worker keeps the saved number
  const nameInput = $('[data-rsvp-name]', form);
  if (!reply.name) {
    toast('Add your name first');
    nameInput.focus();
    return;
  }
  if (reply.carpool && !reply.area) {
    toast(reply.carpool === 'driving' ? 'Pick your area so riders near you find you' : 'Pick your area so drivers near you find you');
    $('[data-rsvp-area]', form).focus();
    return;
  }
  if (reply.phone && normalizePhone(reply.phone) === null) {
    toast("That number doesn't look right. Use 10 digits, like 416 555 0123.");
    $('[data-rsvp-phone]', form).focus();
    return;
  }
  const warning = !confirmed && seatWarning(hikeId, reply);
  if (warning) return askToConfirm(form, warning, 'send');
  $('[data-rsvp-confirm]', form).hidden = true;
  store.set('fh:name', reply.name);
  if (reply.area) store.set('fh:area', reply.area);
  const btn = $('[data-rsvp-send]', form);
  const claimBox = $('[data-rsvp-claim]', form);
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await setRsvp(hikeId, reply, { claim });
    claimBox.hidden = true;
    Object.assign(form.dataset, { dirty: 'false', statusTouched: 'false', extrasTouched: 'false', shareTouched: 'false' });
    if (res.queued) toast("No signal. Your reply will send when you're back online.");
    else {
      toast(savedToast(reply));
      await syncRideAlerts(hikeId, form, reply);
      if (reply.status !== 'cant') askAboutUpdates(form);
    }
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

async function removeReply(form, btn, { confirmed = false } = {}) {
  const warning = !confirmed && seatWarning(form.dataset.rsvpForm, null);
  if (warning) return askToConfirm(form, warning, 'remove');
  btn.disabled = true;
  try {
    const res = await removeRsvp(form.dataset.rsvpForm);
    form.dataset.dirty = 'false';
    toast(res.queued ? 'No signal. Your reply will be removed when you are back online.' : 'Your reply is removed.');
  } catch (err) {
    toast(err.message || "Couldn't remove your reply.");
  } finally {
    btn.disabled = false;
  }
}

// ── Ride alerts (drivers): one push notification when someone taps Ride with ──
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const keyText = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pushSubscription() {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker not ready')), 8000)),
  ]);
  let sub = await reg.pushManager.getSubscription();
  const key = sub?.options?.applicationServerKey;
  if (sub && key && keyText(key) !== pushKey()) { await sub.unsubscribe(); sub = null; } // the app's key changed
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey()) });
}

// Ticking the box: ask for permission right away, while it still counts as the tap (Safari needs that).
async function askForAlerts(box) {
  const support = alertSupport();
  if (support !== 'ok') {
    box.checked = false;
    toast(support === 'ios-install' ? 'Add the app to your Home Screen first, then turn alerts on.' : support === 'denied' ? "Notifications are blocked in your phone's settings." : "This browser can't show alerts.");
    return;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    box.checked = false;
    toast("No alerts, then. You'll still see ride requests in the app.");
    syncForm(box.closest('[data-rsvp-form]'));
  }
}

// After the reply is saved: turn this hike's alerts on or off to match the box.
async function syncRideAlerts(hikeId, form, reply) {
  const box = $('[data-rsvp-alerts]', form);
  const want = box.checked && !$('[data-alerts-row]', form).hidden && reply.status === 'coming' && reply.carpool === 'driving';
  const on = Boolean(myReply(hikeId)?.alerts);
  if (want === on || (!want && !(reply.status === 'coming' && reply.carpool === 'driving'))) return; // the Worker already turned them off
  try {
    if (want) {
      await setRideAlerts(hikeId, await pushSubscription());
      toast("Saved. You'll get a notification when someone wants a ride.");
    } else {
      await setRideAlerts(hikeId, null);
    }
  } catch (err) {
    box.checked = on;
    toast(want ? `Your reply is saved, but alerts didn't turn on: ${err.message || 'try again'}` : "Couldn't turn alerts off. Try again.");
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
  onRsvpChange(fillMyRides);
  onRsvpChange(refreshRideCards);
  onRsvpChange(fillUpdates);
  onRsvpChange(fillHikeUpdates);
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

// ═════════════════════════════════════════════════════════════
// RIDES (carpool): drivers near you first, Message on WhatsApp, Ride with
// Everything comes from the live RSVP list. Numbers are only ever inside the
// Message links (and shown if WhatsApp doesn't open).
// ═════════════════════════════════════════════════════════════
const isDriving = (e) => e.status === 'coming' && e.carpool === 'driving';
const needsRide = (e) => e.status !== 'cant' && e.carpool === 'need-ride' && !e.ride;
const myArea = (me) => me?.area || store.get('fh:area', '');
const seatsText = (d) => (!d.seatsLeft ? 'Full' : d.seatsLeft === d.seats ? `${plural(d.seats, 'seat', 'seats')} free` : `${d.seatsLeft} of ${d.seats} seats left`);

// The WhatsApp message, already typed: who I am, which hike, and where I'm coming from.
function waText(h, kind, to, me) {
  const name = me?.name || store.get('fh:name', '');
  const hi = `Hi ${to}! ${name ? `I'm ${name} from` : 'I found you on'} the Fall Hike app 🍁`;
  const trip = `${h.shortName} on ${h.dateShort}`;
  const area = myArea(me);
  return {
    ask: `${hi} I'd like a seat to ${trip}.${area ? ` I'm in ${area}.` : ''} 🚗`,
    seat: `${hi} I saved a seat in your car to ${trip}.${area ? ` I'm in ${area}.` : ''} Where should we meet? 🚗`,
    offer: `${hi} I'm driving to ${trip}${area ? ` from ${area}` : ''} and have a seat for you. 🚗`,
    pickup: `${hi} You've got a seat in my car to ${trip}. Let's sort out pickup. 🚗`,
    hello: `${hi} I saw you need a ride to ${trip}. 🚗`,
  }[kind];
}

const msgBtn = (h, e, kind, me) => (e.phone
  ? `<a class="ride-btn ride-msg" href="${esc(waLink(e.phone, waText(h, kind, e.name, me)))}" target="_blank" rel="noopener" data-wa="${esc(e.phone)}">${I.chat}<span>Message ${esc(e.name)}</span></a>`
  : '');
const rideBtn = (h, d) =>
  `<button class="ride-btn ride-go" type="button" data-ride-with="${esc(d.name)}" data-hike="${h.id}">${I.car}<span>Ride with ${esc(d.name)}</span></button>`;
const areaTag = (e) => (e.area ? `<span class="ride-area">${esc(e.area)}</span>` : '');
// After Message was tapped: the number, in case WhatsApp didn't open
const shownNumbers = new Set();
const waFallback = (d) => `<p class="wa-fallback">WhatsApp didn't open? Text <a href="sms:+${esc(d)}">${esc(formatPhone(d))}</a> or <a href="tel:+${esc(d)}">call</a>.</p>`;
const fallbackFor = (e) => (e.phone && shownNumbers.has(e.phone) ? waFallback(e.phone) : '');

function driverCard(h, d, list, me, over) {
  const riders = list.filter((e) => e.ride === d.name);
  const full = !d.seatsLeft;
  const mineSeat = me?.ride === d.name;
  const canRide = !over && !full && !mineSeat && !(me && isDriving(me));
  // My own driver's buttons are in the "Your ride" box above.
  const actions = over || full || mineSeat ? '' : `${msgBtn(h, d, 'ask', me)}${canRide ? rideBtn(h, d) : ''}`;
  return `<li class="ride-card${full ? ' is-full' : ''}${mineSeat ? ' is-mine' : ''}">
    <div class="ride-head"><b>${esc(d.name)}</b>${areaTag(d)}<span class="ride-seats">${mineSeat ? 'Your ride · ' : ''}${esc(seatsText(d))}</span></div>
    ${riders.length ? `<p class="ride-sub">Riding: ${esc(andList(riders.map((r) => r.name + (r.guests ? ` +${r.guests}` : ''))))}</p>` : ''}
    ${actions ? `<div class="ride-actions">${actions}</div>${fallbackFor(d)}` : ''}
    ${!over && !full && !d.phone && !mineSeat ? '<p class="ride-sub">Keeps their number private</p>' : ''}
  </li>`;
}

function riderCard(h, r, me, over) {
  const need = r.guests ? `needs ${1 + r.guests} seats` : 'needs a ride';
  const kind = me && isDriving(me) ? 'offer' : 'hello';
  return `<li class="ride-card">
    <div class="ride-head"><b>${esc(r.name)}</b>${areaTag(r)}<span class="ride-seats">${r.status === 'maybe' ? 'Maybe · ' : ''}${need}</span></div>
    ${!over && r.phone ? `<div class="ride-actions">${msgBtn(h, r, kind, me)}</div>${fallbackFor(r)}` : ''}
  </li>`;
}

// This phone's own ride: the seat I hold, or my car and who's in it.
function myRideHTML(h, list, me, over) {
  if (!me) return '';
  let out = '';
  if (me.lostRide) {
    out += `<div class="my-ride my-ride-warn"><p><b>${esc(me.lostRide)} is no longer driving</b>, so your seat was released. Pick another driver below.</p>
      <div class="ride-actions"><button class="ride-btn" type="button" data-lost-ok="${h.id}">OK</button></div></div>`;
  }
  if (me.ride) {
    const d = list.find((e) => e.name === me.ride);
    const reach = !d?.phone && !me.phone
      ? `<p class="ride-warn">Neither of you shared a WhatsApp number, so ${esc(me.ride)} can't reach you. Add yours in your reply above.</p>`
      : !d?.phone ? `<p class="ride-sub">${esc(me.ride)} keeps their number private and can message you on WhatsApp.</p>` : '';
    out += `<div class="my-ride"><p class="my-ride-k">Your ride</p>
      <p><b>You're riding with ${esc(me.ride)}</b>${d?.area ? ` from ${esc(d.area)}` : ''}.${me.pending ? ' Your reply change sends when you have signal.' : ''}</p>${reach}
      <div class="ride-actions">${d ? msgBtn(h, d, 'seat', me) : ''}${over ? '' : `<button class="ride-btn ride-cancel" type="button" data-cancel-seat="${h.id}">Cancel my seat</button>`}</div>${d ? fallbackFor(d) : ''}</div>`;
  } else if (isDriving(me)) {
    const riders = list.filter((e) => e.ride === me.name);
    out += `<div class="my-ride"><p class="my-ride-k">Your car</p>
      <p><b>${esc(seatsText(me))}</b>${riders.length ? '' : '. No one has saved a seat yet.'}</p>
      ${riders.length ? `<ul class="ride-list">${riders.map((r) => `<li class="ride-card">
        <div class="ride-head"><b>${esc(r.name)}</b>${areaTag(r)}<span class="ride-seats">${r.guests ? `+${r.guests} · ` : ''}wants a ride</span></div>
        ${r.phone ? `<div class="ride-actions">${msgBtn(h, r, 'pickup', me)}</div>${fallbackFor(r)}`
          : `<p class="ride-sub">${me.phone ? `No number shared, so ${esc(r.name)} will message you.` : `Neither of you shared a number. Add yours in your reply above so ${esc(r.name)} can reach you.`}</p>`}
      </li>`).join('')}</ul>` : ''}
      ${me.alerts ? '<p class="fine">🔔 Ride alerts are on for this hike.</p>' : ''}</div>`;
  } else if (needsRide(me) && !over) {
    out += `<div class="my-ride"><p class="my-ride-k">Your ride</p><p>${me.status === 'maybe'
      ? 'You need a ride. Pick <b>Coming</b> in your reply to save a seat.'
      : 'You need a ride. Tap <b>Ride with</b> on a driver below, or wait for a driver to message you.'}${me.phone ? '' : ' Share your WhatsApp in your reply so drivers can offer you a seat.'}</p></div>`;
  }
  return out;
}

function ridesHTML(h, list) {
  const over = statusOf(h) === 'done';
  const me = list.find((e) => e.mine) || null;
  const area = myArea(me);
  const drivers = nearestFirst(list.filter((e) => isDriving(e) && !e.mine), area);
  const known = findArea(area)?.lat != null || (area && !findArea(area));
  const best = known ? drivers.filter((d) => areaKm(area, d.area) === 0) : [];
  const others = drivers.filter((d) => !best.includes(d));
  const waiting = list.filter((e) => needsRide(e) && !e.mine);
  const card = (d) => driverCard(h, d, list, me, over);
  let body = myRideHTML(h, list, me, over);
  if (best.length) body += `<h3 class="sub-h">Best match for you (${esc(area)})</h3><ul class="ride-list">${best.map(card).join('')}</ul>`;
  if (others.length) body += `<h3 class="sub-h">${best.length ? 'Other drivers' : 'Drivers'}${!best.length && area ? `, nearest to ${esc(area)} first` : ''}</h3><ul class="ride-list">${others.map(card).join('')}</ul>`;
  if (!drivers.length) {
    body += `<p class="muted">No drivers yet.${me && needsRide(me) ? " You're on the Need a ride list, so drivers can find you." : over ? '' : ' Pick <b>Need a ride</b> in your reply so drivers can find you, or <b>I can drive</b> to offer seats.'}</p>`;
  }
  if (waiting.length) body += `<h3 class="sub-h">Need a ride</h3><ul class="ride-list">${waiting.map((r) => riderCard(h, r, me, over)).join('')}</ul>`;
  if (!me && !over && drivers.length) body += '<p class="fine">To save a seat or offer one, reply <b>Coming</b> above and pick Need a ride or I can drive.</p>';
  return body;
}

function renderRides(h, list, at, error) {
  const box = $('#view-detail [data-rides]');
  if (!box) return;
  if (!at && !list.length) {
    if (error) box.innerHTML = `<p class="muted">Couldn't load rides. ${error.code === 'network' ? 'No signal right now.' : esc(error.message)}</p>`;
    return;
  }
  box.innerHTML = ridesHTML(h, list);
}

// Scout's rides card: drivers with free seats for one hike, nearest first.
function ridesCardHTML(h, area = '') {
  const { list, at } = listFor(h.id);
  const over = statusOf(h) === 'done';
  const me = list.find((e) => e.mine) || null;
  const from = area || myArea(me);
  const drivers = nearestFirst(list.filter((e) => isDriving(e) && !e.mine), from);
  const free = drivers.filter((d) => d.seatsLeft > 0);
  const fullCars = drivers.length - free.length;
  const card = (d) => driverCard(h, d, list, me, over);
  const short = h.dateShort.replace('Sat ', '');
  const chips = from ? '' : `<p>Where are you coming from? I'll show the nearest drivers first.</p>
    <div class="area-chips">${AREAS.filter((a) => a.lat != null).map((a) => `<button type="button" class="chip-q" data-area-pick="${esc(a.name)}" data-hike="${h.id}">${esc(a.name)}</button>`).join('')}</div>`;
  return `<div class="rides-card" data-rides-card="${h.id}" data-area="${esc(area)}">
    <p class="ans-hike">🚗 Rides to ${esc(h.shortName)}, ${esc(h.dateShort)}</p>
    ${chips}
    ${myRideHTML(h, list, me, over)}
    ${free.length
      ? `${from ? `<p class="msg-fine">Nearest to ${esc(from)} first</p>` : ''}<ul class="ride-list">${free.map(card).join('')}</ul>`
      : `<p>No drivers with free seats yet.${me && needsRide(me) ? " You're on the Need a ride list, so drivers can find you." : ' Tap Need a ride so drivers can find you.'}</p>
         ${me && needsRide(me) ? '' : `<a class="ans-link" href="#/hike/${h.id}/needride">Need a ride</a>`}`}
    ${fullCars ? `<p class="msg-fine">${plural(fullCars, 'more car is', 'more cars are')} full.</p>` : ''}
    ${at ? '' : '<p class="msg-fine">Loading the latest rides…</p>'}
    <a class="ans-link ans-link-soft" href="#/hike/${h.id}/rides">All rides for ${esc(short)}</a>
  </div>`;
}

// In Scout: the live rides card, and a fresh list in the background
function ridesCardFor(target) {
  const h = target && isRsvpLive() && hikeById(target.hikeId);
  if (!h) return '';
  if (target.area && !myReply(h.id)?.area) store.set('fh:area', target.area); // "a ride from Scarborough"
  refreshAll().catch(() => { /* no signal: the card shows the saved list */ });
  return ridesCardHTML(h, target.area);
}

function refreshRideCards() {
  $$('[data-rides-card]').forEach((el) => {
    const h = hikeById(el.dataset.ridesCard);
    if (h) el.outerHTML = ridesCardHTML(h, el.dataset.area);
  });
}

// Ride with: one tap when the reply already says Coming + Need a ride and someone
// can message; otherwise a short sheet asks for what's missing.
async function rideWith(hikeId, driverName) {
  const h = hikeById(hikeId);
  const { list } = listFor(hikeId);
  const me = list.find((e) => e.mine) || null;
  const driver = list.find((e) => e.name === driverName);
  if (!h || !driver) return toast('That driver isn\'t on the list anymore.');
  if (!navigator.onLine) return toast('You need signal to save a seat.');
  const ready = me && !me.pending && me.status === 'coming' && me.carpool === 'need-ride' && me.area;
  if (ready && (me.phone || driver.phone) && !me.ride) return saveSeat(h, driver);
  openRideSheet(h, driver, me);
}

async function saveSeat(h, driver) {
  try {
    const res = await requestSeat(h.id, driver.name);
    const me = myReply(h.id);
    toast(driver.phone ? `Seat saved with ${driver.name}. Now message ${driver.name} to sort out pickup.`
      : !me?.phone ? `Seat saved, but ${driver.name} can't reach you without a number. Add yours to your reply.`
        : res.driverAlerted ? `Seat saved. ${driver.name} just got a notification and can message you.`
          : `Seat saved. ${driver.name} will see it in the app and can message you.`);
    return true;
  } catch (err) {
    toast(err.code === 'network' ? 'No signal. Try again when you have signal.' : err.message || "Couldn't save the seat.");
    refreshAll().catch(() => {});
    return false;
  }
}

function openRideSheet(h, driver, me) {
  const switching = me?.ride && me.ride !== driver.name;
  const typed = me?.area && !findArea(me.area) ? me.area : '';
  const share = Boolean(me?.phone) || !driver.phone;
  openSheet('ride', `
    <h2 id="sheet-title">Ride with ${esc(driver.name)}</h2>
    <p class="sheet-sub">${esc(h.shortName)}, ${esc(h.dateShort)} · ${driver.area ? `from ${esc(driver.area)} · ` : ''}${esc(seatsText(driver))}</p>
    <form class="rsvp-form ride-sheet" data-ride-sheet="${h.id}" data-driver="${esc(driver.name)}" novalidate>
      ${switching ? `<p class="sheet-note">You have a seat with ${esc(me.ride)}. Saving this one gives that seat up.</p>` : ''}
      <label class="rsvp-name"><span>Your name</span><input type="text" maxlength="40" autocomplete="given-name" enterkeyhint="next" data-ride-name value="${esc(me?.name || store.get('fh:name', ''))}"></label>
      <label class="field"><span>Your area</span><select data-rsvp-area>${areaOptions(me?.area || store.get('fh:area', ''))}</select></label>
      <label class="field" data-area-other ${typed || store.get('fh:area', '') && !findArea(store.get('fh:area', '')) ? '' : 'hidden'}><span>Which area?</span><input type="text" maxlength="30" data-rsvp-area-other value="${esc(typed)}" placeholder="e.g. Leslieville"></label>
      ${stepperHTML('guests', 'People with you', 'They need seats too', me?.guests || 0, 0, MAX_GUESTS)}
      ${driver.phone ? '' : `<p class="sheet-note">${esc(driver.name)} keeps their number private. Add yours so ${esc(driver.name)} can reach you?</p>`}
      <label class="check check-sm"><input type="checkbox" data-rsvp-share ${share ? 'checked' : ''}><span class="box">${I.check}</span><span class="check-label">Show my WhatsApp so people can message me</span></label>
      <label class="field" data-phone-row ${share ? '' : 'hidden'}><span>WhatsApp number</span><input type="tel" inputmode="tel" autocomplete="tel" maxlength="20" data-rsvp-phone value="${esc(me?.phone ? formatPhone(me.phone) : '')}" placeholder="416 555 0123"></label>
      <p class="fine">Optional. Anyone with the app link can see your number when they tap Message. Saving a seat marks you as Coming.</p>
      <p class="ride-warn" data-no-reach ${driver.phone ? 'hidden' : ''}>Without a number, ${esc(driver.name)} has no way to reach you. The seat is still saved.</p>
      <div class="rsvp-claim" data-rsvp-claim hidden></div>
      <button class="btn btn-primary" type="submit" data-ride-save>Save my seat</button>
      <button class="btn btn-text" type="button" data-close-sheet>Not now</button>
    </form>`);
  syncRideSheet($('[data-ride-sheet]'));
}

function syncRideSheet(form) {
  const share = $('[data-rsvp-share]', form);
  $('[data-phone-row]', form).hidden = !share.checked;
  $('[data-area-other]', form).hidden = $('[data-rsvp-area]', form).value !== 'Other';
  const noReach = $('[data-no-reach]', form);
  const driver = listFor(form.dataset.rideSheet).list.find((e) => e.name === form.dataset.driver);
  noReach.hidden = Boolean(driver?.phone) || (share.checked && $('[data-rsvp-phone]', form).value.trim().length > 0);
}

async function submitRideSheet(form, { claim = false } = {}) {
  const hikeId = form.dataset.rideSheet;
  const h = hikeById(hikeId);
  const driver = listFor(hikeId).list.find((e) => e.name === form.dataset.driver);
  if (!driver) { closeSheet(); return toast('That driver isn\'t on the list anymore.'); }
  const picked = $('[data-rsvp-area]', form).value;
  const reply = {
    name: $('[data-ride-name]', form).value.replace(/\s+/g, ' ').trim(),
    status: 'coming',
    guests: Number($('[data-stepper="guests"] output', form).textContent),
    carpool: 'need-ride',
    seats: 0,
    area: picked === 'Other' ? $('[data-rsvp-area-other]', form).value.replace(/\s+/g, ' ').trim() || 'Other' : picked,
    phone: $('[data-rsvp-share]', form).checked ? $('[data-rsvp-phone]', form).value.trim() : '',
  };
  if (!reply.name) { toast('Add your name first'); return $('[data-ride-name]', form).focus(); }
  if (!reply.area) { toast('Pick your area'); return $('[data-rsvp-area]', form).focus(); }
  if (reply.phone && normalizePhone(reply.phone) === null) { toast("That number doesn't look right. Use 10 digits, like 416 555 0123."); return $('[data-rsvp-phone]', form).focus(); }
  if (!navigator.onLine) return toast('You need signal to save a seat.');
  const btn = $('[data-ride-save]', form);
  btn.disabled = true;
  btn.textContent = 'Saving…';
  store.set('fh:name', reply.name);
  store.set('fh:area', reply.area);
  try {
    // A seat that would no longer fit (more people) is given up first.
    const res = await setRsvp(hikeId, reply, { claim });
    if (res.queued) { closeSheet(); return toast('No signal. Your reply sends when you have signal; save the seat then.'); }
    if (await saveSeat(h, driver)) closeSheet();
  } catch (err) {
    if (err.code === 'name_taken') {
      const box = $('[data-rsvp-claim]', form);
      box.innerHTML = `<p><b>${esc(err.data.name)}</b> already replied from another phone. Is that you?</p>
        <div class="btn-row"><button class="btn btn-secondary" type="button" data-ride-claim-yes>Yes, that's me</button><button class="btn btn-secondary" type="button" data-ride-claim-no>No, I'm someone else</button></div>`;
      box.hidden = false;
    } else if (err.code === 'car_full' && myReply(hikeId)?.ride) {
      // My current seat can't take the extra people: give it up, then try this car.
      await cancelSeat(hikeId).catch(() => {});
      return submitRideSheet(form, { claim });
    } else {
      toast(err.message || "Couldn't save your reply.");
    }
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Save my seat'; }
  }
}

// ── Home: your rides at a glance ──
function fillMyRides() {
  const box = $('#view-hikes [data-my-rides]');
  if (!box || !isRsvpLive()) return;
  const now = Date.now();
  const lines = [];
  for (const h of HIKES) {
    if (now > endMs(h)) continue;
    const { list } = listFor(h.id);
    const me = list.find((e) => e.mine);
    if (!me) continue;
    const day = esc(h.dateShort);
    if (me.lostRide) lines.push([h, `<b>${day}:</b> ${esc(me.lostRide)} stopped driving. Find another ride.`, true]);
    else if (me.ride) lines.push([h, `<b>${day}:</b> You're riding with ${esc(me.ride)}.`]);
    else if (isDriving(me)) {
      const riders = list.filter((e) => e.ride === me.name).map((e) => e.name);
      if (riders.length) lines.push([h, `<b>${day}:</b> ${esc(andList(riders))} ${riders.length === 1 ? 'is' : 'are'} riding with you.`]);
    }
  }
  box.hidden = !lines.length;
  box.innerHTML = lines.map(([h, text, warn]) => `<a class="my-rides-row${warn ? ' warn' : ''}" href="#/hike/${h.id}/rides" data-push>${I.car}<span>${text}</span>${I.chevR}</a>`).join('');
}

// ═════════════════════════════════════════════════════════════
// PLAN UPDATES from the organizer
// Everyone sees them in the app; phones that turned on plan updates also get a
// notification for hikes they replied Coming or Maybe to. Only the organizer's
// phone (unlocked with their private link) can post.
// ═════════════════════════════════════════════════════════════
const UPDATE_SHOW_MS = 7 * 24 * 3600 * 1000; // updates to everyone stay pinned a week
const updateHike = (u) => (u.hike ? hikeById(u.hike) : null);
// Still relevant: a hike update until the hike is over; an update to everyone for a week.
const isCurrent = (u, now = Date.now()) => (u.hike ? Boolean(updateHike(u)) && now <= endMs(updateHike(u)) : now - u.at < UPDATE_SHOW_MS);
const updatesForHike = (hikeId) => allUpdates().filter((u) => u.hike === hikeId || (!u.hike && isCurrent(u)));
// Replied Coming or Maybe to a hike still ahead: this phone can get updates as notifications.
const canGetUpdates = () => HIKES.some((h) => Date.now() <= endMs(h) && ['coming', 'maybe'].includes(myReply(h.id)?.status));

function updateItemHTML(u, { withHike = true } = {}) {
  const h = updateHike(u);
  return `<li class="update${u.urgent ? ' urgent' : ''}">
    <p class="update-head">${u.urgent ? I.alert : I.megaphone}<b>${u.urgent ? 'Urgent update' : 'Update'} from ${esc(APP.askPerson)}</b><span>${esc(ago(u.at))}</span></p>
    ${withHike ? `<p class="update-for">${h ? `<a href="#/hike/${h.id}/updates" data-push>${esc(h.dateShort)}, ${esc(h.shortName)}</a>` : 'For everyone'}</p>` : ''}
    <p class="update-text">${esc(u.text)}</p>
  </li>`;
}

const optInHTML = (label = 'Get Summan\'s updates as notifications') =>
  isRsvpLive() && pushKey() && !updateAlertsOn() && canGetUpdates() && alertSupport() !== 'unsupported'
    ? `<button class="update-optin" type="button" data-updates-on>${I.bell}<span>${esc(label)}</span></button>` : '';

// Home: the newest update this phone hasn't closed, pinned at the top.
function fillUpdates() {
  const box = $('#view-hikes [data-updates-pin]');
  if (!box) return;
  const seen = new Set(store.get('fh:updates-seen', []));
  const current = allUpdates().filter((u) => isCurrent(u));
  const fresh = current.filter((u) => !seen.has(u.id));
  box.hidden = !fresh.length;
  if (!fresh.length) { box.innerHTML = ''; return; }
  const u = fresh[0];
  box.innerHTML = `<ul class="update-list">${updateItemHTML(u)}</ul>
    <div class="update-actions">
      <button class="update-btn" type="button" data-update-seen="${esc(u.id)}">Got it</button>
      ${current.length > 1 ? `<a class="update-btn" href="#/updates">All ${current.length} updates</a>` : ''}
    </div>
    ${optInHTML()}`;
}

// Hike page: that hike's updates (and updates to everyone), newest first.
function fillHikeUpdates() {
  const v = $('#view-detail');
  const box = $('[data-hike-updates]', v);
  const h = hikeById(v.dataset.hike);
  if (!box || !h) return;
  const list = updatesForHike(h.id);
  box.hidden = !list.length;
  box.innerHTML = list.length
    ? `<h2>${I.megaphone}Updates from ${esc(APP.askPerson)}</h2><ul class="update-list">${list.map((u) => updateItemHTML(u, { withHike: !u.hike ? true : false })).join('')}</ul>${optInHTML()}`
    : '';
}

function openUpdatesSheet() {
  const list = allUpdates().filter((u) => isCurrent(u));
  const status = !isRsvpLive() || !pushKey() ? ''
    : updateAlertsOn() ? `<p class="fine">${I.bell} You get these as notifications for hikes you replied Coming or Maybe to. <button class="link-btn" type="button" data-updates-off>Turn off</button></p>`
      : canGetUpdates() ? optInHTML()
        : '<p class="fine">Reply Coming or Maybe to a hike to get these as notifications.</p>';
  openSheet('updates', `
    <span class="sheet-badge" aria-hidden="true">${I.megaphone}</span>
    <h2 id="sheet-title">Updates from ${esc(APP.askPerson)}</h2>
    ${list.length ? `<ul class="update-list">${list.map((u) => updateItemHTML(u)).join('')}</ul>` : `<p class="sheet-sub">No updates right now. When ${esc(APP.askPerson)} changes the plan, it shows up here.</p>`}
    ${status}
    <button class="btn btn-text" type="button" data-close-sheet>Close</button>`);
}

// Turn on plan update notifications. Called straight from the tap (Safari needs that).
async function enableUpdates() {
  const support = alertSupport();
  if (support !== 'ok') {
    if (support === 'ios-install') openInstallSheet();
    else toast(support === 'denied' ? "Notifications are blocked in your phone's settings." : "This browser can't show notifications.");
    return false;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    toast("No notifications, then. You'll still see updates in the app.");
    return false;
  }
  try {
    await setUpdateAlerts(await pushSubscription());
    toast(`Done. You'll get ${APP.askPerson}'s plan updates as notifications.`);
    return true;
  } catch (err) {
    toast(err.code === 'no_reply' ? 'Reply to a hike first, then turn on updates.' : err.code === 'network' ? 'No signal. Try again when you have signal.' : `Couldn't turn on notifications: ${err.message}`);
    return false;
  }
}

// After a Coming or Maybe reply: ask once whether they want plan updates.
function askAboutUpdates(form, { scroll = true } = {}) {
  const box = $('[data-updates-ask]', form);
  if (!box || updateAlertsOn() || !pushKey() || store.get('fh:updates-asked', false)) return;
  const support = alertSupport();
  if (support === 'unsupported' || support === 'denied') return;
  box.innerHTML = support === 'ios-install'
    ? `<p>${I.bell}<span><b>Want ${esc(APP.askPerson)}'s plan updates as notifications?</b> On iPhone, add the app to your Home Screen first (iOS 16.4 or later). You'll still see updates here.</span></p>
       <div class="btn-row"><button class="btn btn-secondary" type="button" data-open-install>How to add it</button><button class="btn btn-secondary" type="button" data-updates-ask-no>OK</button></div>`
    : `<p>${I.bell}<span><b>Get plan updates from ${esc(APP.askPerson)}?</b> Time changes, cancellations and other news for the hikes you reply to. Nothing else.</span></p>
       <div class="btn-row"><button class="btn btn-primary" type="button" data-updates-on>Turn on</button><button class="btn btn-secondary" type="button" data-updates-ask-no>Not now</button></div>`;
  box.hidden = false;
  if (scroll) box.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// ── Organizer screen ──
const upcomingHikes = () => HIKES.filter((h) => Date.now() <= endMs(h));
let orgView = null;

function reachText(r) {
  if (!r) return '';
  return `${plural(r.people, 'person replied', 'people replied')} Coming or Maybe · ${plural(r.phones, 'phone gets', 'phones get')} notifications`;
}

function orgHistoryHTML() {
  const list = orgView?.updates || [];
  if (!list.length) return '<p class="fine">Nothing sent yet.</p>';
  return `<ul class="update-list org-history">${list.map((u) => `<li class="update${u.urgent ? ' urgent' : ''}">
    <p class="update-head"><b>${u.hike && hikeById(u.hike) ? `${esc(hikeById(u.hike).dateShort)}, ${esc(hikeById(u.hike).shortName)}` : 'Everyone'}</b><span>${esc(ago(u.at))}</span></p>
    <p class="update-text">${esc(u.text)}</p>
    <p class="fine">${u.phones ? `Notified ${u.delivered} of ${plural(u.phones, 'phone', 'phones')}` : 'No phones to notify'} · in the app for everyone</p>
    <button class="link-btn" type="button" data-org-delete="${esc(u.id)}">Take it down</button>
  </li>`).join('')}</ul>`;
}

// No key on this phone yet: paste the organizer link. Needed where links from ntfy
// open somewhere else (an iPhone Home Screen app doesn't share Safari's storage).
function openOrganizerUnlock() {
  openSheet('organizer', `
    <span class="sheet-badge" aria-hidden="true">${I.megaphone}</span>
    <h2 id="sheet-title">Organizer: unlock posting updates</h2>
    <p class="sheet-sub">Only for ${esc(APP.askPerson)}. Paste the organizer link from your ntfy message to post plan updates from this phone.</p>
    <form class="rsvp-form" data-org-unlock novalidate>
      <label class="field"><span>Organizer link</span><input type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" data-org-link placeholder="https://fallhike.pages.dev/#/organizer?k=…"></label>
      <p class="fine">The link is in the text of the ntfy message "Fall Hike App: your organizer link". Copy it, then paste it here.</p>
      <button class="btn btn-primary" type="submit">Unlock</button>
    </form>
    <button class="btn btn-text" type="button" data-close-sheet>Close</button>`);
}

function unlockOrganizer(form) {
  const raw = $('[data-org-link]', form).value.trim();
  const key = (raw.match(/[?&]k=([A-Za-z0-9_-]{20,200})/) || raw.match(/^([A-Za-z0-9_-]{20,200})$/) || [])[1];
  if (!key) {
    toast("That isn't the organizer link. Copy the whole link from the ntfy message.");
    $('[data-org-link]', form).focus();
    return;
  }
  setOrganizerKey(key);
  renderHome();
  openOrganizer(); // checks the key with the server; a wrong one is removed again
}

async function openOrganizer() {
  if (!organizerKey()) return openOrganizerUnlock();
  openSheet('organizer', `<h2 id="sheet-title">Send an update</h2><p class="sheet-sub">Loading…</p>`);
  try {
    orgView = await organizerView();
  } catch (err) {
    if (err.code === 'not_organizer') {
      clearOrganizerKey();
      renderHome();
      openSheet('organizer', `<h2 id="sheet-title">This organizer link isn't valid anymore</h2><p class="sheet-sub">Check you copied the newest one. Nothing was posted.</p><button class="btn btn-text" type="button" data-close-sheet>Close</button>`);
    } else {
      openSheet('organizer', `<h2 id="sheet-title">Send an update</h2><p class="sheet-sub">${err.code === 'network' ? 'No signal right now. Updates need signal to send.' : esc(err.message)}</p><button class="btn btn-text" type="button" data-close-sheet>Close</button>`);
    }
    return;
  }
  if (sheetKind !== 'organizer') return; // closed while loading
  const options = upcomingHikes().map((h) => `<option value="${h.id}">${esc(h.dateShort)} · ${esc(h.shortName)}</option>`).join('');
  openSheet('organizer', `
    <span class="sheet-badge" aria-hidden="true">${I.megaphone}</span>
    <h2 id="sheet-title">Send an update</h2>
    <p class="sheet-sub">Everyone sees it in the app. People who replied Coming or Maybe and turned on notifications get it on their phone.</p>
    <form class="rsvp-form org-form" data-org-form novalidate>
      <label class="field"><span>Who it's for</span><select data-org-hike>${options}<option value="">Everyone going to any hike</option></select></label>
      <p class="fine org-reach" data-org-reach></p>
      <label class="field"><span>Update</span><textarea data-org-text maxlength="300" rows="4" placeholder="e.g. We're meeting at 9:00 instead of 8:00."></textarea></label>
      <p class="fine org-count" data-org-count>0 / 300</p>
      <label class="check check-sm"><input type="checkbox" data-org-urgent><span class="box">${I.check}</span><span class="check-label">Urgent (shown in red, e.g. cancelled or moved)</span></label>
      <div class="rsvp-claim" data-org-confirm hidden></div>
      <button class="btn btn-primary" type="submit" data-org-send>${I.megaphone}<span>Send update</span></button>
    </form>
    <div class="org-result" data-org-result hidden></div>
    <h3 class="sub-h">Sent updates</h3>
    <div data-org-history>${orgHistoryHTML()}</div>
    <p class="fine">Organizer mode is on for this phone only. <button class="link-btn" type="button" data-org-signout>Turn it off</button></p>
    <button class="btn btn-text" type="button" data-close-sheet>Close</button>`);
  syncOrgForm();
}

function syncOrgForm() {
  const form = $('[data-org-form]');
  if (!form) return;
  const hikeId = $('[data-org-hike]', form).value;
  $('[data-org-reach]', form).textContent = reachText(hikeId ? orgView?.hikes?.[hikeId] : orgView?.everyone);
  $('[data-org-count]', form).textContent = `${[...$('[data-org-text]', form).value].length} / 300`;
}

function orgDraft(form) {
  const hikeId = $('[data-org-hike]', form).value;
  return { hike: hikeId, text: $('[data-org-text]', form).value.trim(), urgent: $('[data-org-urgent]', form).checked };
}

// Step 1: say exactly who it goes to. Step 2 (Send now): post it.
function confirmUpdate(form) {
  const d = orgDraft(form);
  if (!d.text) { toast('Write the update first'); return $('[data-org-text]', form).focus(); }
  const h = d.hike ? hikeById(d.hike) : null;
  const r = d.hike ? orgView?.hikes?.[d.hike] : orgView?.everyone;
  const box = $('[data-org-confirm]', form);
  box.innerHTML = `<p>Send ${d.urgent ? '<b>an urgent update</b>' : 'this update'} to <b>${h ? `everyone going to ${esc(h.dateShort)}, ${esc(h.shortName)}` : 'everyone going to any hike'}</b>? ${r ? `${plural(r.phones, 'phone gets', 'phones get')} a notification; ` : ''}everyone sees it in the app.</p>
    <div class="btn-row"><button class="btn btn-primary" type="button" data-org-go>Send now</button><button class="btn btn-secondary" type="button" data-org-edit>Edit</button></div>`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function whatsappUpdateText(u) {
  const h = updateHike(u);
  return `${u.urgent ? '⚠️ Urgent update' : '📣 Update'} from ${APP.askPerson}${h ? ` (${h.dateShort}, ${h.shortName})` : ''}:\n${u.text}\n\n${appUrl()}${h ? `#/hike/${h.id}/updates` : '#/updates'}`;
}

async function sendUpdate(form, btn) {
  const d = orgDraft(form);
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await postUpdate(d);
    const missed = Math.max(0, res.people - res.phones);
    form.reset();
    $('[data-org-confirm]', form).hidden = true;
    syncOrgForm();
    const out = $('[data-org-result]');
    out.innerHTML = `<p><b>Sent.</b> ${res.queued ? `${plural(res.queued, 'phone is', 'phones are')} getting a notification.` : 'No phones to notify yet.'} It's in the app for everyone.${missed ? ` ${plural(missed, 'person who replied doesn\'t', 'people who replied don\'t')} have notifications on.` : ''}</p>
      <a class="btn btn-secondary" href="${esc(`https://wa.me/?text=${encodeURIComponent(whatsappUpdateText(res.update))}`)}" target="_blank" rel="noopener">${I.chat}<span>Also post to WhatsApp group</span></a>`;
    out.hidden = false;
    out.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    orgView = await organizerView().catch(() => orgView);
    $('[data-org-history]').innerHTML = orgHistoryHTML();
  } catch (err) {
    toast(err.code === 'duplicate' ? 'You just sent that update.' : err.code === 'network' ? 'No signal. Your update wasn\'t sent; try again.' : err.message || "Couldn't send the update.");
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Send now'; }
  }
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

// The Drive and Fee tiles at the top of a hike are buttons: Drive opens directions,
// Fee opens booking (or, with nothing to book, jumps to the fee details).
const factCta = (text, icon) => `<span class="fact-cta">${esc(text)}${icon}</span>`;

const driveTile = (h) =>
  `<a class="fact fact-link" href="${esc(mapsUrl(h.maps))}" target="_blank" rel="noopener" aria-label="Drive ${esc(h.drive.short)}. Directions in Google Maps">` +
  `${I.car}<span class="fact-k">Drive</span><span class="fact-v">${esc(h.drive.short)}</span>${factCta('Directions', I.ext)}</a>`;

function feeTile(h) {
  const inner = `${I.ticket}<span class="fact-k">Fee</span><span class="fact-v">${esc(h.fee.amount).replace('/', '/<wbr>')}</span>`;
  return h.booking
    ? `<a class="fact fact-link" href="${esc(h.booking.url)}" target="_blank" rel="noopener" aria-label="Fee ${esc(h.fee.amount)}. ${esc(h.booking.label)}">${inner}${factCta(h.booking.cta || 'Book', I.ext)}</a>`
    : `<button class="fact fact-link" type="button" data-scroll-to="fees" aria-label="Fee ${esc(h.fee.amount)}. See fee details">${inner}${factCta('Details', I.chevR)}</button>`;
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
        ${driveTile(h)}
        ${feeTile(h)}
      </div>

      ${alertsHTML(h)}

      <section class="block block-updates" id="updates" data-hike-updates hidden></section>

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

      ${isRsvpLive() ? `<section class="block block-rides" id="rides">
        <h2>Rides</h2>
        <p class="muted">Drivers near you first. Tap <b>Message</b> to WhatsApp someone, or <b>Ride with</b> to save a seat.</p>
        <div data-rides aria-live="polite"><p class="muted">Loading rides…</p></div>
      </section>` : ''}

      <section class="block">
        <h2>Trails</h2>
        <ul class="trail-list">${h.trails.map(trailRow).join('')}</ul>
      </section>

      <section class="block block-fall">
        <h2>Why it's beautiful in fall</h2>
        <p class="lead">${esc(h.fallLine)}</p>
        <ul class="tags">${h.highlights.map((x) => `<li>${I.leaf}${esc(x)}</li>`).join('')}</ul>
      </section>

      <section class="block block-fees" id="fees">
        <h2>Fees and booking</h2>
        <p class="lead"><b>${esc(h.fee.amount)}</b></p>
        <p>${esc(h.fee.note)}</p>
      </section>

      <section class="block">
        <h2>Getting there</h2>
        <p class="lead">Drive: <b>${esc(h.drive.text)}</b></p>
        ${road ? `<div class="alert alert-road inline">${I.route}<div><b>${esc(road.title)}</b><span>${esc(road.text)}</span></div></div>` : ''}
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
        ${h.fallbackTrailheads ? `<p>If ${esc(h.shortName)} is too busy, fallback trailheads: ${esc(h.fallbackTrailheads.join(', '))}.</p>` : ''}
        <p class="lead"><b>${esc(h.backup.name)}</b></p>
        ${h.backup.note ? `<p>${esc(h.backup.note)}</p>` : ''}
        ${h.backup.booking ? `<a class="btn btn-primary" href="${esc(h.backup.booking.url)}" target="_blank" rel="noopener">${I.ext}<span>${esc(h.backup.booking.label)}</span></a><p class="fine">${esc(h.backup.booking.host)}</p>` : ''}
        <a class="btn btn-secondary" href="${esc(mapsUrl(h.backup.maps))}" target="_blank" rel="noopener">${I.swap}<span>Directions to ${esc(h.backup.name)}</span></a>
        ${h.backup.then ? `<p class="sub-h">Second backup</p><p class="lead"><b>${esc(h.backup.then.name)}</b></p>
        <a class="btn btn-secondary" href="${esc(mapsUrl(h.backup.then.maps))}" target="_blank" rel="noopener">${I.swap}<span>Directions to ${esc(h.backup.then.name)}</span></a>` : ''}
      </section>

      ${h.photo ? `<p class="photo-credit">${photoCredit(h.photo)}</p>` : ''}
    </div>`;

  fillHikeUpdates();

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
function barHTML(title, photo, eyebrow = APP.name) {
  return `<header class="bar${photo ? ' has-photo' : ''}">
    ${photo ? `<img class="bar-photo" src="${esc(photo.src)}" alt="" decoding="async">` : ''}
    <p class="bar-eyebrow">${esc(eyebrow)}</p>
    <h1 class="bar-title">${esc(title)}</h1>
  </header>`;
}

function renderAsk() {
  $('#view-ask').innerHTML = `
    ${barHTML('Scout', APP.photo, 'Your hike assistant')}
    <div class="chat" id="chat" aria-live="polite">
      <div class="welcome">
        <span class="welcome-icon" aria-hidden="true">${I.leaf}</span>
        <h2 class="welcome-h">Hi, I'm Scout</h2>
        <p>Ask me anything about the hikes: meeting times, fees and booking, dogs, difficulty, drive times, washrooms or what to bring.</p>
        <p class="msg-fine">Answers come from the hike plan and work offline.</p>
        <p class="welcome-try">Try asking</p>
        <div class="welcome-qs">${SUGGESTIONS.slice(0, 4).map((s) => `<button class="chip-q" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>
    </div>
    <div class="chips" role="list">${SUGGESTIONS.map((s) => `<button class="chip-q" type="button" role="listitem" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form class="composer" id="ask-form" autocomplete="off">
      <label for="ask-input" class="sr-only">Your question for Scout</label>
      <input id="ask-input" name="q" type="text" inputmode="text" enterkeyhint="send" maxlength="300" placeholder="Ask Scout anything…">
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
    const el = addMsg('bot', res.html + ridesCardFor(res.rides), { html: true });
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
    // The AI only knows the written plan, so show any newer update from the organizer too.
    el.insertAdjacentHTML('beforeend', updateNoteFor(q));
    if (ai.rideHelp) el.insertAdjacentHTML('beforeend', ridesCardFor(rideTarget(q)));
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
      ${isRsvpLive() ? `<p class="org-entry"><a href="#/organizer">${I.megaphone}<span>Organizer: post a plan update</span></a></p>` : ''}
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

// One bottom sheet at a time: install help, carpool how-to, Ride with.
let sheetKind = '';
function openSheet(kind, inner) {
  const s = $('#install-sheet');
  sheetKind = kind;
  s.innerHTML = `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <span class="sheet-grabber" aria-hidden="true"></span>
      ${inner}
    </div>`;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
  const title = $('.sheet h2', s);
  title.setAttribute('tabindex', '-1');
  title.focus({ preventScroll: true });
}

function closeSheet() {
  const s = $('#install-sheet');
  if (s.hidden) return;
  if (sheetKind === 'install') store.set('fh:install-dismissed', true);
  sheetKind = '';
  s.classList.remove('open');
  setTimeout(() => { if (!sheetKind) { s.hidden = true; s.innerHTML = ''; } }, reduceMotion() ? 0 : 260);
}

function openInstallSheet() {
  openSheet('install', `
      <img class="sheet-icon" src="icons/icon-192.png" width="72" height="72" alt="">
      <h2 id="sheet-title">Put Fall Hike App on your home screen</h2>
      <p class="sheet-sub">It opens full screen like any other app and keeps working without signal once it's loaded.</p>
      ${installSheetBody()}
      <button class="btn btn-text" type="button" data-close-sheet>Continue in browser</button>`);
}

async function runInstallPrompt() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  $$('.install-install').forEach((el) => (el.hidden = true));
  if (outcome === 'accepted') closeSheet();
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
  const m = hash.match(/^#\/hike\/([\w-]+)(?:\/(rsvp|rides|needride|updates))?/);
  const h = m && hikeById(m[1]);
  if (h) {
    showTab('hikes');
    openDetail(h, animate);
    if (m[2] === 'needride') prefillNeedRide(h);
    // From a notification: fetch the newest updates, then land on them.
    if (m[2] === 'updates' && isRsvpLive()) {
      refreshAll().catch(() => { /* no signal: saved updates show */ }).finally(() => {
        if (detailOpen && $('#view-detail').dataset.hike === h.id) $('#updates:not([hidden])')?.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    }
    if (m[2]) {
      const target = { rides: '#rides', updates: '#updates' }[m[2]] || '#rsvp';
      requestAnimationFrame(() => $(target)?.scrollIntoView({ block: 'start', behavior: animate && !reduceMotion() ? 'smooth' : 'auto' }));
    }
    return;
  }
  closeDetail(animate);
  showTab(hash.startsWith('#/ask') ? 'ask' : hash.startsWith('#/share') ? 'share' : 'hikes');
  // The organizer's private link: keep the key on this phone, then take it out of the address bar.
  const key = hash.match(/^#\/organizer\?k=([A-Za-z0-9_-]{20,200})/);
  if (key) {
    setOrganizerKey(key[1]);
    location.replace('#/organizer');
    renderHome();
    return;
  }
  if (hash.startsWith('#/organizer')) { openOrganizer(); return; }
  if (hash.startsWith('#/updates')) {
    openUpdatesSheet();
    if (isRsvpLive()) refreshAll().then(() => { if (sheetKind === 'updates') openUpdatesSheet(); }).catch(() => {});
    return;
  }
  // #/ask?q=… asks Scout that question (e.g. from the carpool banner)
  const q = hash.match(/^#\/ask\?q=(.+)$/);
  if (q) {
    let question = '';
    try { question = decodeURIComponent(q[1]); } catch { /* malformed link */ }
    location.replace('#/ask');
    if (question) ask(question);
  }
}

// "Need a ride" from Scout: the reply form, set to Coming + Need a ride
function prefillNeedRide(h) {
  const form = $('#view-detail [data-rsvp-form]');
  if (!form || myReply(h.id)?.carpool === 'need-ride') return;
  setPressed(form, 'data-rsvp-pick', 'coming');
  setPressed(form, 'data-rsvp-carpool', 'need-ride');
  if (!$('[data-rsvp-area]', form).value && store.get('fh:area', '')) {
    const a = store.get('fh:area', '');
    $('[data-rsvp-area]', form).value = findArea(a) ? findArea(a).name : 'Other';
    if (!findArea(a)) $('[data-rsvp-area-other]', form).value = a;
  }
  Object.assign(form.dataset, { dirty: 'true', statusTouched: 'true', extrasTouched: 'true' });
  syncForm(form);
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
  const t = e.target.closest('a, button, [data-close-sheet]');
  if (!t) return;

  if (t.matches('a[data-push]')) {
    e.preventDefault();
    if (t.closest('.sheet')) closeSheet();
    pushedDetail = true;
    location.hash = t.getAttribute('href');
    return;
  }
  // Message on WhatsApp: the link opens WhatsApp; in case it doesn't, show the number too.
  if (t.matches('a[data-wa]')) {
    shownNumbers.add(t.dataset.wa);
    const row = t.closest('.ride-actions');
    if (row && !row.parentElement.querySelector('.wa-fallback')) row.insertAdjacentHTML('afterend', waFallback(t.dataset.wa));
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
  if (t.matches('[data-scroll-to]')) {
    $(`#${t.dataset.scrollTo}`)?.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
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
    const form = t.closest('[data-rsvp-form]');
    if (form) Object.assign(form.dataset, { dirty: 'true', extrasTouched: 'true' });
    return;
  }
  if (t.matches('[data-ride-with]')) return rideWith(t.dataset.hike, t.dataset.rideWith);
  // ── Plan updates ──
  if (t.matches('[data-updates-on]')) {
    store.set('fh:updates-asked', true);
    const ok = await enableUpdates();
    $$('[data-updates-ask]').forEach((el) => { if (ok) el.hidden = true; });
    if (sheetKind === 'updates') openUpdatesSheet();
    return;
  }
  if (t.matches('[data-updates-off]')) {
    try {
      await setUpdateAlerts(null);
      toast('Plan update notifications are off. You\'ll still see updates in the app.');
    } catch (err) {
      toast(err.code === 'network' ? 'No signal. Try again when you have signal.' : err.message);
    }
    if (sheetKind === 'updates') openUpdatesSheet();
    return;
  }
  if (t.matches('[data-updates-ask-no]')) {
    store.set('fh:updates-asked', true);
    t.closest('[data-updates-ask]').hidden = true;
    return;
  }
  if (t.matches('[data-update-seen]')) {
    store.set('fh:updates-seen', [t.dataset.updateSeen, ...store.get('fh:updates-seen', [])].slice(0, 50));
    fillUpdates();
    return;
  }
  // ── Organizer ──
  if (t.matches('[data-org-go]')) return sendUpdate(t.closest('[data-org-form]'), t);
  if (t.matches('[data-org-edit]')) {
    t.closest('[data-org-confirm]').hidden = true;
    $('[data-org-text]').focus();
    return;
  }
  if (t.matches('[data-org-delete]')) {
    if (t.dataset.armed !== 'true') {
      t.dataset.armed = 'true';
      t.textContent = 'Tap again to take it down for everyone';
      return;
    }
    t.disabled = true;
    try {
      await deleteUpdate(t.dataset.orgDelete);
      orgView = { ...orgView, updates: (orgView?.updates || []).filter((u) => u.id !== t.dataset.orgDelete) };
      $('[data-org-history]').innerHTML = orgHistoryHTML();
      toast('Taken down. Notifications already sent stay on people\'s phones.');
    } catch (err) {
      t.disabled = false;
      toast(err.code === 'network' ? 'No signal. Try again when you have signal.' : err.message);
    }
    return;
  }
  if (t.matches('[data-org-signout]')) {
    clearOrganizerKey();
    closeSheet();
    renderHome();
    toast('Organizer mode is off on this phone. Open your organizer link to turn it back on.');
    return;
  }
  if (t.matches('[data-cancel-seat], [data-lost-ok]')) {
    const hikeId = t.dataset.cancelSeat || t.dataset.lostOk;
    const ride = myReply(hikeId)?.ride;
    t.disabled = true;
    try {
      await cancelSeat(hikeId);
      if (t.dataset.cancelSeat) toast(ride ? `Seat cancelled. Message ${ride} so they know.` : 'Seat cancelled.');
    } catch (err) {
      toast(err.code === 'network' ? 'No signal. Try again when you have signal.' : err.message || "Couldn't do that. Try again.");
    } finally {
      t.disabled = false;
    }
    return;
  }
  if (t.matches('[data-area-pick]')) {
    store.set('fh:area', t.dataset.areaPick);
    const card = t.closest('[data-rides-card]');
    if (card) card.outerHTML = ridesCardHTML(hikeById(t.dataset.hike), t.dataset.areaPick);
    return;
  }
  if (t.matches('[data-carpool-close]')) {
    store.set('fh:carpool-banner', 'closed');
    t.closest('.carpool-banner')?.remove();
    return;
  }
  if (t.matches('[data-carpool-how]')) return openCarpoolHow();
  if (t.matches('[data-carpool-scout]')) {
    location.hash = `#/ask?q=${encodeURIComponent('How does carpooling work?')}`;
    return;
  }
  if (t.matches('[data-rsvp-confirm-yes]')) {
    const form = t.closest('[data-rsvp-form]');
    $('[data-rsvp-confirm]', form).hidden = true;
    if (t.dataset.rsvpConfirmYes === 'remove') return removeReply(form, $('[data-rsvp-remove]', form), { confirmed: true });
    return sendReply(form, { confirmed: true });
  }
  if (t.matches('[data-rsvp-confirm-no]')) {
    t.closest('[data-rsvp-confirm]').hidden = true;
    return;
  }
  if (t.matches('[data-ride-claim-yes]')) return submitRideSheet(t.closest('[data-ride-sheet]'), { claim: true });
  if (t.matches('[data-ride-claim-no]')) {
    const form = t.closest('[data-ride-sheet]');
    $('[data-rsvp-claim]', form).hidden = true;
    toast('Add your last initial so people can tell you apart, e.g. "Alex K"');
    $('[data-ride-name]', form).focus();
    return;
  }
  if (t.matches('[data-rsvp-claim-yes]')) {
    // Take over the earlier reply: keep its name and whatever this phone didn't change.
    const form = t.closest('[data-rsvp-form]');
    const ex = JSON.parse($('[data-rsvp-claim]', form).dataset.existing || '{}');
    const current = readForm(form);
    const merged = { ...current, name: ex.name || current.name };
    if (form.dataset.statusTouched !== 'true' && ex.status) merged.status = ex.status;
    const keepExtras = form.dataset.extrasTouched !== 'true';
    if (keepExtras) Object.assign(merged, { guests: ex.guests || 0, carpool: ex.carpool || '', seats: ex.seats || 0, area: current.area || ex.area || '' });
    $('[data-rsvp-name]', form).value = merged.name;
    setFormReply(form, merged);
    // A number this phone didn't type stays as it was saved.
    sendReply(form, { claim: true, keepPhone: keepExtras && !current.phone });
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
  if (t.matches('[data-rsvp-remove]')) return removeReply(t.closest('[data-rsvp-form]'), t);
  if (t.matches('[data-open-install]')) return openInstallSheet();
  if (t.matches('[data-close-sheet]')) return closeSheet();
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
  const sheet = e.target.closest?.('[data-ride-sheet]');
  if (sheet) syncRideSheet(sheet);
  if (e.target.closest?.('[data-org-form]')) syncOrgForm();
});

document.addEventListener('change', (e) => {
  const form = e.target.closest?.('[data-rsvp-form]');
  const sheet = e.target.closest?.('[data-ride-sheet]');
  if (form && e.target.matches('[data-rsvp-alerts]')) {
    form.dataset.dirty = 'true';
    if (e.target.checked) askForAlerts(e.target);
    return;
  }
  if (form && e.target.matches('[data-rsvp-share], [data-rsvp-area]')) {
    form.dataset.dirty = 'true';
    if (e.target.matches('[data-rsvp-share]')) form.dataset.shareTouched = 'true';
    syncForm(form);
    if (e.target.matches('[data-rsvp-area]') && e.target.value === 'Other') $('[data-rsvp-area-other]', form).focus();
    return;
  }
  if (e.target.matches?.('[data-org-hike]')) { syncOrgForm(); return; }
  if (sheet) {
    syncRideSheet(sheet);
    if (e.target.matches('[data-rsvp-area]') && e.target.value === 'Other') $('[data-rsvp-area-other]', sheet).focus();
    return;
  }
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
  if (e.target.matches('[data-ride-sheet]')) {
    e.preventDefault();
    submitRideSheet(e.target);
    return;
  }
  if (e.target.matches('[data-org-form]')) {
    e.preventDefault();
    confirmUpdate(e.target);
    return;
  }
  if (e.target.matches('[data-org-unlock]')) {
    e.preventDefault();
    unlockOrganizer(e.target);
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
  if (e.key === 'Escape' && !$('#install-sheet').hidden) closeSheet();
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
  if (sheetKind === 'install') openInstallSheet();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (sheetKind === 'install') closeSheet();
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
