// HMR client — injected into index.html by the dev server.
// Connects to the dev server's WebSocket and reloads on change.
(function() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host;
  var retryMs = 1000;

  function connect() {
    var ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      console.log('[naive-hmr] connected');
      retryMs = 1000;
    };
    ws.onmessage = function(e) {
      if (e.data === 'reload') {
        console.log('[naive-hmr] reloading...');
        location.reload();
      }
    };
    ws.onclose = function() {
      console.log('[naive-hmr] disconnected, reconnecting in ' + (retryMs / 1000) + 's');
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 5000);
    };
    ws.onerror = function() { ws.close(); };
  }
  connect();
})();
