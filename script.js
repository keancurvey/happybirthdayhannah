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

  // Length of photo i's slot in seconds. The last photo has no fixed length here: the transition ends it.
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

  // ----- Phase 4: stacked layout for narrow screens -----
  // Used when the board is STACK.maxW px wide or less (phones, and tablets in portrait). The sticker sits
  // above the caption and the pile is one strip of 12 thumbnails along the top. It returns the same shape
  // as computeLayout, so the rest of the engine does not care which one it got. computeLayout is not touched.

  var STACK = {
    maxW: 820,
    noteLines: 7,     // longest caption is 5 lines at 360 px wide, so there are 2 spare lines
    noteMaxW: 560,
    fontMin: 17,
    tape: 12          // the tape piece sticks out above the sticker
  };

  function isStacked(W) { return W <= STACK.maxW; }

  function computeStackedLayout(W, H, vh) {
    var pad = clamp(W * 0.04, 12, 32);
    var slot = clamp(W * 0.11, 34, 56);
    var stripH = 8 + slot * 1.2;                // top gap + a slot box turned by up to 10 deg
    var gap = 10;
    var F = { x: pad, y: stripH + gap, w: W - 2 * pad, h: H - stripH - 2 * gap };

    var padY = CFG.notePadY;
    var fsW = clamp(W * 0.058, 19, 30);
    var minSticker = clamp(F.h * 0.4, 130, 400);   // short screens give up some caption size before the sticker shrinks
    var fsH = (F.h - minSticker - gap - 2 * padY) / (STACK.noteLines * CFG.lineHeight);
    var fs = Math.max(STACK.fontMin, Math.min(fsW, fsH));
    var noteW = Math.min(STACK.noteMaxW, F.w);
    var noteH = STACK.noteLines * CFG.lineHeight * fs + 2 * padY;

    var tilt = (F.w - 8) / 2 * Math.sin(3 * Math.PI / 180);   // a full-width sticker turned by 3 deg grows this much
    var avail = F.h - noteH - gap - STACK.tape - tilt;        // room above the note, below the tape allowance
    var stickerH = Math.max(60, Math.min(avail, 0.6 * vh));
    var cx = W / 2;
    var stickerCy = F.y + STACK.tape + avail / 2;
    var noteCy = F.y + F.h - noteH / 2;

    var slots = [];
    var span = W - 2 * pad - slot;               // thumbnails overlap when the strip is narrower than 12 slots
    var slotY = 8 + slot * 0.6;
    for (var k = 0; k < 12; k++) {
      slots.push({ x: pad + slot / 2 + span * k / 11, y: slotY, r: SLOT_ROT[k] });
    }

    return {
      w: W, h: H,
      slotSize: slot,
      margin: stripH,
      focus: F,
      stickerBox: { w: F.w - 8, h: stickerH },
      stickerCenters: { left: { x: cx, y: stickerCy }, right: { x: cx, y: stickerCy } },
      note: { w: noteW, h: noteH, fs: fs },
      noteCenters: { left: { x: cx, y: noteCy }, right: { x: cx, y: noteCy } },
      slots: slots
    };
  }

  // Scale for the 520 px wide envelope scene so that it fits a W x H box. 1 whenever it already fits
  // (desktop, most tablets). The envelope, its open flap and the Read more button are 540 px of height
  // at scale 1 plus 65 px that do not scale, and 2 x 20 px are kept free at the edges.
  function envScale(W, H) {
    return clamp(Math.min((W - 24) / 520, (H - 105) / 540), 0.3, 1);
  }

  // ----- Phase 3: end-of-song transition -----
  // Pure functions of t (song 1 time, s) and D (song 1 duration, s). No DOM, no clock.
  // Seconds before the end:  24 photo 13's slot ends and the sign-off lingers
  //                          19.2 to 18 the sign-off caption fades (finished by 18)
  //                          18 to 16 the board settles (photo 13 tucks toward the centre)
  //                          16 the envelope slides in      8 it becomes tappable
  //                          6 to 0 song 1 volume eases to 0

  var TR = {
    slotEnd: 24,
    captionGone: 18,     // the caption has finished fading this long before the end
    settleFrom: 18,
    settleTo: 16,
    envelopeAt: 16,
    slideDur: 2.5,       // s, envelope slide-in
    tappableAt: 8,
    volumeFrom: 6,
    settleScale: 0.6,    // photo 13 shrinks to this while it tucks toward the centre
    reducedFade: 0.6     // s, envelope fade-in under reduced motion
  };

  // After the envelope tap: the clock is song 2's time T (s since song 2 started)
  var LT = {
    flapAt: 0.2, flapDur: 0.9,     // the flap flips open
    riseAt: 1.1, riseDur: 1.3,     // the folded paper rises
    writeAt: 2.6,                  // the preview starts writing
    readMoreAt: 2.8, readMoreFade: 0.5
  };

  // D from the audio, or from the cues when the duration is unavailable:
  // last cue + the last cue spacing + fromEnd (226 + 18 + 24 = 268 for the plan's cues).
  function effectiveDuration(d, cues, fromEnd) {
    if (isFinite(d) && d > 0) return d;
    var n = cues.length;
    if (!n) return fromEnd;
    var last = cues[n - 1];
    var step = n > 1 ? last - cues[n - 2] : 0;
    return last + step + fromEnd;
  }

  // Opacity of the last caption (the sign-off). 1 until it starts to fade, 0 once it has faded.
  function captionFade(t, D) {
    return clamp((D - TR.captionGone - t) / CFG.fadeOut, 0, 1);
  }

  // 0..1, how far the board has settled. Reduced motion: a step, no movement.
  function settleProgress(t, D, reduced) {
    var from = D - TR.settleFrom;
    if (reduced) return t >= from ? 1 : 0;
    return clamp((t - from) / (TR.settleFrom - TR.settleTo), 0, 1);
  }

  // Envelope before the tap. offset is the share of the slide-in travel still to go (1 to 0).
  function envelopeState(t, D, reduced) {
    var at = D - TR.envelopeAt;
    var visible = t >= at;
    var u = clamp((t - at) / TR.slideDur, 0, 1);
    var opacity = 0;
    if (visible) opacity = reduced ? clamp((t - at) / TR.reducedFade, 0, 1) : clamp(u / 0.4, 0, 1);
    return {
      visible: visible,
      slide: u,
      offset: reduced ? 0 : 1 - easeOutCubic(u),
      opacity: opacity,
      tappable: t >= D - TR.tappableAt
    };
  }

  // Song 1 volume: 1 until D - 6, then a smooth ease down to 0 at D.
  function volumeAt(t, D) {
    var u = clamp((t - (D - TR.volumeFrom)) / TR.volumeFrom, 0, 1);
    return 0.5 * (1 + Math.cos(Math.PI * u));
  }

  // Everything the transition does at time t. slotEnd is data.js transition.fromEnd.
  function transitionState(t, D, reduced, slotEnd) {
    var se = slotEnd === undefined ? TR.slotEnd : slotEnd;
    var stage = 'tappable';
    if (t < D - se) stage = 'collage';
    else if (t < D - TR.captionGone - CFG.fadeOut) stage = 'signoff';
    else if (t < D - TR.settleFrom) stage = 'caption-fade';
    else if (t < D - TR.envelopeAt) stage = 'settle';
    else if (t < D - TR.tappableAt) stage = 'envelope';
    return {
      stage: stage,
      slotEnded: t >= D - se,
      captionOpacity: captionFade(t, D),
      settle: settleProgress(t, D, reduced),
      envelope: envelopeState(t, D, reduced),
      volume: volumeAt(t, D)
    };
  }

  // Photo 13 has no pile slot. While the board settles it drifts to the board centre, shrinks and fades.
  function settlePose(p, L, u) {
    if (!(u > 0)) return p;
    var e = easeInOutCubic(u);
    return {
      visible: p.visible,
      x: lerp(p.x, L.w / 2, e),
      y: lerp(p.y, L.h / 2, e),
      r: lerp(p.r, 0, e),
      s: lerp(p.s, p.s * TR.settleScale, e),
      o: p.o * (1 - e)
    };
  }

  // Envelope opening and the preview, from song 2's time T.
  function letterState(T, reduced) {
    var wa = reduced ? 0 : LT.writeAt;
    var rm = reduced ? CFG.fadeInReduced : LT.readMoreAt;
    return {
      flap: reduced ? (T >= 0 ? 1 : 0) : easeInOutCubic(clamp((T - LT.flapAt) / LT.flapDur, 0, 1)),
      rise: reduced ? (T >= 0 ? 1 : 0) : easeOutCubic(clamp((T - LT.riseAt) / LT.riseDur, 0, 1)),
      writeDt: T - wa,
      previewOpacity: reduced ? clamp((T - wa) / CFG.fadeInReduced, 0, 1) : 1,
      readMore: clamp((T - rm) / LT.readMoreFade, 0, 1)
    };
  }

  var Logic = {
    CFG: CFG,
    TR: TR,
    LT: LT,
    effectiveDuration: effectiveDuration,
    captionFade: captionFade,
    settleProgress: settleProgress,
    envelopeState: envelopeState,
    volumeAt: volumeAt,
    transitionState: transitionState,
    settlePose: settlePose,
    letterState: letterState,
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
    computeLayout: computeLayout,
    STACK: STACK,
    isStacked: isStacked,
    computeStackedLayout: computeStackedLayout,
    envScale: envScale
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
  var SEEK_STEP = 5;         // s, one arrow key press on the progress bar

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
    captionText: $('caption-text'),
    scene:     $('letter-scene'),
    envSlide:  $('env-slide'),
    envWrap:   $('env-wrap'),
    envBtn:    $('envelope'),
    envClosed: $('env-flap'),
    envOpen:   $('env-flap-open'),
    envPaper:  $('env-paper'),
    envPreview: $('env-preview'),
    readMore:  $('read-more'),
    panel:     $('letter-panel'),
    panelClose: $('letter-close'),
    letterText: $('letter-text'),
    letterSign: $('letter-sign'),
    letterBody: $('letter-body'),
    replay:    $('replay')
  };

  var state = {
    ready: false,
    started: false,
    dragging: false,
    loadStart: performance.now(),
    lastTimeText: '',
    lastPlaying: null,
    tapped: false,         // envelope tapped: the clock is song 2's from now on
    song2Rejected: false   // song 2's play() was refused (missing file or blocked)
  };

  // ---------- Content from data.js ----------

  var song = SITE.songs.main;
  $('cassette-title').textContent = song.title;
  $('cassette-artist').textContent = song.artist;
  $('mini-title').textContent = song.title;
  $('mini-artist').textContent = song.artist;

  // ---------- Audio (song 1) ----------

  var audio = new Audio();
  audio.preload = 'auto';

  // Song 2 (the letter song). `active` is the audio the mini player controls: song 1 until the envelope tap.
  var song2 = SITE.songs.letter;
  var audio2 = new Audio();
  audio2.preload = 'auto';
  var active = audio;

  function loadSong2() {
    audio2.src = song2.src; // starts loading once the page is ready; a missing file only sets audio2.error
    audio2.load();
  }

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
    loadSong2();
  }

  Promise.all(SITE.photos.map(function (p) { return preloadImage(p.file); }).concat(preloadAudio()))
    .then(enablePlay);

  // ---------- PLAY: song starts inside the click, cassette docks into the mini player ----------

  function startPlayback() {
    var a = active;
    var p = a.play();
    if (p && p.then) {
      // blocked or missing file: nothing crashes, the mini player's play button is the fallback
      p.then(function () { if (a === audio2) state.song2Rejected = false; },
             function () { if (a === audio2) state.song2Rejected = true; });
    }
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
    if (active.paused || active.error) {
      startPlayback();
    } else {
      active.pause();
    }
  });

  function seekFromInput() {
    var d = active.duration;
    if (!isFinite(d) || d <= 0) return;
    active.currentTime = (parseFloat(els.seek.value) / 1000) * d;
  }

  els.seek.addEventListener('input', seekFromInput);

  // Arrow keys move by SEEK_STEP seconds. The native step is "any", which would move by a tiny fraction.
  els.seek.addEventListener('keydown', function (e) {
    var dir = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
    var d = active.duration;
    if (!dir || !isFinite(d) || d <= 0) return;
    e.preventDefault();
    active.currentTime = Math.min(d, Math.max(0, active.currentTime + dir * SEEK_STEP));
  });

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
    setSize(st, st.img.offsetWidth, st.img.offsetHeight);
  }

  function setSize(st, w, h) {
    if (!w || !h) { w = layout.stickerBox.w; h = layout.stickerBox.h; } // image missing: keep the page alive
    st.el.style.width = w + 'px';
    st.el.style.height = h + 'px';
    st.size = { w: w, h: h };
    st.key = '';
  }

  // Not called from render(). It runs once at start and again from the frame loop after a resize.
  // All the sizes are read first and written after, so it forces one layout, not one per sticker.
  function applyLayout() {
    var r = els.board.getBoundingClientRect();
    var narrow = Logic.isStacked(r.width);       // phones and tablet portrait: sticker above the caption
    layout = narrow
      ? Logic.computeStackedLayout(r.width, r.height, window.innerHeight)
      : Logic.computeLayout(r.width, r.height, window.innerHeight);
    var s = els.board.style;
    s.setProperty('--st-w', layout.stickerBox.w + 'px');
    s.setProperty('--st-h', layout.stickerBox.h + 'px');
    s.setProperty('--cap-w', layout.note.w + 'px');
    s.setProperty('--cap-h', layout.note.h + 'px');
    s.setProperty('--cap-fs', layout.note.fs + 'px');
    els.scene.style.setProperty('--env-s', Logic.envScale(r.width, r.height).toFixed(4)); // used by style.css at 1024px and below
    var sizes = stickers.map(function (st) { return [st.img.offsetWidth, st.img.offsetHeight]; });
    stickers.forEach(function (st, i) { setSize(st, sizes[i][0], sizes[i][1]); });
    placeCaption();
  }

  function renderStickers(t, settle) {
    for (var k = 0; k < stickers.length; k++) {
      var st = stickers[k];
      var ph = Logic.stickerPhase(k, cues, t, reduced);
      var animating = ph.phase === 'landing' || ph.phase === 'moving';
      var key = animating ? ph.phase + ph.u.toFixed(4) : ph.phase;
      var settling = k === stickers.length - 1 && settle > 0; // photo 13 has no slot: it tucks away as the board settles
      if (settling) key += 's' + settle.toFixed(4);
      if (key === st.key) continue; // settled stickers are not touched again
      st.key = key;
      var pose = Logic.poseAt(k, ph, layout, st.size);
      if (settling) pose = Logic.settlePose(pose, layout, settle);
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

  function renderCaption(t, tr) {
    var idx = Logic.activeIndex(cues, t);
    if (idx !== cap.index) buildCaption(idx);

    var op = 0;
    if (idx >= 0) {
      var dt = t - cues[idx];
      var sched = schedules[idx];
      setWritten(Logic.lettersWritten(sched, dt, reduced));
      setPop(Logic.popProgress(sched, dt, reduced));
      op = Logic.captionOpacity(dt, Logic.slotLength(cues, idx), reduced);
      if (idx === photos.length - 1) op *= tr.captionOpacity; // the sign-off stays until the transition fades it
    }
    if (op !== cap.opacity) {
      cap.opacity = op;
      els.caption.style.opacity = String(op);
    }
  }

  function renderCollage(t, tr) {
    renderStickers(t, tr.settle);
    renderCaption(t, tr);
  }

  applyLayout();

  // A resize only marks the layout dirty. The frame loop re-applies it once per frame at most.
  var layoutDirty = false;
  window.addEventListener('resize', function () { layoutDirty = true; });

  // ---------- Transition, envelope and letter (Phase 3) ----------

  var FADE_MS = 1500;        // song 1 fade-out after the envelope tap
  var PAPER_RISE = 170;      // px the folded paper rises out of the envelope (its bottom stays behind the pocket's V)
  var SLIDE_TRAVEL = 0.6;    // envelope slide-in starts this share of the board height below its place

  function songDuration() {
    return Logic.effectiveDuration(audio.duration, cues, SITE.transition.fromEnd);
  }

  // The collage clock. Before the tap it is song 1's time. If song 1 has ended it is at least D,
  // which reveals the envelope even if a cue was missed. After the tap the board is parked at D.
  function boardTime() {
    var D = songDuration();
    if (state.tapped) return D;
    var ct = audio.currentTime;
    return audio.ended ? Math.max(ct, D) : ct;
  }

  // ----- Song 1 volume: a pure function of t until the tap, then a short fade driven by the frame loop -----

  var vol = { last: -1, fade: null };

  function setSong1Volume(v) {
    if (v === vol.last) return;
    vol.last = v;
    audio.volume = v; // iPhone ignores this (the volume is read-only there), which is expected
  }

  function stepSong1Fade(now) {
    var f = vol.fade;
    if (!f) return;
    var u = Math.min(1, Math.max(0, (now - f.start) / FADE_MS));
    audio.volume = f.from * 0.5 * (1 + Math.cos(Math.PI * u));
    if (u >= 1) {
      audio.pause();
      vol.fade = null;
    }
  }

  // ----- Envelope (before the tap) -----

  var envView = { key: '', tappable: false };

  function renderEnvelope(e) {
    var key = (e.visible ? 1 : 0) + ':' + e.opacity.toFixed(3) + ':' + e.offset.toFixed(3);
    if (key !== envView.key) {
      envView.key = key;
      var s = els.envSlide.style;
      s.visibility = e.visible ? 'visible' : 'hidden';
      s.opacity = String(e.opacity);
      s.transform = 'translateY(' + (e.offset * layout.h * SLIDE_TRAVEL).toFixed(1) + 'px)';
    }
    var tappable = e.tappable && !state.tapped;
    if (tappable !== envView.tappable) {
      envView.tappable = tappable;
      els.envBtn.disabled = !tappable;
      els.envSlide.classList.toggle('is-tappable', tappable);
    }
  }

  // ----- Letter content, from data.js -----

  SITE.letter.paragraphs.forEach(function (text) {
    var para = document.createElement('p');
    para.textContent = text;
    els.letterText.appendChild(para);
  });
  els.letterSign.textContent = SITE.letter.signature;

  // The preview: the first paragraph, laid out in full with unwritten letters transparent (no reflow),
  // written by the same schedule as the captions. The box is 4 lines tall and fades out at the bottom.
  var preview = {
    sched: Logic.writeSchedule(SITE.letter.paragraphs[0] || '', false),
    spans: [], pops: [], count: 0, popKey: '', opacity: -1
  };

  (function buildPreview() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < preview.sched.chars.length; i++) {
      var span = document.createElement('span');
      span.textContent = preview.sched.chars[i];
      if (preview.sched.pop[i]) { span.className = 'ch-pop'; preview.pops.push(span); }
      else { span.className = 'ch'; preview.spans.push(span); }
      frag.appendChild(span);
    }
    els.envPreview.appendChild(frag);
  })();

  function setPreviewWritten(n) {
    var i;
    if (n === preview.count) return;
    if (n > preview.count) for (i = preview.count; i < n; i++) preview.spans[i].classList.add('on');
    else for (i = n; i < preview.count; i++) preview.spans[i].classList.remove('on');
    preview.count = n;
  }

  function setPreviewPop(p) {
    var key = p.toFixed(3);
    if (key === preview.popKey) return;
    preview.popKey = key;
    var pose = Logic.popPose(p);
    for (var i = 0; i < preview.pops.length; i++) {
      preview.pops[i].style.opacity = String(pose.opacity);
      preview.pops[i].style.transform = 'scale(' + pose.scale.toFixed(3) + ')';
    }
  }

  // ----- Letter clock: song 2's time -----
  // Follows song 2 (pause freezes it, seeking moves it). If song 2 cannot play (missing file or blocked),
  // it runs on the frame loop instead, so the letter still opens. If song 2 starts later, the clock
  // continues from where it was instead of jumping back.

  var lc = { t: 0, last: 0, offset: 0 };

  function letterTime(now) {
    var dt = Math.min(0.25, Math.max(0, (now - lc.last) / 1000));
    lc.last = now;
    if (!audio2.error && !state.song2Rejected) {
      lc.t = Math.max(0, audio2.currentTime + lc.offset);
    } else {
      lc.t += dt;
      lc.offset = lc.t - audio2.currentTime;
    }
    return lc.t;
  }

  var letterView = { key: '', readOp: -1 };

  function renderLetter(T) {
    var s = Logic.letterState(T, reduced);

    var key = s.flap.toFixed(4) + ':' + s.rise.toFixed(4);
    if (key !== letterView.key) {
      letterView.key = key;
      els.envClosed.style.transform = 'scaleY(' + Math.max(0, 1 - 2 * s.flap).toFixed(4) + ')';
      els.envOpen.style.transform = 'scaleY(' + Math.max(0, 2 * s.flap - 1).toFixed(4) + ')';
      els.envPaper.style.transform = 'translateY(' + (-PAPER_RISE * s.rise).toFixed(2) + 'px)';
    }

    setPreviewWritten(Logic.lettersWritten(preview.sched, s.writeDt, reduced));
    setPreviewPop(Logic.popProgress(preview.sched, s.writeDt, reduced));
    if (s.previewOpacity !== preview.opacity) {
      preview.opacity = s.previewOpacity;
      els.envPreview.style.opacity = String(s.previewOpacity);
    }

    if (s.readMore !== letterView.readOp) {
      letterView.readOp = s.readMore;
      els.readMore.style.opacity = String(s.readMore);
      els.readMore.disabled = s.readMore < 0.5;
    }
  }

  // ----- Envelope tap: everything starts inside the click handler -----

  els.envBtn.addEventListener('click', function () {
    if (state.tapped || !envView.tappable) return;
    state.tapped = true;

    active = audio2;
    startPlayback(); // song 2, inside the click so the browser allows sound

    vol.fade = { from: audio.volume, start: performance.now() }; // song 1 fades out over FADE_MS, then pauses
    lc.t = 0;
    lc.offset = 0;
    lc.last = performance.now();

    $('mini-title').textContent = song2.title;
    $('mini-artist').textContent = song2.artist;
    els.envBtn.disabled = true;
  });

  // ----- Read more: the panel grows out of the preview paper and shrinks back into it -----

  var reading = false;

  function setPanelPose(fromPaper) {
    var st = els.panel.style;
    if (!fromPaper) {
      st.removeProperty('--fx');
      st.removeProperty('--fy');
      st.removeProperty('--fs');
      return;
    }
    var sc = els.scene.getBoundingClientRect(); // the panel is centred in the scene
    var pr = els.envPaper.getBoundingClientRect();
    st.setProperty('--fs', (pr.width / els.panel.offsetWidth).toFixed(4));
    st.setProperty('--fx', ((pr.left + pr.width / 2) - (sc.left + sc.width / 2)).toFixed(1) + 'px');
    st.setProperty('--fy', ((pr.top + pr.height / 2) - (sc.top + sc.height / 2)).toFixed(1) + 'px');
  }

  function openLetter() {
    if (reading) return;
    reading = true;
    var p = els.panel;
    if (!reduced) {
      p.style.transition = 'none';
      setPanelPose(true);
      void p.offsetWidth;          // commit the start pose before the transition runs
      p.style.transition = '';
    }
    els.letterBody.scrollTop = 0;
    p.removeAttribute('inert');
    els.envSlide.setAttribute('inert', ''); // Tab and screen readers stay in the letter while it is open
    p.classList.add('is-open');
    setPanelPose(false);
    els.envWrap.classList.add('is-reading');
    els.panelClose.focus({ preventScroll: true });
  }

  function closeLetter() {
    if (!reading) return;
    reading = false;
    var p = els.panel;
    p.setAttribute('inert', '');
    if (!reduced) setPanelPose(true);
    p.classList.remove('is-open');
    els.envWrap.classList.remove('is-reading');
    els.envSlide.removeAttribute('inert');
    els.readMore.focus({ preventScroll: true });
  }

  els.readMore.addEventListener('click', openLetter);
  els.panelClose.addEventListener('click', closeLetter);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && reading) closeLetter();
  });
  els.replay.addEventListener('click', function () { location.reload(); });

  // ---------- render: song time -> screen ----------
  // uiT is the active song's time (mini player). boardT is the collage clock: a pure function of song 1's
  // time before the tap, parked at D after it. The transition stage logic lives in HSLogic.

  function render(uiT, boardT) {
    var d = active.duration;
    var known = isFinite(d) && d > 0;
    var p = known ? Math.min(1, Math.max(0, uiT / d)) : 0;

    els.seekFill.style.transform = 'scaleX(' + p + ')';
    if (!state.dragging) els.seek.value = String(p * 1000);

    var text = fmt(uiT) + ' / ' + (known ? fmt(d) : '--:--');
    if (text !== state.lastTimeText) {
      state.lastTimeText = text;
      els.time.textContent = text;
      els.seek.setAttribute('aria-valuetext', text);
    }

    var tr = Logic.transitionState(boardT, songDuration(), reduced, SITE.transition.fromEnd);
    renderCollage(boardT, tr);
    renderEnvelope(tr.envelope);
  }

  // Backup: when song 1 ends, show the envelope straight away
  audio.addEventListener('ended', function () { render(active.currentTime, boardTime()); });

  // Reels and the play/pause icon follow the real audio state
  function syncPlayState() {
    var playing = !active.paused && !active.error;
    if (playing === state.lastPlaying) return;
    state.lastPlaying = playing;
    document.body.classList.toggle('is-playing', playing);
    els.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // ---------- The single clock ----------

  function tick(now) {
    if (!state.ready && performance.now() - state.loadStart > LOAD_DEADLINE_MS) enablePlay();
    if (layoutDirty) {
      layoutDirty = false;
      applyLayout();
      envView.key = ''; // the envelope's slide offset depends on the board height
    }
    syncPlayState();
    var bt = boardTime();
    if (state.tapped) {
      stepSong1Fade(now);
      renderLetter(letterTime(now));
    } else {
      setSong1Volume(Logic.volumeAt(bt, songDuration()));
    }
    render(active.currentTime, bt);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
