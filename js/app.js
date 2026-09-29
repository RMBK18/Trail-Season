import { HIKES, BASICS, APP, hikeById } from './data.js';
import { esc, mapsUrl, meetMs, endMs, statusOf, nextHike, isHikeDay, countdownParts } from './lib.js';
import { answer, askLiveAI, isLiveAIOn, DONT_KNOW, SUGGESTIONS } from './ask.js';
import { isRsvpLive, setRsvp, subscribeRsvps, RSVP_STATUSES, RSVP_LABELS } from './rsvp.js';
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
    `🥾 ${trailsSummary(h)}`,
    `🍁 ${h.fallLine}`,
    `🚗 Drive: ${h.drive.text}`,
    `🎟️ ${h.fee.amount}. ${h.fee.note}${h.booking ? ` ${h.booking.url}` : ''}`,
    ...alerts.map((a) => `⚠️ ${a.title}. ${a.text}`),
    `🔁 Backup: ${h.backup.name}`,
    '',
    'Are you in? Reply here.',
    `Details: ${appUrl()}#/hike/${h.id}`,
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
    <a class="card" href="#/hike/${h.id}" data-push>
      <span class="card-top"><span class="card-date">${esc(h.dateShort)}</span>${chip}</span>
      <h3 class="card-park">${esc(h.park)}</h3>
      <span class="card-area">${esc(h.area)}</span>
      <span class="card-badges">${levelBadges(h)}</span>
      <span class="card-facts">
        <span class="fact-inline">${I.clock}Meet ${esc(h.meet.time)}</span>
        <span class="fact-inline">${I.car}${esc(h.drive.short)}</span>
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

function renderHome() {
  const now = new Date();
  const allHikes = getHikes();
  const nx = allHikes.find((h) => now.getTime() <= endMs(h)) || null;
  homeKey = homeStateKey(now);
  const showGetApp = !isStandalone() && (isIOS || isAndroid);
  $('#view-hikes').innerHTML = `
    <header class="canopy">
      <button id="admin-btn" style="position:absolute;top:calc(var(--safe-t) + 12px);right:14px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);color:#fff;font-size:20px;cursor:pointer;" title="Edit hikes">⚙️</button>
      <h1 class="large-title">Fall Hike App</h1>
      <p class="canopy-sub">Five Saturdays near Toronto, Oct 3 to Oct 31</p>
      ${signHTML(now, allHikes)}
    </header>
    <section class="list-wrap" aria-labelledby="list-h">
      ${showGetApp ? `<button class="get-app" type="button" data-open-install>${I.download}<span><b>Add to your home screen</b><span>Opens full screen and works without signal</span></span>${I.chevR}</button>` : ''}
      <h2 id="list-h" class="section-h">${getHikes().length === 5 ? 'The five Saturdays' : 'Upcoming Hikes'}</h2>
      <ol class="trail">${allHikes.map((h) => cardHTML(h, now, nx)).join('')}</ol>
      <p class="list-foot">Tap a hike for trails, fees, directions and what to bring.</p>
    </section>`;
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
// PHASE 2: SHARED RSVP UI
// Renders only when isRsvpLive() is true (Firestore configured in js/config.js
// AND js/rsvp.js replaced with a real implementation). In Phase 1 the section
// just says RSVPs aren't in the app yet. Nothing here uses localStorage for RSVPs;
// only the friend's own display name is remembered on their phone.
// ═════════════════════════════════════════════════════════════
let rsvpUnsub = null;

function rsvpSectionHTML(h) {
  if (isRsvpLive()) {
    return `<div class="rsvp" data-rsvp="${h.id}">
      <label class="rsvp-name"><span>Your name</span><input type="text" maxlength="40" autocomplete="given-name" data-rsvp-name value="${esc(store.get('fh:name', ''))}"></label>
      <div class="rsvp-buttons">${RSVP_STATUSES.map((s) => `<button class="btn btn-choice" type="button" data-rsvp-status="${s}">${esc(RSVP_LABELS[s])}</button>`).join('')}</div>
      <div class="rsvp-list" aria-live="polite"><p class="muted">Loading who's coming…</p></div>
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

function renderRsvpList(rsvps) {
  const box = $('#view-detail .rsvp-list');
  if (!box) return;
  if (!rsvps.length) { box.innerHTML = '<p class="muted">No replies yet.</p>'; return; }
  box.innerHTML = RSVP_STATUSES.map((st) => {
    const names = rsvps.filter((r) => r.status === st).map((r) => esc(r.name));
    return names.length ? `<p><b>${esc(RSVP_LABELS[st])} (${names.length})</b><br>${names.join(', ')}</p>` : '';
  }).join('');
}

function startRsvp(h) {
  stopRsvp();
  if (!isRsvpLive()) return;
  try {
    rsvpUnsub = subscribeRsvps(h.id, renderRsvpList, (err) => {
      const box = $('#view-detail .rsvp-list');
      if (box) box.innerHTML = `<p class="muted">Couldn't load RSVPs: ${esc(err.message)}</p>`;
    });
  } catch (err) {
    const box = $('#view-detail .rsvp-list');
    if (box) box.innerHTML = `<p class="muted">Couldn't load RSVPs: ${esc(err.message)}</p>`;
  }
}

