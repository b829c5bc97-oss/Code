(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  document.getElementById('year').textContent = new Date().getFullYear();

  /* ---------- Split text into words / lines ---------- */
  function splitWords(el) {
    var words = el.textContent.trim().split(/\s+/);
    el.textContent = '';
    words.forEach(function (word, i) {
      var w = document.createElement('span'); w.className = 'w';
      var inner = document.createElement('i'); inner.textContent = word;
      inner.style.transitionDelay = (i * 0.06) + 's';
      w.appendChild(inner); el.appendChild(w);
      el.appendChild(document.createTextNode(' '));
    });
  }
  function splitLines(el) {
    // wrap each existing childNode text into lines by words, grouped visually via inline spans
    var html = el.innerHTML;
    el.innerHTML = '';
    var tmp = document.createElement('div'); tmp.innerHTML = html;
    var frag = document.createElement('span');
    // simple approach: one animated block (still clipped) — reliable across content
    var line = document.createElement('span'); line.className = 'l';
    var span = document.createElement('span'); span.innerHTML = html;
    line.appendChild(span); el.appendChild(line);
  }
  document.querySelectorAll('.split').forEach(splitWords);
  document.querySelectorAll('.split-lines').forEach(splitLines);

  /* ---------- Preloader ---------- */
  var pre = document.getElementById('preloader');
  var num = document.getElementById('pre-num');
  var n = 0;
  var timer = setInterval(function () {
    n += Math.floor(Math.random() * 8) + 3;
    if (n >= 100) { n = 100; clearInterval(timer); finish(); }
    num.textContent = n;
  }, 90);

  function finish() {
    setTimeout(function () {
      pre.classList.add('done');
      // trigger hero animations
      document.querySelectorAll('.split, .split-lines').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight) el.classList.add('in');
      });
      revealCheck();
    }, 450);
  }

  /* ---------- Custom cursor ---------- */
  if (canHover) {
    var dot = document.getElementById('cursor-dot');
    var ring = document.getElementById('cursor-ring');
    var rx = 0, ry = 0, dx = 0, dy = 0;
    window.addEventListener('mousemove', function (e) {
      dx = e.clientX; dy = e.clientY;
      dot.style.transform = 'translate(' + dx + 'px,' + dy + 'px) translate(-50%,-50%)';
    }, { passive: true });
    (function ringLoop() {
      requestAnimationFrame(ringLoop);
      rx += (dx - rx) * 0.18; ry += (dy - ry) * 0.18;
      ring.style.transform = 'translate(' + rx + 'px,' + ry + 'px) translate(-50%,-50%)';
    })();
    document.querySelectorAll('[data-cursor]').forEach(function (el) {
      var type = el.getAttribute('data-cursor');
      el.addEventListener('mouseenter', function () { ring.classList.add(type === 'view' ? 'view' : 'hover'); });
      el.addEventListener('mouseleave', function () { ring.classList.remove('hover', 'view'); });
    });
  }

  /* ---------- Magnetic buttons ---------- */
  if (canHover && !reduce) {
    document.querySelectorAll('.magnetic').forEach(function (btn) {
      var span = btn.querySelector('span') || btn;
      btn.addEventListener('mousemove', function (e) {
        var r = btn.getBoundingClientRect();
        var x = e.clientX - r.left - r.width / 2;
        var y = e.clientY - r.top - r.height / 2;
        btn.style.transform = 'translate(' + x * 0.3 + 'px,' + y * 0.3 + 'px)';
        span.style.transform = 'translate(' + x * 0.15 + 'px,' + y * 0.15 + 'px)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.transform = ''; span.style.transform = '';
      });
    });
  }

  /* ---------- Menu ---------- */
  var menuBtn = document.getElementById('menu-btn');
  var menu = document.getElementById('menu');
  var menuLinks = menu.querySelectorAll('.menu-links a');
  menuLinks.forEach(function (a, i) { a.style.transitionDelay = (0.1 + i * 0.06) + 's'; });
  function toggleMenu(force) {
    var open = force !== undefined ? force : !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    menuBtn.classList.toggle('open', open);
  }
  menuBtn.addEventListener('click', function () { toggleMenu(); });

  /* ---------- Anchor smooth nav ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (id.length < 2) return;
      var t = document.querySelector(id);
      if (!t) return;
      e.preventDefault();
      toggleMenu(false);
      if (window.__scrollTo) window.__scrollTo(t);
      else t.scrollIntoView({ behavior: 'smooth' });
    });
  });

  /* ---------- Reveals + horizontal gallery (rAF, reads transformed rects) ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var splitEls = Array.prototype.slice.call(document.querySelectorAll('.split, .split-lines'));
  var hSection = document.querySelector('.h-scroll');
  var hTrack = document.getElementById('h-track');
  var isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;

  function revealCheck() {
    var vh = window.innerHeight;
    revealEls = revealEls.filter(function (el) {
      if (el.getBoundingClientRect().top < vh * 0.86) { el.classList.add('in'); return false; }
      return true;
    });
    splitEls = splitEls.filter(function (el) {
      if (el.getBoundingClientRect().top < vh * 0.9) { el.classList.add('in'); return false; }
      return true;
    });
  }

  function frame() {
    requestAnimationFrame(frame);
    revealCheck();

    // pinned horizontal gallery (desktop only; mobile uses native overflow)
    if (hSection && hTrack && !isTouch && window.innerWidth > 860) {
      var rect = hSection.getBoundingClientRect();
      var total = hSection.offsetHeight - window.innerHeight;
      if (total > 0) {
        var passed = Math.min(Math.max(-rect.top, 0), total);
        var p = passed / total;
        var dist = hTrack.scrollWidth - window.innerWidth + 68;
        hTrack.style.transform = 'translate3d(' + (-p * Math.max(dist, 0)) + 'px,0,0)';
      }
    }
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', revealCheck);
})();
