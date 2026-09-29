// ─────────────────────────────────────────────────────────────
// Admin panel UI for editing hikes
// ─────────────────────────────────────────────────────────────

import { HIKES as DEFAULT_HIKES, APP } from './data.js';
import { getCustomHikes, saveCustomHikes, resetToDefaults, backupHikes, restoreHikes, EXAMPLE_HIKE } from './admin.js';
import { esc } from './lib.js';

export function showAdminPanel() {
  const html = `
    <div id="admin-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;">
      <div id="admin-panel" style="background:white;border-radius:12px;padding:20px;max-width:800px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="margin:0;font-size:24px;">Edit Hikes</h2>
          <button id="close-admin" style="background:none;border:none;font-size:24px;cursor:pointer;">✕</button>
        </div>

        <div id="admin-tabs" style="display:flex;gap:10px;margin-bottom:20px;border-bottom:1px solid #ccc;">
          <button class="admin-tab active" data-tab="list" style="padding:10px 15px;border:none;background:none;cursor:pointer;border-bottom:3px solid #333;">Hikes</button>
          <button class="admin-tab" data-tab="edit" style="padding:10px 15px;border:none;background:none;cursor:pointer;">Add/Edit</button>
          <button class="admin-tab" data-tab="backup" style="padding:10px 15px;border:none;background:none;cursor:pointer;">Backup</button>
        </div>

        <div id="admin-content"></div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  const panel = document.getElementById('admin-panel');
  const overlay = document.getElementById('admin-overlay');

  document.getElementById('close-admin').onclick = () => { overlay.remove(); location.reload(); };
  overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); location.reload(); } };

  renderTab('list', panel);
  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.onclick = (e) => {
      document.querySelectorAll('.admin-tab').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      renderTab(e.target.dataset.tab, panel);
    };
  });
}

function renderTab(tab, panel) {
  const content = panel.querySelector('#admin-content');
  if (tab === 'list') renderList(content);
  else if (tab === 'edit') renderEdit(content);
  else if (tab === 'backup') renderBackup(content);
}

function renderList(content) {
  const custom = getCustomHikes();
  const hikes = custom.length > 0 ? custom : DEFAULT_HIKES;

  let html = '<div style="max-height:400px;overflow-y:auto;">';
  hikes.forEach((h, i) => {
    html += `
      <div style="padding:12px;border:1px solid #eee;border-radius:8px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <div>
            <b>${esc(h.dateShort)}</b><br>
            <span style="font-size:14px;color:#666;">${esc(h.park)}, ${esc(h.area)}</span><br>
            <span style="font-size:13px;color:#999;">Meet ${esc(h.meet.time)} · ${esc(h.level)}</span>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="edit-hike-btn" data-idx="${i}" style="padding:6px 12px;background:#007AFF;color:white;border:none;border-radius:6px;cursor:pointer;">Edit</button>
            ${custom.length > 0 ? `<button class="delete-hike-btn" data-idx="${i}" style="padding:6px 12px;background:#FF3B30;color:white;border:none;border-radius:6px;cursor:pointer;">Delete</button>` : ''}
          </div>
        </div>
      </div>`;
  });
  html += '</div>';

  if (custom.length > 0) {
    html += `<button id="reset-hikes-btn" style="width:100%;padding:10px;margin-top:15px;background:#FF9500;color:white;border:none;border-radius:8px;cursor:pointer;">Reset to Defaults</button>`;
  }

  content.innerHTML = html;

  content.querySelectorAll('.edit-hike-btn').forEach((btn) => {
    btn.onclick = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      renderEditForm(content, hikes[idx], idx, hikes);
    };
  });
  content.querySelectorAll('.delete-hike-btn').forEach((btn) => {
    btn.onclick = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const h = custom.splice(idx, 1)[0];
      saveCustomHikes(custom);
      alert(`Deleted ${h.dateShort}`);
      renderList(content);
    };
  });
  document.getElementById('reset-hikes-btn')?.addEventListener('click', () => {
    if (confirm('Reset all hikes to defaults? This cannot be undone.')) {
      resetToDefaults();
      location.reload();
    }
  });
}

function renderEdit(content) {
  content.innerHTML = `
    <div style="max-height:400px;overflow-y:auto;padding-bottom:20px;">
      <button id="add-hike-btn" style="width:100%;padding:10px;margin-bottom:15px;background:#34C759;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">+ Add New Hike</button>
      <p style="font-size:13px;color:#666;">Click to add a new hike. Fill in all fields below.</p>
    </div>`;

  document.getElementById('add-hike-btn').onclick = () => {
    const custom = getCustomHikes();
    const allHikes = custom.length > 0 ? custom : [...DEFAULT_HIKES];
    const newHike = JSON.parse(JSON.stringify(EXAMPLE_HIKE));
    newHike.id = 'custom-' + Date.now();
    newHike.n = allHikes.length + 1;
    renderEditForm(content, newHike, allHikes.length, allHikes);
  };
}

function renderEditForm(content, hike, idx, allHikes) {
  const isNew = !allHikes.find((h) => h.id === hike.id);
  const html = `
    <div style="max-height:400px;overflow-y:auto;padding-bottom:20px;">
      <h3>${isNew ? 'New Hike' : 'Edit Hike'}</h3>
      <div style="display:grid;gap:12px;">
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Date (YYYY-MM-DD)</label>
          <input type="text" id="dateISO" value="${hike.dateISO}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Day of month</label>
          <input type="number" id="day" value="${hike.day}" min="1" max="31" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Meet time (HH:MM, 24h format)</label>
          <input type="text" id="meetTime24" value="${hike.meetTime24}" placeholder="08:00" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Park name</label>
          <input type="text" id="park" value="${hike.park}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Short name</label>
          <input type="text" id="shortName" value="${hike.shortName}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">City / Area</label>
          <input type="text" id="area" value="${hike.area}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Meet location</label>
          <input type="text" id="meetPlace" value="${hike.meet.place || ''}" placeholder="e.g., park gate" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Difficulty</label>
          <select id="level" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
            <option value="EASY" ${hike.level === 'EASY' ? 'selected' : ''}>EASY</option>
            <option value="MODERATE" ${hike.level === 'MODERATE' ? 'selected' : ''}>MODERATE</option>
          </select>
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Drive time (e.g., ~45–60 min)</label>
          <input type="text" id="driveText" value="${hike.drive.text}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Fee amount</label>
          <input type="text" id="feeAmount" value="${hike.fee.amount}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-weight:bold;display:block;margin-bottom:4px;">Why it's beautiful</label>
          <input type="text" id="fallLine" value="${hike.fallLine}" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;">
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:15px;">
        <button id="save-hike-btn" style="flex:1;padding:10px;background:#007AFF;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:bold;">Save</button>
        <button id="cancel-edit-btn" style="flex:1;padding:10px;background:#ccc;color:#333;border:none;border-radius:8px;cursor:pointer;">Cancel</button>
      </div>
    </div>`;

  content.innerHTML = html;

  document.getElementById('save-hike-btn').onclick = () => {
    const custom = getCustomHikes();
    const all = custom.length > 0 ? custom : [...DEFAULT_HIKES];

    hike.dateISO = document.getElementById('dateISO').value;
    hike.day = parseInt(document.getElementById('day').value);
    hike.meetTime24 = document.getElementById('meetTime24').value;
    hike.park = document.getElementById('park').value;
    hike.shortName = document.getElementById('shortName').value;
    hike.area = document.getElementById('area').value;
    hike.meet.place = document.getElementById('meetPlace').value || null;
    hike.level = document.getElementById('level').value;
    hike.drive.text = document.getElementById('driveText').value;
    hike.drive.short = hike.drive.text;
    hike.fee.amount = document.getElementById('feeAmount').value;
    hike.fallLine = document.getElementById('fallLine').value;
    hike.dateShort = `Sat ${hike.dateISO.split('-').slice(1).join(' ')}`;
    hike.dateLong = new Date(hike.dateISO + 'T00:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
    hike.meetTime24 = (document.getElementById('meetTime24').value || '08:00').padStart(5, '0');
    const [h, m] = hike.meetTime24.split(':');
    hike.meet.time = `${parseInt(h)}:${m} AM`;

    if (isNew) {
      all.push(hike);
    } else {
      const idx = all.findIndex((x) => x.id === hike.id);
      if (idx !== -1) all[idx] = hike;
    }

    saveCustomHikes(all);
    alert(`Saved ${hike.dateShort}`);
    renderList(content);
  };

  document.getElementById('cancel-edit-btn').onclick = () => renderList(content);
}

function renderBackup(content) {
  const backup = backupHikes();
  const html = `
    <div style="max-height:400px;overflow-y:auto;padding-bottom:20px;">
      <h3>Backup & Restore</h3>
      <p style="font-size:13px;color:#666;">Copy your custom hikes as JSON to back them up or move them to another phone.</p>
      <div style="margin:15px 0;">
        <label style="font-weight:bold;display:block;margin-bottom:4px;">Your backup (copy this to save)</label>
        <textarea id="backup-text" readonly style="width:100%;height:150px;padding:8px;border:1px solid #ccc;border-radius:6px;font-family:monospace;font-size:12px;box-sizing:border-box;">${backup}</textarea>
        <button id="copy-backup-btn" style="width:100%;padding:10px;margin-top:10px;background:#007AFF;color:white;border:none;border-radius:8px;cursor:pointer;">Copy to clipboard</button>
      </div>
      <div style="margin:15px 0;">
        <label style="font-weight:bold;display:block;margin-bottom:4px;">Restore from backup (paste JSON here)</label>
        <textarea id="restore-text" placeholder='Paste JSON backup here' style="width:100%;height:150px;padding:8px;border:1px solid #ccc;border-radius:6px;font-family:monospace;font-size:12px;box-sizing:border-box;"></textarea>
        <button id="restore-btn" style="width:100%;padding:10px;margin-top:10px;background:#34C759;color:white;border:none;border-radius:8px;cursor:pointer;">Restore</button>
      </div>
    </div>`;

  content.innerHTML = html;

  document.getElementById('copy-backup-btn').onclick = () => {
    document.getElementById('backup-text').select();
    document.execCommand('copy');
    alert('Copied to clipboard');
  };

  document.getElementById('restore-btn').onclick = () => {
    const json = document.getElementById('restore-text').value.trim();
    if (!json) { alert('Paste JSON first'); return; }
    try {
      restoreHikes(json);
      alert('Restored!');
      location.reload();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };
}
