// naive devtools — injected by CLI when --devtools flag is set.
// Creates a status overlay and wraps mount() with logging.

(function () {
  var realDoc = document;

  // ── Status overlay ──────────────────────────────────────────────
  var statusEl = realDoc.createElement('div');
  statusEl.id = 'naive-devtools';
  statusEl.style.cssText =
    'position:fixed;bottom:0;left:0;right:0;background:#111;color:#0f0;' +
    'font:12px monospace;padding:8px;z-index:9999;max-height:50vh;' +
    'overflow:auto;white-space:pre-wrap;';
  realDoc.body.appendChild(statusEl);

  function log(msg) {
    statusEl.textContent += msg + '\n';
  }

  // ── Intercept mount() ──────────────────────────────────────────
  // Poll for mount() becoming available (runtime module may load async)
  function wrapMount() {
    var mod = globalThis.__naiveModules;
    if (!mod) {
      requestAnimationFrame(wrapMount);
      return;
    }
    var origMount = mod.mount;
    if (typeof origMount !== 'function') {
      requestAnimationFrame(wrapMount);
      return;
    }
    mod.mount = function () {
      log('Mounting app...');
      var args = arguments;
      var result = origMount.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then(
          function () { log('Mount succeeded!'); },
          function (err) {
            log('Mount FAILED: ' + (err && err.message || String(err)));
            console.error(err);
          }
        );
      }
      log('Mount called (sync)');
      return result;
    };
    log('Devtools ready');
  }

  // Start polling once the page is interactive
  if (realDoc.readyState === 'loading') {
    realDoc.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(wrapMount); });
  } else {
    requestAnimationFrame(wrapMount);
  }
})();
