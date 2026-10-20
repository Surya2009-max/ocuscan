(function () {
  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:') return;
  // Paste your Railway public URL below (no trailing slash), then commit.
  window.ENV_API_URL = 'https://ocuscan-production.up.railway.app';
  if (window.ENV_API_URL.indexOf('YOUR-APP-NAME') !== -1) {
    console.error('config.js still has the placeholder URL. Put your real Railway address in it.');
  }
})();
