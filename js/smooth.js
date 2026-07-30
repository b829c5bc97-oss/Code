/* Inertia smooth-scroll. Exposes window.__progress (0..1) for the WebGL scene.
   Falls back to native scroll on touch / reduced-motion. */
(function () {
  var container = document.querySelector('[data-scroll]');
  if (!container) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  var enabled = !reduce && !isTouch;

  var current = 0, target = 0, ease = 0.09, limit = 0;

  function setHeight() {
    var h = container.getBoundingClientRect().height;
    document.body.style.height = h + 'px';
    limit = Math.max(h - window.innerHeight, 1);
  }

  function updateProgress(y) {
    window.__progress = Math.min(Math.max(y / limit, 0), 1);
  }

  if (enabled) {
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100%';
    setHeight();

    window.addEventListener('scroll', function () { target = window.scrollY; }, { passive: true });
    window.addEventListener('resize', setHeight);
    // recalc after fonts/images settle
    window.addEventListener('load', function () { setTimeout(setHeight, 300); });
    var ro = new ResizeObserver(setHeight);
    ro.observe(container);

    (function loop() {
      requestAnimationFrame(loop);
      current += (target - current) * ease;
      if (Math.abs(target - current) < 0.05) current = target;
      container.style.transform = 'translate3d(0,' + (-current) + 'px,0)';
      updateProgress(current);
    })();
  } else {
    // native scroll: just track progress
    function nativeProg() {
      var l = document.documentElement.scrollHeight - window.innerHeight;
      window.__progress = l > 0 ? window.scrollY / l : 0;
    }
    window.addEventListener('scroll', nativeProg, { passive: true });
    window.addEventListener('resize', nativeProg);
    nativeProg();
  }

  // Smooth anchor navigation (works in both modes)
  window.__scrollTo = function (el) {
    if (!el) return;
    var top = enabled ? (el.getBoundingClientRect().top + current) : (el.getBoundingClientRect().top + window.scrollY);
    window.scrollTo({ top: top, behavior: 'smooth' });
  };
})();
