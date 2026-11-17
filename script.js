/* ---------- Pure logic: song time -> state, and board geometry ----------
   No DOM access in this block. In a browser it is window.HSLogic.
   In node it is exported with module.exports, so it can be tested without a browser. */
(function (root) {
  'use strict';

  var CFG = {
    land: 0.9,            // s, sticker drop
    move: 1.0,            // s, focus -> slot
    dropPx: 110,          // start height of the drop
    dropRot: 7,           // deg, extra tilt at the start of the drop
    dropScale: 0.06,      // extra scale at the start of the drop
    fadeOut: 1.2,         // s, caption fade at the end of its slot
    fadeInReduced: 0.6,   // s, whole-caption fade in under reduced motion
    maxWrite: 11,         // s, cap on the write time
    perChar: 0.058,       // s per character
    perCharSignoff: 0.12, // s per letter, photo 13
    commaPause: 4,        // pauses are in "letter units" and come out of the write budget
    stopPause: 10,
    popDelay: 0.25,       // s after the last letter
    pop: 0.5,             // s, the cherry pop
    noteLines: 8,         // the caption box is always this many lines tall
    lineHeight: 1.3,
    notePadY: 22,         // px, top and bottom
    noteMaxW: 480,
    fontMax: 34,
    fontMin: 20
  };

  var CLOSERS = [')', '”', '"'];
  var POP_RE = /\p{Extended_Pictographic}/u;

  var TILT = [-2.5, 2, -1.5, 3, -3, 1.5, -2, 2.5, -1, 3, -2.5, 2, -1.5];    // focus tilt, deg
  var SLOT_ROT = [-8, 6, -4, 9, 5, -7, 3, -9, 7, -5, 4, -6];                // slot tilt, deg
  // Slots 0-5 top row, 6-8 left column, 9-11 right column. Photo k uses SLOT_ORDER[k].
  var SLOT_ORDER = [6, 9, 1, 4, 8, 11, 0, 5, 7, 10, 2, 3];

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function easeOutCubic(u) { var v = 1 - u; return 1 - v * v * v; }
  function easeInOutCubic(u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function easeOutBack(u, s) { var v = u - 1; return 1 + (s + 1) * v * v * v + s * v * v; }

  // ----- which photo -----

  // Last photo whose cue is <= t. -1 before the first cue.
  function activeIndex(cues, t) {
    var a = -1;
    for (var i = 0; i < cues.length; i++) {
      if (cues[i] <= t) a = i; else break;
    }
    return a;
  }

  // Length of photo i's slot in seconds. The last photo has no end yet (Phase 3 adds the transition).
  function slotLength(cues, i) {
    return i + 1 < cues.length ? cues[i + 1] - cues[i] : Infinity;
  }

  function stickerSide(k) { return k % 2 === 0 ? 'left' : 'right'; }   // odd photo numbers on the left
  function noteSide(k) { return k % 2 === 0 ? 'right' : 'left'; }

  // ----- handwriting -----

  function pauseFor(ch) {
    if (ch === ',') return CFG.commaPause;
    if (ch === '.' || ch === '!' || ch === '?') return CFG.stopPause;
    return 0;
  }

  // Reveal time (s after the cue) of every character. Emoji pop in last, after the letters.
  function writeSchedule(text, signoff) {
    var chars = Array.from(text);
    var pop = chars.map(function (c) { return POP_RE.test(c); });
    var normalCount = 0;
    for (var n = 0; n < chars.length; n++) if (!pop[n]) normalCount++;

    var raw = [];
    var pos = 0, defer = 0, last = 0;
    for (var i = 0; i < chars.length; i++) {
      if (pop[i]) continue;
      var ch = chars[i];
      raw[i] = pos;
      last = pos;
      pos += 1;
      if (CLOSERS.indexOf(ch) >= 0) { pos += defer; defer = 0; }
      var p = pauseFor(ch);
      if (p) {
        var next = chars[i + 1];
        if (next !== undefined && CLOSERS.indexOf(next) >= 0) defer = Math.max(defer, p);
        else pos += p;
      }
    }

    var write = Math.min(CFG.maxWrite, normalCount * (signoff ? CFG.perCharSignoff : CFG.perChar));
    var popStart = write + CFG.popDelay;
    var times = chars.map(function (c, j) {
      if (pop[j]) return popStart;
      return last > 0 ? raw[j] / last * write : 0;
    });
    var hasPop = normalCount < chars.length;
    return {
      chars: chars,
      pop: pop,
      times: times,
      normalCount: normalCount,
      writeEnd: write,
      popStart: hasPop ? popStart : null,
      total: hasPop ? popStart + CFG.pop : write
    };
  }

  // How many non-emoji characters are written dt seconds after the cue.
  function lettersWritten(sched, dt, reduced) {
    if (reduced) return sched.normalCount;
    var n = 0;
    for (var i = 0; i < sched.chars.length; i++) {
      if (sched.pop[i]) continue;
      if (sched.times[i] <= dt) n++; else break;
    }
    return n;
  }

  function popProgress(sched, dt, reduced) {
    if (sched.popStart === null || reduced) return 1;
    return clamp((dt - sched.popStart) / CFG.pop, 0, 1);
  }

  function popPose(p) {
    return { scale: p <= 0 ? 0 : easeOutBack(p, 2.4), opacity: clamp(p * 4, 0, 1) };
  }

  // Whole-caption opacity: fades out over the last 1.2 s of the slot.
  function captionOpacity(dt, slotLen, reduced) {
    var out = isFinite(slotLen) ? clamp((slotLen - dt) / CFG.fadeOut, 0, 1) : 1;
    var inn = reduced ? clamp(dt / CFG.fadeInReduced, 0, 1) : 1;
    return inn * out;
  }

  // ----- stickers -----

  function stickerPhase(k, cues, t, reduced) {
    var c = cues[k];
    if (!(t >= c)) return { phase: 'hidden', u: 0 };
    var land = reduced ? 0 : CFG.land;
    var move = reduced ? 0 : CFG.move;
    var next = k + 1 < cues.length ? cues[k + 1] : Infinity;
    if (t < c + land) return { phase: 'landing', u: (t - c) / land };
    if (t < next) return { phase: 'focus', u: 1 };
    if (t < next + move) return { phase: 'moving', u: (t - next) / move };
    return { phase: 'slot', u: 1 };
  }

  function focusPose(k, L) {
    var c = L.stickerCenters[stickerSide(k)];
    return { x: c.x, y: c.y, r: TILT[k % TILT.length], s: 1 };
  }

  function slotPose(k, L, size) {
    var sl = L.slots[k];
    if (!sl) return null;
    return { x: sl.x, y: sl.y, r: sl.r, s: Math.min(1, L.slotSize / Math.max(size.w, size.h)) };
  }

  // Pose of sticker k: centre x,y (board px), rotation r (deg), scale s, opacity o.
  function poseAt(k, ph, L, size) {
    var f = focusPose(k, L);
    if (ph.phase === 'hidden') return { visible: false, x: f.x, y: f.y, r: f.r, s: 1, o: 0 };
    if (ph.phase === 'landing') {
      var e = easeOutBack(ph.u, 1.2);
      var c = easeOutCubic(ph.u);
      var dir = k % 2 === 0 ? 1 : -1;
      return {
        visible: true,
        x: f.x,
        y: f.y - CFG.dropPx * (1 - e),
        r: f.r + dir * CFG.dropRot * (1 - c),
        s: 1 + CFG.dropScale * (1 - c),
        o: clamp(ph.u / 0.25, 0, 1)
      };
    }
    var sl = slotPose(k, L, size);
    if (ph.phase === 'slot' && sl) return { visible: true, x: sl.x, y: sl.y, r: sl.r, s: sl.s, o: 1 };
    if (ph.phase === 'moving' && sl) {
      var m = easeInOutCubic(ph.u);
      return {
        visible: true,
        x: lerp(f.x, sl.x, m), y: lerp(f.y, sl.y, m),
        r: lerp(f.r, sl.r, m), s: lerp(1, sl.s, m), o: 1
      };
    }
    return { visible: true, x: f.x, y: f.y, r: f.r, s: 1, o: 1 };
  }

  function transformString(p, size) {
    return 'translate(' + (p.x - size.w / 2).toFixed(2) + 'px,' + (p.y - size.h / 2).toFixed(2) + 'px) ' +
      'rotate(' + p.r.toFixed(2) + 'deg) scale(' + p.s.toFixed(4) + ')';
  }

  function noteTransform(k, L) {
    var c = L.noteCenters[noteSide(k)];
    var tilt = k % 2 === 0 ? 0.8 : -0.8;
    return 'translate(' + (c.x - L.note.w / 2).toFixed(2) + 'px,' + (c.y - L.note.h / 2).toFixed(2) + 'px) ' +
      'rotate(' + tilt + 'deg)';
  }

  // ----- board geometry -----
  // W, H: board size in px (the viewport minus the mini player). vh: viewport height, for the 60vh sticker cap.
  // The focus zone is the board minus a top band and two side bands. All 12 slots sit in those bands.

  function computeLayout(W, H, vh) {
    var slot = clamp(Math.min(W * 0.097, H * 0.175), 88, 150);
    var m = slot * 1.2;                       // room for a slot box turned by up to 10 deg
    var F = { x: m, y: m, w: W - 2 * m, h: H - m };
    var half = F.w / 2;
    var gap = 24;
    var cy = F.y + F.h / 2;
    var cxL = F.x + half / 2;
    var cxR = F.x + half * 1.5;

    var padY = CFG.notePadY;
    var fsW = clamp(W * CFG.fontMax / 1440, CFG.fontMin, CFG.fontMax);
    var fsH = (F.h - 16 - 2 * padY) / (CFG.noteLines * CFG.lineHeight);
    var fs = Math.max(CFG.fontMin * 0.6, Math.min(fsW, fsH));

    var raw = [];
    var i;
    for (i = 0; i < 6; i++) raw.push({ x: W * (i + 0.5) / 6, y: m / 2 });
    for (i = 0; i < 3; i++) raw.push({ x: m / 2, y: F.y + F.h * (i + 0.5) / 3 });
    for (i = 0; i < 3; i++) raw.push({ x: W - m / 2, y: F.y + F.h * (i + 0.5) / 3 });

    return {
      w: W, h: H,
      slotSize: slot,
      margin: m,
      focus: F,
      stickerBox: { w: half - 2 * gap, h: Math.min(F.h - 2 * gap, 0.6 * vh) },
      stickerCenters: { left: { x: cxL, y: cy }, right: { x: cxR, y: cy } },
      note: {
        w: Math.min(CFG.noteMaxW, half - 2 * gap),
        h: CFG.noteLines * CFG.lineHeight * fs + 2 * padY,
        fs: fs
      },
      noteCenters: { left: { x: cxL, y: cy }, right: { x: cxR, y: cy } },
      slots: SLOT_ORDER.map(function (ri, k) { return { x: raw[ri].x, y: raw[ri].y, r: SLOT_ROT[k] }; })
    };
  }

  var Logic = {
    CFG: CFG,
    activeIndex: activeIndex,
    slotLength: slotLength,
    stickerSide: stickerSide,
    noteSide: noteSide,
    writeSchedule: writeSchedule,
    lettersWritten: lettersWritten,
    popProgress: popProgress,
    popPose: popPose,
    captionOpacity: captionOpacity,
    stickerPhase: stickerPhase,
    poseAt: poseAt,
    transformString: transformString,
    noteTransform: noteTransform,
    computeLayout: computeLayout
  };

  root.HSLogic = Logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
})(typeof window !== 'undefined' ? window : globalThis);

(function () {
  'use strict';

  if (typeof document === 'undefined') return; // loaded in node for tests: logic only

  var Logic = window.HSLogic;
  var SITE = window.SITE;
  var LOAD_DEADLINE_MS = 8000;

  function $(id) { return document.getElementById(id); }

  var els = {
    screen:    $('cassette-screen'),
    cassette:  $('cassette'),
    playArea:  $('play-area'),
    playBtn:   $('play-btn'),
    status:    $('load-status'),
    mini:      $('mini-player'),
    miniIcon:  $('mini-cassette'),
    toggle:    $('mini-toggle'),
    seek:      $('mini-seek'),
    seekFill:  $('seek-fill'),
    time:      $('mini-time'),
    board:     $('board'),
    caption:   $('caption'),
    captionText: $('caption-text')
  };

  var state = {
    ready: false,
    started: false,
    dragging: false,
    loadStart: performance.now(),
    lastTimeText: '',
    lastPlaying: null
  };

  function noop() {}

  // ---------- Content from data.js ----------

  var song = SITE.songs.main;
  $('cassette-title').textContent = song.title;
  $('cassette-artist').textContent = song.artist;
  $('mini-title').textContent = song.title;
  $('mini-artist').textContent = song.artist;

  // ---------- Audio (song 1) ----------

  var audio = new Audio();
  audio.preload = 'auto';

  // ---------- Preloading ----------

  var preloadedImages = [];

  function preloadImage(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.decoding = 'async';
      img.src = url;
      preloadedImages.push(img);
      if (img.decode) {
        img.decode().then(resolve, resolve); // a missing image must not block PLAY
      } else {
        img.onload = resolve;
        img.onerror = resolve;
      }
    });
  }

  function preloadAudio() {
    return new Promise(function (resolve) {
      audio.addEventListener('canplaythrough', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      audio.src = song.src;
      audio.load();
    });
  }

  function enablePlay() {
    if (state.ready) return;
    state.ready = true;
    els.playBtn.disabled = false;
    els.status.textContent = '';
  }

  Promise.all(SITE.photos.map(function (p) { return preloadImage(p.file); }).concat(preloadAudio()))
    .then(enablePlay);

  // ---------- PLAY: song starts inside the click, cassette docks into the mini player ----------

  function startPlayback() {
    var p = audio.play();
    if (p && p.catch) p.catch(noop); // blocked or missing file: the mini player's play button is the fallback
  }

  function dockCassette() {
    els.playBtn.disabled = true;
    els.playArea.classList.add('is-leaving');

    els.mini.removeAttribute('inert');
    els.mini.classList.add('is-visible');

    var from = els.cassette.getBoundingClientRect();
    var to = els.miniIcon.getBoundingClientRect();
    els.cassette.style.setProperty('--dx', (to.left + to.width / 2 - (from.left + from.width / 2)) + 'px');
    els.cassette.style.setProperty('--dy', (to.top + to.height / 2 - (from.top + from.height / 2)) + 'px');
    els.cassette.style.setProperty('--s', String(to.width / from.width));
    els.cassette.classList.add('is-docking');

    els.toggle.focus({ preventScroll: true });
  }

  els.cassette.addEventListener('transitionend', function (e) {
    if (e.target === els.cassette && e.propertyName === 'opacity') {
      els.screen.classList.add('is-gone');
    }
  });

  els.playBtn.addEventListener('click', function () {
    if (!state.ready || state.started) return;
    state.started = true;
    startPlayback();
    dockCassette();
  });

  // ---------- Mini player controls ----------

  els.toggle.addEventListener('click', function () {
    if (audio.paused || audio.error) {
      startPlayback();
    } else {
      audio.pause();
    }
  });

  function seekFromInput() {
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    audio.currentTime = (parseFloat(els.seek.value) / 1000) * d;
  }

  els.seek.addEventListener('input', seekFromInput);
  els.seek.addEventListener('pointerdown', function () { state.dragging = true; });
  window.addEventListener('pointerup', function () { state.dragging = false; });
  window.addEventListener('pointercancel', function () { state.dragging = false; });

  // ---------- Time formatting ----------

  function fmt(s) {
    if (!isFinite(s) || s < 0) return '--:--';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // ---------- Collage board (Phase 2) ----------
  // Everything here is drawn from t. Nothing is started by an event, so pause freezes it
  // and a seek never replays a landing.

  var photos = SITE.photos;
  var cues = photos.map(function (p) { return p.cue; });
  var schedules = photos.map(function (p, i) {
    return Logic.writeSchedule(p.caption, i === photos.length - 1);
  });

  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = !!(motionQuery && motionQuery.matches);
  if (motionQuery && motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function (e) { reduced = e.matches; });
  }

  var layout = null;

  // Stickers: one element per photo, placed with transform only
  var stickers = photos.map(function (p, k) {
    var el = document.createElement('div');
    el.className = 'sticker' + (k % 2 ? ' tape-pink' : '');
    el.style.zIndex = String(k + 1);

    var img = new Image();
    var st = { el: el, img: img, size: null, key: '' };
    img.addEventListener('load', function () { measure(st); }); // a late image is re-measured
    img.alt = p.title;
    img.draggable = false;
    img.decoding = 'async';
    img.src = p.file;

    el.appendChild(img);
    els.board.insertBefore(el, els.caption);
    return st;
  });

  // The sticker's size at its focus pose: the image's own box after max-width, max-height and its
  // aspect ratio. Layout size, so it ignores transforms. The wrapper is given exactly that size,
  // so the tape and the rotation centre sit on the image whatever its shape.
  function measure(st) {
    if (!layout) return;
    var w = st.img.offsetWidth, h = st.img.offsetHeight;
    if (!w || !h) { w = layout.stickerBox.w; h = layout.stickerBox.h; } // image missing: keep the page alive
    st.el.style.width = w + 'px';
    st.el.style.height = h + 'px';
    st.size = { w: w, h: h };
    st.key = '';
  }

  function applyLayout() {
    var r = els.board.getBoundingClientRect();
    layout = Logic.computeLayout(r.width, r.height, window.innerHeight);
    var s = els.board.style;
    s.setProperty('--st-w', layout.stickerBox.w + 'px');
    s.setProperty('--st-h', layout.stickerBox.h + 'px');
    s.setProperty('--cap-w', layout.note.w + 'px');
    s.setProperty('--cap-h', layout.note.h + 'px');
    s.setProperty('--cap-fs', layout.note.fs + 'px');
    stickers.forEach(measure);
    placeCaption();
  }

  function renderStickers(t) {
    for (var k = 0; k < stickers.length; k++) {
      var st = stickers[k];
      var ph = Logic.stickerPhase(k, cues, t, reduced);
      var animating = ph.phase === 'landing' || ph.phase === 'moving';
      var key = animating ? ph.phase + ph.u.toFixed(4) : ph.phase;
      if (key === st.key) continue; // settled stickers are not touched again
      st.key = key;
      var pose = Logic.poseAt(k, ph, layout, st.size);
      var s = st.el.style;
      s.visibility = pose.visible ? 'visible' : 'hidden';
      s.opacity = String(pose.o);
      s.transform = Logic.transformString(pose, st.size);
    }
  }

  // Caption: the full text is laid out once, as one span per character. Unwritten letters are
  // transparent, so nothing reflows. The box has a fixed height from layout.
  var cap = { index: -2, count: 0, spans: [], pops: [], popKey: '', opacity: -1 };

  function buildCaption(idx) {
    cap.index = idx;
    cap.count = 0;
    cap.spans = [];
    cap.pops = [];
    cap.popKey = '';
    els.captionText.textContent = '';
    els.caption.classList.toggle('is-signoff', idx === photos.length - 1);
    if (idx < 0) return;

    var sched = schedules[idx];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < sched.chars.length; i++) {
      var span = document.createElement('span');
      span.textContent = sched.chars[i];
      if (sched.pop[i]) { span.className = 'ch-pop'; cap.pops.push(span); }
      else { span.className = 'ch'; cap.spans.push(span); }
      frag.appendChild(span);
    }
    els.captionText.appendChild(frag);
    placeCaption();
  }

  function placeCaption() {
    if (!layout || cap.index < 0) return;
    els.caption.style.transform = Logic.noteTransform(cap.index, layout);
  }

  function setWritten(n) {
    var i;
    if (n === cap.count) return;
    if (n > cap.count) for (i = cap.count; i < n; i++) cap.spans[i].classList.add('on');
    else for (i = n; i < cap.count; i++) cap.spans[i].classList.remove('on');
    cap.count = n;
  }

  function setPop(p) {
    var key = p.toFixed(3);
    if (key === cap.popKey) return;
    cap.popKey = key;
    var pose = Logic.popPose(p);
    for (var i = 0; i < cap.pops.length; i++) {
      cap.pops[i].style.opacity = String(pose.opacity);
      cap.pops[i].style.transform = 'scale(' + pose.scale.toFixed(3) + ')';
    }
  }

  function renderCaption(t) {
    var idx = Logic.activeIndex(cues, t);
    if (idx !== cap.index) buildCaption(idx);

    var op = 0;
    if (idx >= 0) {
      var dt = t - cues[idx];
      var sched = schedules[idx];
      setWritten(Logic.lettersWritten(sched, dt, reduced));
      setPop(Logic.popProgress(sched, dt, reduced));
      op = Logic.captionOpacity(dt, Logic.slotLength(cues, idx), reduced);
    }
    if (op !== cap.opacity) {
      cap.opacity = op;
      els.caption.style.opacity = String(op);
    }
  }

  function renderCollage(t) {
    renderStickers(t);
    renderCaption(t);
  }

  applyLayout();
  window.addEventListener('resize', applyLayout);

  // ---------- render(t): pure function of song 1 time ----------
  // Phase 2: the mini player's progress plus the collage (stickers and captions).
  // The transition and the letter come later.

  function render(t) {
    var d = audio.duration;
    var known = isFinite(d) && d > 0;
    var p = known ? Math.min(1, Math.max(0, t / d)) : 0;

    els.seekFill.style.transform = 'scaleX(' + p + ')';
    if (!state.dragging) els.seek.value = String(p * 1000);

    var text = fmt(t) + ' / ' + (known ? fmt(d) : '--:--');
    if (text !== state.lastTimeText) {
      state.lastTimeText = text;
      els.time.textContent = text;
      els.seek.setAttribute('aria-valuetext', text);
    }

    renderCollage(t);
  }

  // Reels and the play/pause icon follow the real audio state
  function syncPlayState() {
    var playing = !audio.paused && !audio.error;
    if (playing === state.lastPlaying) return;
    state.lastPlaying = playing;
    document.body.classList.toggle('is-playing', playing);
    els.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // ---------- The single clock ----------

  function tick() {
    if (!state.ready && performance.now() - state.loadStart > LOAD_DEADLINE_MS) enablePlay();
    syncPlayState();
    render(audio.currentTime);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