function stopRsvp() {
  if (rsvpUnsub) { try { rsvpUnsub(); } catch { /* already closed */ } }
  rsvpUnsub = null;
}

async function loadWeather(h) {
  const w = await getWeather(h.id);
  const box = $('#view-detail [data-weather]');
  if (!w || !box) return;
  const { desc, icon } = describeWeather(w.code);
  const rain = w.rain > 0 ? ` ${w.rain.toFixed(1)}mm rain` : '';
  box.innerHTML = `
    <div class="weather">
      <span class="weather-icon">${icon}</span>
      <div>
        <b>${desc}</b><br>
        ${w.low.toFixed(0)}–${w.high.toFixed(0)}°C${rain}
      </div>
    </div>`;
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
    <div class="navbar">
      <button class="nav-back" type="button" data-back>${I.chevL}<span>Hikes</span></button>
      <span class="nav-title">${esc(h.shortName)}</span>
      <button class="nav-action" type="button" data-copy-hike="${h.id}" aria-label="Copy invite">${I.share}</button>
    </div>
    <header class="hero hero-${h.accent}">
      ${heroArt(h)}
      <p class="hero-date">${esc(h.dateLong)}</p>
      <h1 class="hero-title">${esc(h.park)}</h1>
      <p class="hero-area">${esc(h.area)}</p>
      <div class="hero-badges">${levelBadges(h)}</div>
    </header>

    <div class="detail-body">
      <div class="facts">
        <div class="fact">${I.clock}<span class="fact-k">Meet</span><span class="fact-v">${esc(h.meet.time)}</span></div>
        <div class="fact">${I.car}<span class="fact-k">Drive</span><span class="fact-v">${esc(h.drive.short)}</span></div>
        <div class="fact">${I.ticket}<span class="fact-k">Fee</span><span class="fact-v">${esc(h.fee.amount)}</span></div>
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

      <section class="block">
        <h2>Who's coming</h2>
        ${rsvpSectionHTML(h)}
      </section>
    </div>`;

  // Show the park name in the nav bar once the big title scrolls away
  const title = $('.hero-title', v);
  const navTitle = $('.nav-title', v);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => navTitle.classList.toggle('show', !e.isIntersecting), {
      root: v,
      rootMargin: '-60px 0px 0px 0px',
    }).observe(title);
  }
}

// ═════════════════════════════════════════════════════════════
// ASK TAB
// ═════════════════════════════════════════════════════════════
function renderAsk() {
  $('#view-ask').innerHTML = `
    <header class="bar"><h1 class="bar-title">Ask</h1></header>
    <div class="chat" id="chat" aria-live="polite">
      <div class="msg bot">
        <p>Ask about meeting times, fees and booking, dogs, difficulty, drive times, washrooms or what to bring.</p>
        <p class="msg-fine">Answers come from the hike plan and work offline.</p>
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

async function ask(question) {
  const q = question.trim();
  if (!q) return;
  addMsg('me', q);
  const res = answer(q);
  if (res.matched) {
    addMsg('bot', res.html, { html: true });
    return;
  }
  // PHASE 2 hook: only runs when CONFIG.aiEndpoint is set (see js/ask.js → askLiveAI).
  if (!isLiveAIOn()) {
    addMsg('bot', DONT_KNOW);
    return;
  }
  const typing = addMsg('bot typing', '<span></span><span></span><span></span>', { html: true });
  const ai = await askLiveAI(q);
  typing.remove();
  if (ai) {
    const el = addMsg('bot', ai);
    el.insertAdjacentHTML('beforeend', '<p class="msg-fine">Live answer</p>');
  } else {
    addMsg('bot', DONT_KNOW);
  }
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
  $('#view-share').innerHTML = `
    <header class="bar"><h1 class="bar-title">Share</h1></header>
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
  if (t.matches('[data-rsvp-status]')) {
    const hikeId = $('#view-detail').dataset.hike;
    const input = $('#view-detail [data-rsvp-name]');
    const name = (input?.value || '').trim().slice(0, 40);
    if (!name) { toast('Add your name first'); input?.focus(); return; }
    store.set('fh:name', name);
    t.disabled = true;
    try {
      await setRsvp(hikeId, { name, status: t.dataset.rsvpStatus });
      toast(`Saved: ${RSVP_LABELS[t.dataset.rsvpStatus]}`);
    } catch (err) {
      toast(`Couldn't save your RSVP: ${err.message}`);
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

document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-check]');
  if (!cb) return;
  const id = $('#view-detail').dataset.hike;
  const checked = $$('input[data-check]', $('#view-detail')).filter((x) => x.checked).map((x) => x.dataset.check);
  store.set(`fh:check:${id}`, checked);
});

document.addEventListener('submit', (e) => {
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
