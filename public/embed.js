// public/embed.js — calls your hosted /track
(function(){
  try {
    var payload = {
      url: location.href,
      path: location.pathname + location.search,
      ts: Math.floor(Date.now()/1000)
    };
    fetch('https://sotobarbosacloud.onrender.com/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function(){});
  } catch (e) {}
})();
