(function () {
  'use strict';

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
    time:      $('mini-time')
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

  // ---------- render(t): pure function of song 1 time ----------
  // Phase 1: only the mini player's progress. Collage, captions and transition come later.

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
