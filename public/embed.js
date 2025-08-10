// public/embed.js
(function(){
  try {
    var payload = {
      url: location.href,
      path: location.pathname + location.search,
      ts: Math.floor(Date.now()/1000)
    };

    // include user-agent optionally (some browsers block custom UA headers); server can read it
    fetch('/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    }).catch(function(){ /* fail silently */ });
  } catch (e) {
    // ignore
  }
})();
