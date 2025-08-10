// public/admin.js
(async function(){
  const r = await fetch('/api/session');
  const info = await r.json();
  if (!info.authed) {
    // present a simple login form
    document.body.innerHTML = `
      <h2>Admin login</h2>
      <form method="post" action="/login">
        <input name="password" type="password" placeholder="password" />
        <button type="submit">Login</button>
      </form>
      <p class="small">Set ADMIN_PASSWORD and SESSION_SECRET in environment.</p>
    `;
    return;
  }

  const socket = io();
  socket.emit('join-admin');

  const rowsEl = document.getElementById('rows');
  const addRow = (v) => {
    const tr = document.createElement('tr');
    const time = new Date((v.ts || (Date.now()/1000)) * 1000).toLocaleString();
    tr.innerHTML = `<td class="small">${time}</td><td>${escapeHtml(v.ip)}</td><td>${escapeHtml(v.path || '')}</td><td class="small">${escapeHtml(v.ua || '')}</td>`;
    rowsEl.prepend(tr);
  };

  socket.on('visit', (v) => {
    addRow(v);
  });

  document.getElementById('btnSearch').addEventListener('click', async (e) => {
    e.preventDefault();
    const q = document.getElementById('search').value.trim();
    const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=200');
    const json = await res.json();
    rowsEl.innerHTML = '';
    json.rows.forEach(addRow);
  });

  // load recent
  document.getElementById('btnSearch').click();

  function escapeHtml(s){
    if (!s) return '';
    return s.replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
})();
