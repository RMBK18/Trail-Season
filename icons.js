// Small inline SVG icons (24×24, stroke = currentColor).
const svg = (body, extra = '') =>
  `<svg class="ic" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const I = {
  hikes: svg('<path d="M2.5 19.5 9 8.5l3.6 6 2.4-3.8 6.5 8.8Z"/><path d="m7.2 11.6 1.8 1.4 1.7-1.6"/>'),
  ask: svg('<path d="M20.5 12a8 8 0 0 1-11.7 7.1L3.5 20.5l1.4-4.6A8 8 0 1 1 20.5 12Z"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4"/><path d="M12 16.4h.01"/>'),
  share: svg('<path d="M12 3.5v11"/><path d="m7.8 7.7 4.2-4.2 4.2 4.2"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H16"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  car: svg('<path d="M4 16.5V12l1.8-4.6A2 2 0 0 1 7.7 6h8.6a2 2 0 0 1 1.9 1.4L20 12v4.5"/><path d="M3 16.5h18"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>'),
  ticket: svg('<path d="M3.5 8.5V6.8c0-.7.6-1.3 1.3-1.3h14.4c.7 0 1.3.6 1.3 1.3v1.7a2.5 2.5 0 0 0 0 5v1.7c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3v-1.7a2.5 2.5 0 0 0 0-5Z" transform="translate(0 1.5)"/><path d="M14.5 7v11" stroke-dasharray="1.6 2"/>'),
  chevR: svg('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
  chevL: svg('<path d="M15 5.5 8.5 12l6.5 6.5"/>', 'stroke-width="2.4"'),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>'),
  alert: svg('<path d="M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.2"/><path d="M12 17h.01"/>'),
  paw: svg('<circle cx="6" cy="10.5" r="1.7"/><circle cx="9.6" cy="6.6" r="1.7"/><circle cx="14.4" cy="6.6" r="1.7"/><circle cx="18" cy="10.5" r="1.7"/><path d="M12 12c-2.6 0-5 3.2-5 5.4 0 1.5 1.1 2.1 2.4 2.1 1.1 0 1.7-.6 2.6-.6s1.5.6 2.6.6c1.3 0 2.4-.6 2.4-2.1 0-2.2-2.4-5.4-5-5.4Z"/>'),
  wc: svg('<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M7 9h10"/><path d="M8 9c0 3.6 1.8 6 4 6s4-2.4 4-6"/><path d="M10 15l-.8 5M14 15l.8 5"/>'),
  table: svg('<path d="M4 9.5h16"/><path d="M6.5 9.5 4.5 18M17.5 9.5l2 8.5"/><path d="M3 14h18"/>'),
  leaf: svg('<path d="M5 19C5 11 10 5.5 19.5 4.5 19 14 13.5 19 5 19Z"/><path d="M5 19 14 10"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'stroke-width="2.6"'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  send: svg('<path d="M12 19.5v-15"/><path d="m6 10.5 6-6 6 6"/>', 'stroke-width="2.4"'),
  ext: svg('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4"/>'),
  route: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>'),
  users: svg('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8"/><path d="M17.5 14.8c1.8.6 3 2.3 3 4.7"/>'),
  swap: svg('<path d="M4 8h13.5"/><path d="m14 4.5 3.5 3.5-3.5 3.5"/><path d="M20 16H6.5"/><path d="m10 12.5-3.5 3.5 3.5 3.5"/>'),
  boot: svg('<path d="M7 3.5h5v7l5.5 2.3a3 3 0 0 1 1.9 2.8v1.9H4.5V13L7 10.5Z"/><path d="M4.5 20h15"/><path d="M12 7h-2.5M12 10h-2.5"/>'),
  sparkle: svg('<path d="M12 3.5 13.8 10 20.5 12l-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2Z"/>'),
  download: svg('<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  // Glyphs used inside install instructions
  iosShare: svg('<path d="M12 3.5v11"/><path d="m8 7.5 4-4 4 4"/><path d="M8.5 10.5H7A1.5 1.5 0 0 0 5.5 12v6.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 17 10.5h-1.5"/>'),
  moreH: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  moreV: svg('<circle cx="12" cy="5.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor"/>'),
  addSquare: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
};
