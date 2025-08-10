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
    })
    .then(r => console.log('Track status:', r.status))
    .catch(err => console.error('Track error:', err));
  } catch (e) {
    console.error('Track exception:', e);
  }
})();
