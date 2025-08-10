// admin.js — dark console UI + realtime + server geo + device badge

const rowsEl = document.getElementById('rows');
const statusPill = document.getElementById('statusPill');
const rtPill = document.getElementById('realtimePill');
const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const logoutBtn = document.getElementById('logoutBtn');

const qEl = document.getElementById('q');
const searchBtn = document.getElementById('searchBtn');

function isPhoneUA(ua=''){
  return /Android|iPhone|iPad|iPod|Mobile|Silk\/|Kindle|Opera Mini|IEMobile/i.test(ua);
}
function escapeHtml(s=''){
  return s.replace(/[&<>"'`]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'
  }[c]));
}
function pill(el, cls, text){
  el.classList.remove('ok','warn','bad');
  if (cls) el.classList.add(cls);
  if (text) el.textContent = text;
}

function addRow(v){
  const tr = document.createElement('tr');
  const time = new Date((v.ts || (Date.now()/1000))*1000).toLocaleString();
  const device = isPhoneUA(v.ua) ? 'phone' : 'desktop';
  const locNow = (v.geo && (v.geo.city || v.geo.region || v.geo.country))
    ? [v.geo.city, v.geo.region, v.geo.country].filter(Boolean).join(', ')
    : '';

  tr.innerHTML = `
    <td class="small">${time}</td>
    <td>
      <div>${escapeHtml(v.ip || '')}</div>
      <div class="small loc">${escapeHtml(locNow || '…')}</div>
    </td>
    <td>${escapeHtml(v.path || '')}</td>
    <td class="small">${escapeHtml(v.ua || '')}</td>
    <td>
      <div class="badges">
        <span class="badge ${device}">${device}</span>
      </div>
    </td>
  `;
  rowsEl.prepend(tr);
}

async function fetchRows(query=''){
  const u = new URL('/api/search', location.origin);
  u.searchParams.set('q', query);
  u.searchParams.set('limit','200');
  const r = await fetch(u.toString(), { credentials:'include' });
  if (!r.ok) throw new Error('search '+r.status);
  const data = await r.json();
  rowsEl.innerHTML = '';
  (data.rows || data || []).forEach(addRow);
}

async function boot(){
  const s = await fetch('/api/session', { credentials:'include' }).then(r=>r.json()).catch(()=>({authed:false}));
  if (s.authed){
    pill(statusPill,'ok','authenticated');
    loginView.style.display = 'none';
    appView.style.display = '';
    logoutBtn.style.display = '';

    await fetchRows('');

    const socket = io({ transports:['websocket','polling'] });
    socket.on('connect', ()=>{
      pill(rtPill,'ok','Realtime: connected');
      socket.emit('join-admin');
    });
    socket.on('disconnect', ()=> pill(rtPill,'warn','Realtime: reconnecting…'));
    socket.on('visit', (v)=> addRow(v));
  } else {
    pill(statusPill,'bad','not authenticated');
    loginView.style.display = '';
    appView.style.display = 'none';
    logoutBtn.style.display = 'none';
  }
}

searchBtn.addEventListener('click', ()=> fetchRows(qEl.value || ''));
qEl.addEventListener('keydown', (e)=>{ if (e.key==='Enter') fetchRows(qEl.value||''); });
logoutBtn.addEventListener('click', async ()=>{
  await fetch('/logout', { method:'POST', credentials:'include' });
  location.reload();
});

boot();
