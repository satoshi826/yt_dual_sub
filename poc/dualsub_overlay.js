// DualSub — YouTube 二か国語字幕オーバーレイ
//
// Pastes into any youtube.com page (Console) or runs as injected JS in an
// Android WebView. Reads YouTube's rendered captions, translates them with
// the gtx Google Translate endpoint, and draws both lines as our own overlay.
//
// Design constraints (discovered the hard way):
//   - Direct fetch of captionTracks[].baseUrl is rejected by PoToken; the
//     only reliable caption source is the DOM (.ytp-caption-segment).
//   - YouTube enforces Trusted Types CSP, so we never use innerHTML.
//   - Mobile YouTube doesn't expose a stable CC button DOM, so we observe
//     captions instead of trying to mirror button state. To enable captions
//     we attempt button click; if that fails we dispatch the 'c' shortcut.
//   - WebView calc(100vh - X) sometimes evaluates to 0, so panel sizing is
//     set imperatively from JS using window.innerHeight.
//
// Usage:
//   - Paste into DevTools console on a YouTube page, or
//   - Let the Android WebView inject this script on page load.
//   - Stop with __dualsubStop().

(() => {
  'use strict';

  if (window.__dualsubInstalled) {
    console.log('[dualsub] already installed. Call __dualsubStop() first.');
    return;
  }
  window.__dualsubInstalled = true;

  // ──────────────────────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'dualsub-config-v1';
  const POLL_MS = 200;
  const MAX_CACHE = 500;

  const DEFAULT_CONFIG = {
    enabled: true,
    // Top line — what YouTube renders (original).
    topLang: 'auto',
    topColor: '#ffffff',
    topFontSize: 3.5,        // % of player height
    // Bottom line — our translation.
    bottomLang: 'en',
    bottomColor: '#4fc3f7',
    bottomFontSize: 3.0,
    // Shared.
    overlayBottom: 15,       // % from bottom
    bgOpacity: 60,           // % (semi-transparent black pill)
  };

  const LANGS = [
    { code: 'en',    name: 'English' },
    { code: 'ja',    name: '日本語' },
    { code: 'zh-CN', name: '中文 (简体)' },
    { code: 'zh-TW', name: '中文 (繁體)' },
    { code: 'ko',    name: '한국어' },
    { code: 'es',    name: 'Español' },
    { code: 'fr',    name: 'Français' },
    { code: 'de',    name: 'Deutsch' },
    { code: 'it',    name: 'Italiano' },
    { code: 'pt',    name: 'Português' },
    { code: 'ru',    name: 'Русский' },
    { code: 'ar',    name: 'العربية' },
    { code: 'hi',    name: 'हिन्दी' },
    { code: 'th',    name: 'ไทย' },
    { code: 'vi',    name: 'Tiếng Việt' },
    { code: 'id',    name: 'Indonesia' },
  ];

  const SEL = {
    player: '#movie_player, .html5-video-player',
    captionTexts: ['.ytp-caption-segment', '.caption-visual-line', '[class*="caption-segment"]'],
    ccButton: [
      '.ytp-subtitles-button[aria-pressed]',
      'button[aria-pressed][aria-label*="字幕"]',
      'button[aria-pressed][aria-label*="subtitle" i]',
      'button[aria-pressed][aria-label*="caption" i]',
    ].join(', '),
  };

  // ──────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────
  let player = null;
  let playerResizeObs = null;
  let lastText = '';
  let lastUrl = location.href;
  let updateSeq = 0;
  // YouTube 側の字幕状態(複数シグナルから観察)。
  // attemptYtSync が ON/OFF どちらの方向にも揃えに行く前提で、観察結果は
  // 都度上書き(非 sticky)。新しい同期操作が走ったら古い操作は seq で破棄。
  let ytCaptionsOn = false;
  let syncSeq = 0;
  const cleanups = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ──────────────────────────────────────────────────────────────
  // Config
  // ──────────────────────────────────────────────────────────────
  // Strip legacy keys / values from older schemas before merge. Keeping this
  // around so users who tested earlier builds don't end up with broken state.
  function migrate(saved) {
    if (!saved) return saved;
    const aliases = {
      targetLang: 'bottomLang',
      sourceLang: 'topLang',
      overlayColor: 'bottomColor',
    };
    for (const [oldKey, newKey] of Object.entries(aliases)) {
      if (saved[oldKey] != null && saved[newKey] == null) saved[newKey] = saved[oldKey];
      delete saved[oldKey];
    }
    if (saved.overlayFontSize != null) {
      if (saved.bottomFontSize == null) saved.bottomFontSize = saved.overlayFontSize;
      if (saved.topFontSize == null) saved.topFontSize = saved.overlayFontSize + 2;
      delete saved.overlayFontSize;
    }
    delete saved.shadowStrength;
    // Old px values; current schema is % of player height (≤ 10).
    for (const k of ['topFontSize', 'bottomFontSize']) {
      if (typeof saved[k] === 'number' && saved[k] > 10) delete saved[k];
    }
    return saved;
  }

  function loadConfig() {
    try {
      const saved = migrate(JSON.parse(localStorage.getItem(STORAGE_KEY)));
      return { ...DEFAULT_CONFIG, ...(saved || {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  const config = loadConfig();

  // ──────────────────────────────────────────────────────────────
  // DOM helpers (Trusted Types-safe — no innerHTML)
  // ──────────────────────────────────────────────────────────────
  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v;
      else if (k === 'on') for (const [ev, h] of Object.entries(v)) e.addEventListener(ev, h);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }
  function svg(tag, attrs = {}, children = []) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of children) e.appendChild(c);
    return e;
  }

  // ──────────────────────────────────────────────────────────────
  // Translation (Google client=gtx, unauthenticated, rate-limited)
  // ──────────────────────────────────────────────────────────────
  const Translator = (() => {
    const cache = new Map();
    return {
      async translate(text, target, source) {
        const key = `${source}::${target}::${text}`;
        if (cache.has(key)) return cache.get(key);
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const out = data[0].map(seg => seg[0]).join('');
          if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
          cache.set(key, out);
          return out;
        } catch (e) {
          console.warn('[dualsub] translate failed:', e.message);
          return null;
        }
      },
    };
  })();

  // ──────────────────────────────────────────────────────────────
  // YT caption state detection + best-effort enable
  // ──────────────────────────────────────────────────────────────
  // ON シグナルを 3 経路で検査。1 つでも ON なら true。OFF 確定はしない。
  // 観測は sticky: 一度 ON が見えたら以降 false にはしない(誤って 'c' 連打して
  // 字幕を消してしまうのを避けるため)。
  function detectCaptionSignal() {
    // 1. 実テキストが描画されている = 確実に ON(最強シグナル)
    if (getCurrentCaption()) return true;
    // 2. <video>.textTracks に showing なものがあれば ON
    const video = document.querySelector('video');
    if (video?.textTracks) {
      for (const t of video.textTracks) if (t.mode === 'showing') return true;
    }
    // 3. CC ボタンが aria-pressed=true を示していれば ON
    const btn = document.querySelector(SEL.ccButton);
    if (btn?.getAttribute('aria-pressed') === 'true') return true;
    return false;
  }

  // 観察結果を即時反映(非 sticky)。attemptYtSync 中の判定は detectCaptionSignal を直接呼ぶ。
  function updateYtCaptionState() {
    ytCaptionsOn = detectCaptionSignal();
  }

  // YT 字幕 ON: CC ボタン click → 'c' キー dispatch
  function tryEnableYtCaptions() {
    const btn = document.querySelector(SEL.ccButton);
    if (btn && btn.getAttribute('aria-pressed') === 'false' &&
        btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return;
    }
    dispatchCKey();
  }

  // YT 字幕 OFF: CC ボタン click(押されていれば) → 'c' キー dispatch(c はトグル)
  function tryDisableYtCaptions() {
    const btn = document.querySelector(SEL.ccButton);
    if (btn && btn.getAttribute('aria-pressed') === 'true' &&
        btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return;
    }
    dispatchCKey();
  }

  function dispatchCKey() {
    const init = { key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true, cancelable: true };
    const targets = [
      document.querySelector('video'),
      document.querySelector('#movie_player'),
      document.querySelector('.html5-video-player'),
      document.body,
    ].filter(Boolean);
    for (const t of targets) {
      t.dispatchEvent(new KeyboardEvent('keydown', init));
      t.dispatchEvent(new KeyboardEvent('keyup', init));
    }
  }

  // YT の字幕状態を targetOn に揃えに行く双方向シンク。
  //   - opts.initialDelay: 観察猶予(プレーヤーロード直後など)
  //   - 試行 → verifyDelay 待機 → 一致確認、を maxAttempts 回まで繰り返す
  //   - 全失敗時は YT の実状態に合わせて config.enabled を revert
  //   - syncSeq による上書きで古い操作はサイレント終了
  async function attemptYtSync(targetOn, opts = {}) {
    const { initialDelay = 0, verifyDelay = 1500, maxAttempts = 2 } = opts;
    const seq = ++syncSeq;
    const matches = () => detectCaptionSignal() === targetOn;

    if (initialDelay > 0) {
      await sleep(initialDelay);
      if (seq !== syncSeq) return;
    }
    if (matches()) { ytCaptionsOn = targetOn; return; }

    for (let i = 0; i < maxAttempts; i++) {
      if (targetOn) tryEnableYtCaptions();
      else tryDisableYtCaptions();
      await sleep(verifyDelay);
      if (seq !== syncSeq) return;
      if (matches()) { ytCaptionsOn = targetOn; return; }
    }

    // 全試行失敗 → YT 実状態に合わせて自分の state を補正
    const ytActual = detectCaptionSignal();
    ytCaptionsOn = ytActual;
    if (ytActual !== config.enabled) {
      console.log(`[dualsub] sync failed; aligning toggle to YT state (${ytActual ? 'on' : 'off'})`);
      config.enabled = ytActual;
      ui.inputs.cbEnabled.checked = ytActual;
      saveConfig();
      applyOverlayStyle();
      syncStatusDot();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Player detection
  //   The known ID is preferred. Fallback: walk up from <video> until we hit a
  //   positioned ancestor — we need a positioned container to absolutely
  //   place our overlay on the video.
  // ──────────────────────────────────────────────────────────────
  function findPlayer() {
    const known = document.querySelector(SEL.player);
    if (known) return known;
    const video = document.querySelector('video');
    if (!video) return null;
    for (let n = video.parentElement; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') return n;
    }
    return video.parentElement;
  }

  // ──────────────────────────────────────────────────────────────
  // Caption scraping
  // ──────────────────────────────────────────────────────────────
  function getCurrentCaption() {
    for (const sel of SEL.captionTexts) {
      const els = document.querySelectorAll(sel);
      if (els.length) return [...els].map(e => e.textContent).join(' ').trim();
    }
    return '';
  }

  // ──────────────────────────────────────────────────────────────
  // Overlay
  // ──────────────────────────────────────────────────────────────
  const overlay = el('div', { id: 'dualsub-overlay' });
  const overlayOriginal = el('div', { className: 'ds-original' });
  const overlayTranslated = el('div', { className: 'ds-translated' });
  overlay.appendChild(overlayOriginal);
  overlay.appendChild(overlayTranslated);

  function computeFontSizes() {
    const h = player?.clientHeight || 360;
    const root = document.documentElement;
    root.style.setProperty('--ds-top-size', `${Math.max(8, h * config.topFontSize / 100).toFixed(1)}px`);
    root.style.setProperty('--ds-bottom-size', `${Math.max(8, h * config.bottomFontSize / 100).toFixed(1)}px`);
  }

  function applyOverlayStyle() {
    const root = document.documentElement;
    root.style.setProperty('--ds-overlay-bottom', `${config.overlayBottom}%`);
    root.style.setProperty('--ds-top-color', config.topColor);
    root.style.setProperty('--ds-bottom-color', config.bottomColor);
    root.style.setProperty('--ds-bg-opacity', String(config.bgOpacity / 100));
    computeFontSizes();
    overlay.style.display = config.enabled ? 'flex' : 'none';
    document.body.classList.toggle('dualsub-active', config.enabled);
  }

  function clearOverlay() {
    overlayOriginal.textContent = '';
    overlayTranslated.textContent = '';
  }

  async function updateOverlay() {
    maybeHandleNavigation();
    updateYtCaptionState();
    if (!config.enabled) {
      clearOverlay();
      lastText = '';
      return;
    }
    const text = getCurrentCaption();
    if (text === lastText) return;
    lastText = text;
    if (!text) { clearOverlay(); return; }
    overlayOriginal.textContent = text;
    overlayTranslated.style.opacity = '0.4';
    const seq = ++updateSeq;
    const translated = await Translator.translate(text, config.bottomLang, config.topLang);
    if (seq !== updateSeq) return;  // newer subtitle already in flight
    overlayTranslated.style.opacity = '1';
    overlayTranslated.textContent = translated || '';
  }

  function maybeHandleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(syncMountState, 500);
  }

  // Show the bar/overlay only when there's a player on the page. Hides on
  // homepage/search, re-mounts when navigating into a watch page.
  function syncMountState() {
    const found = findPlayer();

    if (!found) {
      ui.panel.style.display = 'none';
      overlay.style.display = 'none';
      document.body.classList.remove('dualsub-active');
      player = null;
      playerResizeObs?.disconnect();
      playerResizeObs = null;
      return;
    }

    const alreadyMounted = player === found
      && document.body.contains(ui.panel)
      && found.contains(overlay);
    if (alreadyMounted) {
      ui.panel.style.display = '';
      applyOverlayStyle();
      return;
    }

    player = found;
    if (!document.body.contains(ui.panel)) document.body.appendChild(ui.panel);
    if (!found.contains(overlay)) found.appendChild(overlay);
    ui.panel.style.display = '';
    applyOverlayStyle();

    playerResizeObs?.disconnect();
    playerResizeObs = new ResizeObserver(computeFontSizes);
    playerResizeObs.observe(found);

    // 新規プレーヤーごとに一度だけ、保存された config.enabled に向けて同期試行。
    // initialDelay=3s で YT が既に字幕を出している場合の検出機会を確保する。
    attemptYtSync(config.enabled, { initialDelay: 3000 });
  }

  // ──────────────────────────────────────────────────────────────
  // Styles
  // ──────────────────────────────────────────────────────────────
  function buildStyle() {
    const s = el('style');
    s.textContent = `
      :root {
        --ds-accent: #4fc3f7;
        --ds-accent-glow: rgba(79,195,247,0.45);
        --ds-bg: rgba(15,18,24,0.78);
        --ds-bg-strong: rgba(15,18,24,0.92);
        --ds-border: rgba(255,255,255,0.12);
        --ds-text: #f3f5f8;
        --ds-text-dim: rgba(243,245,248,0.55);
      }

      /* When the overlay is active, hide YouTube's native caption rendering
         (we replace it with our own). */
      body.dualsub-active .caption-window,
      body.dualsub-active .ytp-caption-window-container,
      body.dualsub-active .ytp-caption-window-bottom,
      body.dualsub-active .caption-visual-line,
      body.dualsub-active .captions-text { visibility: hidden !important; }

      #dualsub-overlay {
        position: absolute;
        bottom: var(--ds-overlay-bottom, 15%);
        left: 0; right: 0;
        display: flex; flex-direction: column;
        align-items: center; gap: 6px;
        pointer-events: none; z-index: 60;
        padding: 4px 24px;
        font-family: "YouTube Noto", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", Roboto, "Arial Unicode Ms", Arial, sans-serif;
        transition: opacity 0.15s;
      }
      #dualsub-overlay .ds-original,
      #dualsub-overlay .ds-translated {
        display: block;
        width: fit-content;
        max-width: 100%;
        margin: 0 auto;
        align-self: center;
        text-align: center;
        font-weight: 700;
        line-height: 1.35;
        padding: 2px 12px;
        border-radius: 6px;
        background-color: rgba(0,0,0, var(--ds-bg-opacity, 0.6));
        text-shadow:
          1px 1px 3px rgba(0,0,0,0.45),
          0 0 8px rgba(0,0,0,0.3),
          -1px -1px 0 rgba(0,0,0,0.2),
          1px -1px 0 rgba(0,0,0,0.2);
        white-space: pre-wrap;
        transition: opacity 0.15s, background-color 0.15s;
        box-sizing: border-box;
      }
      #dualsub-overlay .ds-original   { color: var(--ds-top-color, #fff); font-size: var(--ds-top-size, 22px); }
      #dualsub-overlay .ds-translated { color: var(--ds-bottom-color, #4fc3f7); font-size: var(--ds-bottom-size, 19px); }
      #dualsub-overlay .ds-original:empty,
      #dualsub-overlay .ds-translated:empty { display: none; }

      /* Bar + panel */
      #dualsub-panel {
        position: fixed;
        bottom: max(12px, env(safe-area-inset-bottom, 12px));
        left: 50%; transform: translateX(-50%);
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic UI", Roboto, sans-serif;
        font-size: 13px; color: var(--ds-text);
        display: flex; flex-direction: column-reverse; align-items: stretch;
        width: min(480px, calc(100vw - 24px));
      }
      #dualsub-toggle {
        all: unset; box-sizing: border-box; cursor: pointer; pointer-events: auto;
        width: 100%; height: 52px;
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 18px;
        background: linear-gradient(135deg, var(--ds-bg) 0%, var(--ds-bg-strong) 100%);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1px solid var(--ds-border);
        border-radius: 26px;
        box-shadow:
          0 10px 32px rgba(0,0,0,0.45),
          0 2px 8px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.08);
        transition: transform 0.18s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.18s ease, border-color 0.18s ease;
        color: var(--ds-text);
      }
      #dualsub-toggle:hover {
        transform: translateY(-2px);
        border-color: rgba(255,255,255,0.2);
        box-shadow:
          0 16px 40px rgba(0,0,0,0.55),
          0 4px 12px rgba(0,0,0,0.35),
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 0 0 4px var(--ds-accent-glow);
      }
      #dualsub-toggle:active { transform: translateY(0); }

      .ds-bar-left  { display: flex; align-items: center; gap: 10px; }
      .ds-bar-right { display: flex; align-items: center; gap: 12px; }

      .ds-status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--ds-accent);
        animation: ds-pulse 2.2s ease-out infinite;
      }
      .ds-status-dot.ds-off { background: rgba(255,255,255,0.25); animation: none; }
      @keyframes ds-pulse {
        0%   { box-shadow: 0 0 0 0 var(--ds-accent-glow); }
        70%  { box-shadow: 0 0 0 10px rgba(79,195,247,0); }
        100% { box-shadow: 0 0 0 0 rgba(79,195,247,0); }
      }

      .ds-brand { font-weight: 700; letter-spacing: 0.02em; font-size: 14px; color: var(--ds-text); }
      .ds-brand .ds-accent { color: var(--ds-accent); }

      .ds-lang-pair {
        display: flex; align-items: center; gap: 7px;
        padding: 4px 11px;
        background: rgba(255,255,255,0.06);
        border: 1px solid var(--ds-border);
        border-radius: 999px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .ds-lang-pair .ds-arrow         { color: var(--ds-text-dim); font-weight: 400; opacity: 0.6; }
      .ds-lang-pair .ds-lang-top      { color: var(--ds-top-color, #fff); }
      .ds-lang-pair .ds-lang-bottom   { color: var(--ds-bottom-color, #4fc3f7); }

      .ds-chevron {
        width: 16px; height: 16px; color: var(--ds-text-dim);
        transition: transform 0.25s cubic-bezier(0.2,0.8,0.2,1), color 0.18s;
      }
      #dualsub-panel.dualsub-open .ds-chevron { transform: rotate(180deg); color: var(--ds-accent); }

      #dualsub-body {
        margin-bottom: 10px; width: 100%;
        overflow-y: auto;
        background: linear-gradient(180deg, var(--ds-bg-strong) 0%, var(--ds-bg) 100%);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--ds-border);
        border-radius: 20px;
        padding: 18px 18px 16px;
        display: none;
        box-shadow: 0 -12px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
        opacity: 0; transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.2,0.8,0.2,1);
      }
      #dualsub-panel.dualsub-open #dualsub-body { display: block; opacity: 1; transform: translateY(0); }

      .ds-body-header {
        font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--ds-text-dim);
        margin-bottom: 14px; padding-bottom: 10px;
        border-bottom: 1px solid var(--ds-border);
      }
      .ds-grid { display: flex; flex-direction: column; gap: 12px; }
      .ds-row  { display: flex; flex-direction: column; gap: 6px; }

      .ds-group {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
        padding: 12px 14px 14px;
        background: rgba(255,255,255,0.025);
        border: 1px solid var(--ds-border);
        border-radius: 12px;
      }
      .ds-group-header {
        grid-column: 1 / -1;
        display: flex; align-items: center; gap: 8px;
        font-size: 10px; font-weight: 700;
        letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--ds-text-dim);
        padding-bottom: 4px;
      }
      .ds-group-dot {
        width: 10px; height: 10px; border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.18), 0 0 8px currentColor;
      }
      .ds-group .ds-row.ds-wide { grid-column: 1 / -1; }
      .ds-group-top    .ds-group-dot { color: var(--ds-top-color,    #fff);     background: var(--ds-top-color,    #fff);     }
      .ds-group-bottom .ds-group-dot { color: var(--ds-bottom-color, #4fc3f7);  background: var(--ds-bottom-color, #4fc3f7);  }

      .ds-label {
        display: flex; justify-content: space-between; align-items: baseline;
        color: var(--ds-text-dim); font-size: 11px;
        font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ds-value { color: var(--ds-accent); font-size: 11px; font-weight: 600; }

      .ds-row select,
      .ds-row input[type=range],
      .ds-row input[type=color] {
        width: 100%; box-sizing: border-box; outline: none;
        background: rgba(255,255,255,0.06);
        color: var(--ds-text);
        border: 1px solid var(--ds-border);
        border-radius: 10px;
        font-size: 13px;
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .ds-row select {
        padding: 8px 28px 8px 10px;
        appearance: none; -webkit-appearance: none;
        background-image:
          linear-gradient(45deg,  transparent 50%, var(--ds-text-dim) 50%),
          linear-gradient(135deg, var(--ds-text-dim) 50%, transparent 50%);
        background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
        background-size: 5px 5px, 5px 5px;
        background-repeat: no-repeat;
      }
      .ds-row select:hover, .ds-row select:focus,
      .ds-row input[type=color]:hover {
        border-color: var(--ds-accent);
        background-color: rgba(255,255,255,0.08);
      }

      .ds-row input[type=range] {
        -webkit-appearance: none; appearance: none;
        height: 28px; padding: 0 4px;
        background: transparent; border: none;
      }
      .ds-row input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: rgba(255,255,255,0.12); }
      .ds-row input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 16px; height: 16px; border-radius: 50%;
        background: var(--ds-accent);
        margin-top: -6px;
        box-shadow: 0 0 0 4px rgba(79,195,247,0.15), 0 2px 6px rgba(0,0,0,0.4);
        cursor: pointer; transition: transform 0.12s ease;
      }
      .ds-row input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.15); }
      .ds-row input[type=range]::-moz-range-track { height: 4px; border-radius: 999px; background: rgba(255,255,255,0.12); }
      .ds-row input[type=range]::-moz-range-thumb {
        width: 16px; height: 16px; border-radius: 50%; border: none;
        background: var(--ds-accent);
        box-shadow: 0 0 0 4px rgba(79,195,247,0.15);
        cursor: pointer;
      }
      .ds-row input[type=color] { height: 36px; padding: 4px; cursor: pointer; }
      .ds-row input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
      .ds-row input[type=color]::-webkit-color-swatch { border: none; border-radius: 6px; }

      .ds-switch { position: relative; display: inline-block; width: 38px; height: 22px; }
      .ds-switch input { opacity: 0; width: 0; height: 0; }
      .ds-switch-slider {
        position: absolute; inset: 0; cursor: pointer;
        background: rgba(255,255,255,0.12);
        border-radius: 999px;
        transition: background 0.2s ease;
      }
      .ds-switch-slider::before {
        content: ""; position: absolute;
        width: 16px; height: 16px; left: 3px; top: 3px;
        background: #fff; border-radius: 50%;
        transition: transform 0.22s cubic-bezier(0.2,0.8,0.2,1);
        box-shadow: 0 2px 4px rgba(0,0,0,0.4);
      }
      .ds-switch input:checked + .ds-switch-slider { background: var(--ds-accent); }
      .ds-switch input:checked + .ds-switch-slider::before { transform: translateX(16px); }

      .ds-row.ds-toggle-row {
        flex-direction: row; align-items: center; justify-content: space-between;
        padding: 4px 0 8px;
        border-bottom: 1px solid var(--ds-border);
        margin-bottom: 4px;
      }
      .ds-row.ds-toggle-row .ds-label {
        flex: 1; color: var(--ds-text);
        font-size: 13px; text-transform: none; letter-spacing: 0;
      }
    `;
    return s;
  }

  // ──────────────────────────────────────────────────────────────
  // UI factory
  // ──────────────────────────────────────────────────────────────
  // Display sizes as ×10 percent (3.5 → "35%") so the slider numbers feel
  // human-friendly without changing the underlying value.
  const fmtSize = v => {
    const d = v * 10;
    return (d === Math.floor(d) ? d.toFixed(0) : d.toFixed(1)) + '%';
  };

  function buildLangSelect(includeAuto, value) {
    const s = el('select');
    if (includeAuto) s.add(new Option('自動判定', 'auto'));
    for (const l of LANGS) s.add(new Option(l.name, l.code));
    s.value = value;
    return s;
  }

  function buildRow(labelText, valueSpan, inputEl, opts = {}) {
    const children = valueSpan ? [el('span', {}, [labelText]), valueSpan] : [labelText];
    return el('div', { className: 'ds-row' + (opts.wide ? ' ds-wide' : '') }, [
      el('label', { className: 'ds-label' }, children),
      inputEl,
    ]);
  }

  function buildGroup(side, langSel, colorIn, sizeIn, sizeVal) {
    const title = side === 'top' ? 'Top  ·  上の字幕' : 'Bottom  ·  下の字幕';
    return el('div', { className: `ds-group ds-group-${side}` }, [
      el('div', { className: 'ds-group-header' }, [
        el('span', { className: 'ds-group-dot' }),
        el('span', {}, [title]),
      ]),
      buildRow('言語', null, langSel, { wide: true }),
      buildRow('色',   null, colorIn),
      buildRow('サイズ', sizeVal, sizeIn),
    ]);
  }

  function buildUI() {
    // — Bar —
    const statusDot = el('span', { className: 'ds-status-dot' });
    const brand     = el('span', { className: 'ds-brand' }, [
      'Dual', el('span', { className: 'ds-accent' }, ['Sub']),
    ]);
    const langTop    = el('span', { className: 'ds-lang-top' });
    const langBottom = el('span', { className: 'ds-lang-bottom' });
    const langPair   = el('span', { className: 'ds-lang-pair' }, [
      langTop, el('span', { className: 'ds-arrow' }, ['/']), langBottom,
    ]);
    const chevron = svg('svg', {
      class: 'ds-chevron', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor',
      'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, [svg('polyline', { points: '6 15 12 9 18 15' })]);

    const toggleBtn = el('button', { id: 'dualsub-toggle', type: 'button' }, [
      el('span', { className: 'ds-bar-left'  }, [statusDot, brand]),
      el('span', { className: 'ds-bar-right' }, [langPair, chevron]),
    ]);

    // — Body —
    const cbEnabled = el('input', { type: 'checkbox', checked: config.enabled });
    const rowEnabled = el('div', { className: 'ds-row ds-toggle-row' }, [
      el('span', { className: 'ds-label' }, ['オーバーレイ表示']),
      el('label', { className: 'ds-switch' }, [cbEnabled, el('span', { className: 'ds-switch-slider' })]),
    ]);

    const selTopLang   = buildLangSelect(true,  config.topLang);
    const inTopColor   = el('input', { type: 'color', value: config.topColor });
    const inTopSize    = el('input', { type: 'range', min: '1', max: '10', step: '0.25', value: String(config.topFontSize) });
    const topSizeVal   = el('span', { className: 'ds-value' }, [fmtSize(config.topFontSize)]);
    const topGroup     = buildGroup('top', selTopLang, inTopColor, inTopSize, topSizeVal);

    const selBottomLang = buildLangSelect(false, config.bottomLang);
    const inBottomColor = el('input', { type: 'color', value: config.bottomColor });
    const inBottomSize  = el('input', { type: 'range', min: '1', max: '10', step: '0.25', value: String(config.bottomFontSize) });
    const bottomSizeVal = el('span', { className: 'ds-value' }, [fmtSize(config.bottomFontSize)]);
    const bottomGroup   = buildGroup('bottom', selBottomLang, inBottomColor, inBottomSize, bottomSizeVal);

    const inPos        = el('input', { type: 'range', min: '0', max: '40', step: '1', value: String(config.overlayBottom) });
    const posVal       = el('span', { className: 'ds-value' }, [`${config.overlayBottom}%`]);
    const rowPos       = buildRow('位置(下からの%)', posVal, inPos);

    const inBgOpacity  = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(config.bgOpacity) });
    const bgOpacityVal = el('span', { className: 'ds-value' }, [`${config.bgOpacity}%`]);
    const rowBgOpacity = buildRow('背景の濃さ', bgOpacityVal, inBgOpacity);

    const grid = el('div', { className: 'ds-grid' }, [rowEnabled, topGroup, bottomGroup, rowPos, rowBgOpacity]);
    const body = el('div', { id: 'dualsub-body' }, [
      el('div', { className: 'ds-body-header' }, ['Subtitle Settings']),
      grid,
    ]);
    const panel = el('div', { id: 'dualsub-panel' }, [toggleBtn, body]);

    return {
      panel, toggleBtn, statusDot, langTop, langBottom,
      inputs: { cbEnabled, selTopLang, selBottomLang, inTopColor, inBottomColor, inTopSize, inBottomSize, inPos, inBgOpacity },
      vals:   { topSizeVal, bottomSizeVal, posVal, bgOpacityVal },
    };
  }

  const ui = buildUI();

  // ──────────────────────────────────────────────────────────────
  // UI sync helpers
  // ──────────────────────────────────────────────────────────────
  function syncStatusDot() {
    ui.statusDot.classList.toggle('ds-off', !config.enabled);
  }
  function updateLangPair() {
    ui.langTop.textContent    = config.topLang === 'auto' ? 'AUTO' : config.topLang.toUpperCase();
    ui.langBottom.textContent = config.bottomLang.toUpperCase();
  }

  function onUiInput() {
    const { inputs, vals } = ui;
    const wasEnabled = config.enabled;

    config.enabled        = inputs.cbEnabled.checked;
    config.topLang        = inputs.selTopLang.value;
    config.bottomLang     = inputs.selBottomLang.value;
    config.topColor       = inputs.inTopColor.value;
    config.bottomColor    = inputs.inBottomColor.value;
    config.topFontSize    = parseFloat(inputs.inTopSize.value);
    config.bottomFontSize = parseFloat(inputs.inBottomSize.value);
    config.overlayBottom  = parseInt(inputs.inPos.value, 10);
    config.bgOpacity      = parseInt(inputs.inBgOpacity.value, 10);

    vals.topSizeVal.textContent    = fmtSize(config.topFontSize);
    vals.bottomSizeVal.textContent = fmtSize(config.bottomFontSize);
    vals.posVal.textContent        = `${config.overlayBottom}%`;
    vals.bgOpacityVal.textContent  = `${config.bgOpacity}%`;

    saveConfig();
    applyOverlayStyle();
    updateLangPair();
    syncStatusDot();
    lastText = '';  // force re-render with new translation target / style

    // トグル変化に追随して YT 側を ON/OFF 同期。失敗時は YT 実状態に
    // 合わせて config.enabled を revert する(attemptYtSync 内で処理)。
    if (wasEnabled !== config.enabled) {
      attemptYtSync(config.enabled);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────
  const styleEl = buildStyle();
  document.head.appendChild(styleEl);

  // Mount the panel hidden — syncMountState() will show it when a player exists.
  ui.panel.style.display = 'none';
  overlay.style.display = 'none';
  document.body.appendChild(ui.panel);

  updateLangPair();
  syncStatusDot();
  applyOverlayStyle();
  syncMountState();

  // The panel body's height comes from JS, not CSS, because WebView
  // sometimes computes calc(100vh - X) to 0px.
  function updatePanelMaxHeight() {
    const body = ui.panel.querySelector('#dualsub-body');
    if (body) body.style.maxHeight = `${Math.max(240, window.innerHeight - 120)}px`;
  }
  updatePanelMaxHeight();
  window.addEventListener('resize', updatePanelMaxHeight);
  cleanups.push(() => window.removeEventListener('resize', updatePanelMaxHeight));

  // Watch captions + check player presence on the same poll.
  const captionObserver = new MutationObserver(updateOverlay);
  captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  cleanups.push(() => captionObserver.disconnect());

  const poll = setInterval(() => { syncMountState(); updateOverlay(); }, POLL_MS);
  cleanups.push(() => clearInterval(poll));

  cleanups.push(() => playerResizeObs?.disconnect());
  // 進行中の attemptYtSync は seq 番号で自然に無効化される(明示 clear 不要)

  // Wire up panel controls.
  for (const inp of Object.values(ui.inputs)) {
    inp.addEventListener('input', onUiInput);
    inp.addEventListener('change', onUiInput);
  }
  ui.toggleBtn.addEventListener('click', () => {
    ui.panel.classList.toggle('dualsub-open');
  });

  // Hide our panel while fullscreen (the native player owns the screen).
  const onFsChange = () => {
    ui.panel.style.display = document.fullscreenElement ? 'none' : (player ? '' : 'none');
  };
  document.addEventListener('fullscreenchange', onFsChange);
  cleanups.push(() => document.removeEventListener('fullscreenchange', onFsChange));

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  window.__dualsubStop = () => {
    for (const fn of cleanups) { try { fn(); } catch (e) { console.warn('[dualsub] cleanup error', e); } }
    overlay.remove();
    ui.panel.remove();
    styleEl.remove();
    document.body.classList.remove('dualsub-active');
    window.__dualsubInstalled = false;
    delete window.__dualsubStop;
    console.log('[dualsub] stopped');
  };

  console.log('[dualsub] ready · stop with __dualsubStop()');
})();
