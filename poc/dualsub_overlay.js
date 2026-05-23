// DualSub — YouTube 二か国語字幕オーバーレイ
//
// Pastes into any youtube.com page (Console) or runs as injected JS in an
// Android WebView. Fetches the video's caption tracks via the InnerTube
// player endpoint (ANDROID client context, which bypasses PoToken), then
// fetches the original-language XML and the auto-translated XML and renders
// both lines as our own overlay synchronized to video.currentTime.
//
// Design constraints (discovered the hard way):
//   - Direct fetch of captionTracks[].baseUrl from ytInitialPlayerResponse
//     returns 0 bytes (PoToken blocks unauthenticated browser context).
//     InnerTube /youtubei/v1/player with ANDROID client returns baseUrls
//     that ARE fetchable. That is our caption source.
//   - YouTube enforces Trusted Types CSP, so we never use innerHTML.
//   - WebView calc(100vh - X) sometimes evaluates to 0, so panel sizing is
//     set imperatively from JS using window.innerHeight.
//
// Usage:
//   - Paste into DevTools console on a YouTube page, or
//   - Let the Android WebView inject this script on page load.
//   - Stop with __dualsubStop().

(() => {
  if (window.__dualsubInstalled) {
    console.log('[dualsub] already installed. Call __dualsubStop() to remove.');
    return;
  }
  window.__dualsubInstalled = true;

  // ──────────────────────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'dualsub-config-v1';
  const POLL_MS = 250;
  const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const INNERTUBE_CONTEXT = {
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 34,
    },
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    // Top / Bottom は完全対等。各 lane の言語は独立に明示指定する。
    // それぞれ:
    //   - 同言語の手動字幕があればそれ(ネイティブ)
    //   - 無ければ asr 字幕
    //   - それも無ければ別字幕 + tlang による自動翻訳
    topLang: 'en',
    topColor: '#ffffff',
    topFontSize: 3.5,        // % of player height
    bottomLang: 'ja',
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
  };

  // ──────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────
  let player = null;
  let playerResizeObs = null;
  let lastUrl = location.href;
  const cleanups = [];

  // ──────────────────────────────────────────────────────────────
  // Config
  // ──────────────────────────────────────────────────────────────
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
    for (const k of ['topFontSize', 'bottomFontSize']) {
      if (typeof saved[k] === 'number' && saved[k] > 10) delete saved[k];
    }
    // 旧スキーマの 'auto' は廃止 — Top も明示指定。
    if (saved.topLang === 'auto') delete saved.topLang;
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
  // DOM helpers (Trusted Types-safe; no innerHTML)
  // ──────────────────────────────────────────────────────────────
  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') e.className = v;
      else if (k === 'textContent') e.textContent = v;
      else if (k === 'checked') e.checked = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }
  function svg(tag, attrs = {}, children = []) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of children) e.appendChild(c);
    return e;
  }

  // ──────────────────────────────────────────────────────────────
  // videoId 取得
  // ──────────────────────────────────────────────────────────────
  function getCurrentVideoId() {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = location.pathname.match(/\/(?:watch|shorts|embed|v)\/([^/?&#]+)/);
    if (m) return m[1];
    try {
      const id = window.ytInitialPlayerResponse?.videoDetails?.videoId;
      if (id) return id;
    } catch {}
    return null;
  }

  // ──────────────────────────────────────────────────────────────
  // srv3 parser
  //   <p t="ms" d="ms">...<s>word</s>...</p>
  // ──────────────────────────────────────────────────────────────
  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  function parseSrv3(xml) {
    const cues = [];
    if (!xml) return cues;
    const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRe.exec(xml)) !== null) {
      const inner = m[3];
      let text = '';
      const sRe = /<s[^>]*>([^<]*)<\/s>/g;
      let sm;
      while ((sm = sRe.exec(inner)) !== null) text += sm[1];
      if (!text) text = inner.replace(/<[^>]+>/g, '');
      text = decodeEntities(text).trim();
      if (text) cues.push({ t: +m[1], d: +m[2], text });
    }
    return cues;
  }

  // currentTime (ms) に該当する cue のテキストを返す。なければ ''
  function cueAt(cues, ms) {
    if (!cues?.length) return '';
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (ms < c.t) hi = mid - 1;
      else if (ms >= c.t + c.d) lo = mid + 1;
      else return c.text;
    }
    return '';
  }

  // ──────────────────────────────────────────────────────────────
  // CaptionStore
  //   - InnerTube /youtubei/v1/player (ANDROID) で captionTracks を取得
  //   - Top / Bottom 2 lane を完全対等に並列処理
  //   - 各 lane について resolveLane で「ネイティブ手動 > asr > 翻訳 fallback」
  //     の順で取得方針を決め、同一 URL は dedupe して 1 回だけ fetch
  // ──────────────────────────────────────────────────────────────
  const LANES = ['top', 'bottom'];
  const emptyLane = wantLang => ({
    wantLang,
    resolvedLang: null,
    // 'native' (希望言語の手動字幕)
    // | 'asr'    (希望言語の自動生成字幕)
    // | 'translated' (別言語の字幕 + tlang)
    // | 'none'   (取得不能)
    source: 'none',
    cues: [],
  });

  const CaptionStore = (() => {
    let state = {
      videoId: null,
      // 'idle' | 'loading' | 'ready' | 'no-captions' | 'error'
      status: 'idle',
      captionTracks: [],
      isLive: false,
      lanes: { top: emptyLane(null), bottom: emptyLane(null) },
    };
    let loadSeq = 0;
    const listeners = new Set();

    function emit() {
      for (const fn of listeners) {
        try { fn(state); } catch (e) { console.warn('[dualsub] listener error', e); }
      }
    }
    function set(patch) {
      state = { ...state, ...patch };
      emit();
    }

    // 一つの言語コード(必ず明示指定、'auto' は無い)に対して、
    // 「同言語の手動 > 同言語の asr > 別言語の手動 + tlang」の順で
    // ベストな取得プランを返す。
    function resolveLane(tracks, wantLang) {
      if (!tracks?.length || !wantLang) return null;
      const preferManual = list => list.find(t => t.kind !== 'asr') || list[0];
      const matches = tracks.filter(t =>
        t.languageCode === wantLang || t.languageCode.startsWith(wantLang + '-'));
      if (matches.length) {
        const t = preferManual(matches);
        return {
          track: t, tlang: null,
          resolvedLang: t.languageCode,
          source: t.kind === 'asr' ? 'asr' : 'native',
        };
      }
      const base = preferManual(tracks);
      return {
        track: base, tlang: wantLang,
        resolvedLang: wantLang,
        source: 'translated',
      };
    }

    async function fetchInnertube(videoId) {
      const r = await fetch(INNERTUBE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
      });
      if (!r.ok) throw new Error(`innertube ${r.status}`);
      return r.json();
    }

    function planUrl(plan) {
      const u = new URL(plan.track.baseUrl);
      u.searchParams.set('fmt', 'srv3');
      if (plan.tlang) u.searchParams.set('tlang', plan.tlang);
      return u.toString();
    }

    async function load(videoId, wantLangs) {
      const seq = ++loadSeq;
      const lanesEmpty = {
        top:    emptyLane(wantLangs.top),
        bottom: emptyLane(wantLangs.bottom),
      };
      if (!videoId) {
        set({ videoId: null, status: 'idle', captionTracks: [], isLive: false, lanes: lanesEmpty });
        return;
      }
      set({ videoId, status: 'loading', captionTracks: [], isLive: false, lanes: lanesEmpty });
      try {
        const data = await fetchInnertube(videoId);
        if (seq !== loadSeq) return;
        const isLive = !!data?.videoDetails?.isLive;
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!tracks.length) {
          set({ status: 'no-captions', captionTracks: tracks, isLive, lanes: lanesEmpty });
          return;
        }
        const plans = {
          top:    resolveLane(tracks, wantLangs.top),
          bottom: resolveLane(tracks, wantLangs.bottom),
        };
        // Dedupe: 同じ URL は 1 回だけ fetch
        const xmlCache = new Map();
        async function fetchPlan(plan) {
          if (!plan) return [];
          const url = planUrl(plan);
          if (!xmlCache.has(url)) {
            xmlCache.set(url, fetch(url, { credentials: 'include' }).then(r => {
              if (!r.ok) throw new Error(`timedtext ${r.status}`);
              return r.text();
            }));
          }
          const xml = await xmlCache.get(url);
          return parseSrv3(xml);
        }
        const [topCues, bottomCues] = await Promise.all([
          fetchPlan(plans.top),
          fetchPlan(plans.bottom),
        ]);
        if (seq !== loadSeq) return;
        const lanes = {
          top: plans.top ? {
            wantLang: wantLangs.top,
            resolvedLang: plans.top.resolvedLang,
            source: plans.top.source,
            cues: topCues,
          } : emptyLane(wantLangs.top),
          bottom: plans.bottom ? {
            wantLang: wantLangs.bottom,
            resolvedLang: plans.bottom.resolvedLang,
            source: plans.bottom.source,
            cues: bottomCues,
          } : emptyLane(wantLangs.bottom),
        };
        set({ status: 'ready', captionTracks: tracks, isLive, lanes });
      } catch (e) {
        if (seq !== loadSeq) return;
        console.warn('[dualsub] caption load failed:', e.message);
        set({ status: 'error' });
      }
    }

    return {
      load,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get state() { return state; },
      cueAt(ms) {
        return {
          top:    cueAt(state.lanes.top.cues, ms),
          bottom: cueAt(state.lanes.bottom.cues, ms),
        };
      },
    };
  })();

  // ──────────────────────────────────────────────────────────────
  // Page / Player detection
  // ──────────────────────────────────────────────────────────────
  // 通常の動画再生ページ(watch / embed / v)でのみ UI を出す。
  // shorts はスワイプ操作・自動再生・縦動画 UI が前提で字幕オーバーレイの
  // 価値が薄く、ホームや検索結果でも hover プレビューで <video> が存在する
  // ため、DOM ではなく URL で判定する。
  function isWatchPage() {
    const path = location.pathname;
    if (path === '/watch') return true;                   // /watch?v=...
    if (/^\/(embed|v)\/[^/?&#]+/.test(path)) return true; // /embed/ID, /v/ID
    return false;
  }

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
  function findVideo() {
    return player?.querySelector('video') || document.querySelector('video');
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
    // YT 純正字幕は常に非表示(プレーヤーがマウントされている間のみ)
    document.body.classList.toggle('dualsub-active', !!player);
  }

  function clearOverlay() {
    overlayOriginal.textContent = '';
    overlayTranslated.textContent = '';
    overlayOriginal.classList.remove('ds-placeholder');
    overlayTranslated.classList.remove('ds-placeholder');
  }

  function renderPlaceholder(msg) {
    overlayOriginal.textContent = '';
    overlayOriginal.classList.remove('ds-placeholder');
    overlayTranslated.textContent = msg;
    overlayTranslated.classList.add('ds-placeholder');
  }

  function updateOverlay() {
    if (!config.enabled || !player) {
      clearOverlay();
      return;
    }
    const s = CaptionStore.state;
    if (s.status === 'idle' || s.status === 'loading') {
      clearOverlay();
      return;
    }
    if (s.status === 'no-captions') {
      renderPlaceholder(s.isLive ? '字幕なし(ライブ)' : '字幕なし');
      return;
    }
    if (s.status === 'error') {
      renderPlaceholder('字幕取得失敗');
      return;
    }
    const video = findVideo();
    if (!video) { clearOverlay(); return; }
    const ms = (video.currentTime || 0) * 1000;
    const { top, bottom } = CaptionStore.cueAt(ms);
    overlayOriginal.textContent = top;
    overlayTranslated.textContent = bottom;
    overlayOriginal.classList.remove('ds-placeholder');
    overlayTranslated.classList.remove('ds-placeholder');
  }

  function maybeHandleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(syncMountState, 500);
  }

  // Show the bar/overlay only on watch pages. Also detects videoId changes
  // (SPA navigation) and triggers CaptionStore reload.
  function syncMountState() {
    // 1) Watch ページ以外なら UI を出さない(ホームや検索結果ではプレビュー
    //    再生で <video> が存在するため、findPlayer だけでは不十分)
    const onWatch = isWatchPage();
    const found = onWatch ? findPlayer() : null;

    if (!found) {
      ui.panel.style.display = 'none';
      overlay.style.display = 'none';
      document.body.classList.remove('dualsub-active');
      player = null;
      playerResizeObs?.disconnect();
      playerResizeObs = null;
      // 動画ページから外れたタイミングで CaptionStore も idle に戻す。
      if (!onWatch && CaptionStore.state.videoId !== null) {
        CaptionStore.load(null, { top: config.topLang, bottom: config.bottomLang });
      }
      return;
    }

    const alreadyMounted = player === found
      && document.body.contains(ui.panel)
      && found.contains(overlay);
    if (alreadyMounted) {
      ui.panel.style.display = '';
      applyOverlayStyle();
      maybeReloadCaptions();
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

    maybeReloadCaptions();
  }

  function maybeReloadCaptions() {
    const videoId = getCurrentVideoId();
    if (!videoId) return;
    if (videoId !== CaptionStore.state.videoId) {
      CaptionStore.load(videoId, { top: config.topLang, bottom: config.bottomLang });
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Styles
  // ──────────────────────────────────────────────────────────────
  function buildStyle() {
    const s = el('style');
    s.textContent = `
      :root {
        /* Theme — accent palette */
        --ds-accent:        #4fc3f7;
        --ds-accent-soft:   var(--ds-accent-soft);   /* slider thumb halo / focus ring */
        --ds-accent-glow:   rgba(79,195,247,0.45);   /* pulse / hover glow */

        /* Status — loading (warning) */
        --ds-warn:          #ffb74d;
        --ds-warn-border:   rgba(255,183,77,0.65);
        --ds-warn-glow:     rgba(255,183,77,0.4);

        /* Status — error */
        --ds-error:         #ef5350;
        --ds-error-border:  rgba(239,83,80,0.7);

        /* Surfaces */
        --ds-bg:            rgba(15,18,24,0.78);
        --ds-bg-strong:     rgba(15,18,24,0.92);

        /* Lines / text */
        --ds-border:        rgba(255,255,255,0.12);
        --ds-text:          #f3f5f8;
        --ds-text-dim:      rgba(243,245,248,0.55);
      }

      /* While DualSub is mounted, hide YouTube's native caption rendering
         (we replace it with our own — always, regardless of overlay toggle). */
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
      #dualsub-overlay .ds-translated.ds-placeholder { opacity: 0.6; font-weight: 600; }
      #dualsub-overlay .ds-original:empty,
      #dualsub-overlay .ds-translated:empty { display: none; }

      /* Bar + panel */
      #dualsub-panel {
        position: fixed;
        bottom: max(10px, env(safe-area-inset-bottom, 10px));
        left: 50%; transform: translateX(-50%);
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic UI", Roboto, sans-serif;
        font-size: 12px; color: var(--ds-text);
        display: flex; flex-direction: column-reverse; align-items: stretch;
        width: min(440px, calc(100vw - 16px));
        box-sizing: border-box;
      }
      #dualsub-toggle {
        box-sizing: border-box; cursor: pointer; pointer-events: auto;
        width: 100%; height: 44px;
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        padding: 0 12px;
        background: linear-gradient(135deg, var(--ds-bg) 0%, var(--ds-bg-strong) 100%);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1px solid var(--ds-border);
        border-radius: 22px;
        box-shadow:
          0 8px 24px rgba(0,0,0,0.45),
          0 2px 6px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.08);
        transition: transform 0.18s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.18s ease, border-color 0.18s ease;
        color: var(--ds-text);
        font: inherit; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #dualsub-toggle:hover {
        border-color: rgba(255,255,255,0.2);
        box-shadow:
          0 12px 32px rgba(0,0,0,0.55),
          0 4px 10px rgba(0,0,0,0.35),
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 0 0 3px var(--ds-accent-glow);
      }
      #dualsub-toggle:focus-visible { outline: 2px solid var(--ds-accent); outline-offset: 2px; }
      /* バー全体に状態色を反映(脈動 = loading) */
      #dualsub-toggle.ds-loading { border-color: var(--ds-warn-border); animation: ds-bar-pulse 1.1s ease-out infinite; }
      #dualsub-toggle.ds-error   { border-color: var(--ds-error-border); }
      @keyframes ds-bar-pulse {
        0%   { box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 0 var(--ds-warn-glow); }
        70%  { box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 6px transparent; }
        100% { box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 0 transparent; }
      }

      .ds-bar-left  { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
      .ds-bar-right { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

      .ds-brand {
        font-weight: 700; letter-spacing: 0.01em; font-size: 13px;
        color: var(--ds-text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ds-brand .ds-accent { color: var(--ds-accent); }

      .ds-lang-pair {
        display: flex; align-items: center; gap: 5px;
        padding: 3px 9px;
        background: rgba(255,255,255,0.06);
        border: 1px solid var(--ds-border);
        border-radius: 999px;
        font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .ds-lang-pair .ds-arrow       { color: var(--ds-text-dim); font-weight: 400; opacity: 0.6; }
      .ds-lang-pair .ds-lang-top    { color: var(--ds-top-color, #fff); }
      .ds-lang-pair .ds-lang-bottom { color: var(--ds-bottom-color, #4fc3f7); }

      .ds-chevron {
        width: 14px; height: 14px; color: var(--ds-text-dim);
        transition: transform 0.25s cubic-bezier(0.2,0.8,0.2,1), color 0.18s;
        flex: 0 0 auto;
      }
      #dualsub-panel.dualsub-open .ds-chevron { transform: rotate(180deg); color: var(--ds-accent); }

      #dualsub-body {
        margin-bottom: 8px; width: 100%;
        box-sizing: border-box;
        overflow-y: auto;
        background: linear-gradient(180deg, var(--ds-bg-strong) 0%, var(--ds-bg) 100%);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--ds-border);
        border-radius: 16px;
        padding: 12px 14px;
        display: none;
        box-shadow: 0 -10px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
        opacity: 0; transform: translateY(6px);
        transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.2,0.8,0.2,1);
      }
      #dualsub-panel.dualsub-open #dualsub-body { display: block; opacity: 1; transform: translateY(0); }

      .ds-body-header {
        font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--ds-text-dim);
        margin-bottom: 10px; padding-bottom: 7px;
        border-bottom: 1px solid var(--ds-border);
      }
      .ds-grid { display: flex; flex-direction: column; gap: 8px; }
      .ds-row  { display: flex; flex-direction: column; gap: 4px; min-width: 0; }

      .ds-group {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
        padding: 8px 10px 10px;
        background: rgba(255,255,255,0.025);
        border: 1px solid var(--ds-border);
        border-radius: 10px;
        min-width: 0;
      }
      .ds-group-header {
        grid-column: 1 / -1;
        display: flex; align-items: center; gap: 6px;
        font-size: 9px; font-weight: 700;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--ds-text-dim);
        padding-bottom: 2px;
      }
      .ds-group-dot {
        width: 8px; height: 8px; border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.18), 0 0 6px currentColor;
      }
      .ds-group .ds-row.ds-wide { grid-column: 1 / -1; }
      .ds-group-top    .ds-group-dot { color: var(--ds-top-color,    #fff);     background: var(--ds-top-color,    #fff);     }
      .ds-group-bottom .ds-group-dot { color: var(--ds-bottom-color, #4fc3f7);  background: var(--ds-bottom-color, #4fc3f7);  }

      .ds-label {
        display: flex; justify-content: space-between; align-items: baseline;
        color: var(--ds-text-dim); font-size: 10px;
        font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ds-value { color: var(--ds-accent); font-size: 10px; font-weight: 600; }

      .ds-row select,
      .ds-row input[type=range],
      .ds-row input[type=color] {
        width: 100%; box-sizing: border-box; outline: none;
        background: rgba(255,255,255,0.06);
        color: var(--ds-text);
        border: 1px solid var(--ds-border);
        border-radius: 8px;
        font-size: 12px;
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .ds-row select {
        padding: 7px 24px 7px 9px; height: 32px;
        appearance: none; -webkit-appearance: none;
        background-image:
          linear-gradient(45deg,  transparent 50%, var(--ds-text-dim) 50%),
          linear-gradient(135deg, var(--ds-text-dim) 50%, transparent 50%);
        background-position: calc(100% - 13px) 50%, calc(100% - 9px) 50%;
        background-size: 4px 4px, 4px 4px;
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
        width: 18px; height: 18px; border-radius: 50%;
        background: var(--ds-accent);
        margin-top: -7px;
        box-shadow: 0 0 0 4px var(--ds-accent-soft), 0 2px 6px rgba(0,0,0,0.4);
        cursor: pointer; transition: transform 0.12s ease;
      }
      .ds-row input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.12); }
      .ds-row input[type=range]::-moz-range-track { height: 4px; border-radius: 999px; background: rgba(255,255,255,0.12); }
      .ds-row input[type=range]::-moz-range-thumb {
        width: 18px; height: 18px; border-radius: 50%; border: none;
        background: var(--ds-accent);
        box-shadow: 0 0 0 4px var(--ds-accent-soft);
        cursor: pointer;
      }
      .ds-row input[type=color] { height: 30px; padding: 3px; cursor: pointer; }
      .ds-row input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
      .ds-row input[type=color]::-webkit-color-swatch { border: none; border-radius: 5px; }

      /* Switch (used both on the bar and elsewhere) */
      .ds-switch { position: relative; display: inline-block; width: 38px; height: 22px; flex: 0 0 auto; }
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

      /* 狭幅(< 400px):2 列 → 1 列、フォントと余白をさらに詰める */
      @media (max-width: 400px) {
        #dualsub-panel { width: calc(100vw - 12px); font-size: 11px; }
        #dualsub-toggle { padding: 0 10px; height: 42px; gap: 6px; }
        .ds-brand { font-size: 12px; }
        .ds-lang-pair { padding: 2px 7px; font-size: 9px; gap: 4px; }
        .ds-chevron { width: 13px; height: 13px; }
        #dualsub-body { padding: 10px 12px; border-radius: 14px; }
        .ds-group { grid-template-columns: 1fr; gap: 6px; padding: 8px 10px; }
        .ds-grid { gap: 6px; }
        .ds-row select { font-size: 12px; height: 30px; }
      }
    `;
    return s;
  }

  // ──────────────────────────────────────────────────────────────
  // UI factory
  // ──────────────────────────────────────────────────────────────
  const fmtSize = v => {
    const d = v * 10;
    return (d === Math.floor(d) ? d.toFixed(0) : d.toFixed(1)) + '%';
  };

  function buildLangSelect(value) {
    const s = el('select');
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
    // バー上の ON/OFF スイッチ(設定パネルを開かずに切り替え可能)
    const cbEnabled = el('input', { type: 'checkbox', checked: config.enabled });
    const barSwitch = el('label', { className: 'ds-switch', 'aria-label': '字幕オン/オフ' }, [
      cbEnabled, el('span', { className: 'ds-switch-slider' }),
    ]);
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

    // バーは div(button だと内側 label+input がネスト interactive で invalid)。
    // 展開クリックはバー全体で受け、ds-switch 内クリックだけ無視する。
    const toggleBtn = el('div', { id: 'dualsub-toggle', role: 'button', tabindex: '0' }, [
      el('span', { className: 'ds-bar-left'  }, [barSwitch, brand]),
      el('span', { className: 'ds-bar-right' }, [langPair, chevron]),
    ]);

    const selTopLang   = buildLangSelect(config.topLang);
    const inTopColor   = el('input', { type: 'color', value: config.topColor });
    const inTopSize    = el('input', { type: 'range', min: '1', max: '10', step: '0.25', value: String(config.topFontSize) });
    const topSizeVal   = el('span', { className: 'ds-value' }, [fmtSize(config.topFontSize)]);
    const topGroup     = buildGroup('top', selTopLang, inTopColor, inTopSize, topSizeVal);

    const selBottomLang = buildLangSelect(config.bottomLang);
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

    const grid = el('div', { className: 'ds-grid' }, [topGroup, bottomGroup, rowPos, rowBgOpacity]);
    const body = el('div', { id: 'dualsub-body' }, [
      el('div', { className: 'ds-body-header' }, ['Subtitle Settings']),
      grid,
    ]);
    const panel = el('div', { id: 'dualsub-panel' }, [toggleBtn, body]);

    return {
      panel, toggleBtn, langTop, langBottom,
      inputs: { cbEnabled, selTopLang, selBottomLang, inTopColor, inBottomColor, inTopSize, inBottomSize, inPos, inBgOpacity },
      vals:   { topSizeVal, bottomSizeVal, posVal, bgOpacityVal },
    };
  }

  const ui = buildUI();

  // ──────────────────────────────────────────────────────────────
  // UI sync helpers
  // ──────────────────────────────────────────────────────────────
  // バー自体に状態クラスを付け、ロード状態を視覚化(loading 中はアクセント色の脈動)
  function syncBarStatus() {
    const s = CaptionStore.state.status;
    const cls = ui.toggleBtn.classList;
    cls.toggle('ds-off',     !config.enabled);
    cls.toggle('ds-loading', config.enabled && s === 'loading');
    cls.toggle('ds-error',   config.enabled && s === 'error');
  }

  function updateLangPair() {
    ui.langTop.textContent    = config.topLang.toUpperCase();
    ui.langBottom.textContent = config.bottomLang.toUpperCase();
  }

  function onUiInput() {
    const { inputs, vals } = ui;
    const prevTopLang    = config.topLang;
    const prevBottomLang = config.bottomLang;

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
    syncBarStatus();

    // 言語変更があれば字幕を取り直す。
    if (prevTopLang !== config.topLang || prevBottomLang !== config.bottomLang) {
      const videoId = getCurrentVideoId();
      if (videoId) CaptionStore.load(videoId, { top: config.topLang, bottom: config.bottomLang });
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────
  const styleEl = buildStyle();
  document.head.appendChild(styleEl);

  ui.panel.style.display = 'none';
  overlay.style.display = 'none';
  document.body.appendChild(ui.panel);

  updateLangPair();
  syncBarStatus();
  applyOverlayStyle();
  syncMountState();

  function updatePanelMaxHeight() {
    const body = ui.panel.querySelector('#dualsub-body');
    if (body) body.style.maxHeight = `${Math.max(240, window.innerHeight - 120)}px`;
  }
  updatePanelMaxHeight();
  window.addEventListener('resize', updatePanelMaxHeight);
  cleanups.push(() => window.removeEventListener('resize', updatePanelMaxHeight));

  // 字幕状態の変化(loading/ready/error)を UI に反映。
  const offCaption = CaptionStore.onChange(() => {
    updateLangPair();
    syncBarStatus();
    updateOverlay();
  });
  cleanups.push(offCaption);

  // 表示更新ループ。currentTime ベースなので軽量(DOM 走査も翻訳 fetch も無い)。
  const poll = setInterval(() => {
    maybeHandleNavigation();
    syncMountState();
    updateOverlay();
  }, POLL_MS);
  cleanups.push(() => clearInterval(poll));

  cleanups.push(() => playerResizeObs?.disconnect());

  for (const inp of Object.values(ui.inputs)) {
    inp.addEventListener('input', onUiInput);
    inp.addEventListener('change', onUiInput);
  }
  // バークリックでパネル展開。ただしバー内のスイッチ操作は除外。
  ui.toggleBtn.addEventListener('click', (e) => {
    if (e.target.closest('.ds-switch')) return;
    ui.panel.classList.toggle('dualsub-open');
  });
  // キーボードアクセシビリティ: Enter / Space で展開
  ui.toggleBtn.addEventListener('keydown', (e) => {
    if (e.target.closest('.ds-switch')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ui.panel.classList.toggle('dualsub-open');
    }
  });

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

  // デバッグ用: 内部状態の覗き見
  window.__dualsubState = () => ({ config: { ...config }, caption: CaptionStore.state });

  console.log('[dualsub] ready · stop with __dualsubStop()');
})();
