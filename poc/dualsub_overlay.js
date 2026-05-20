// YouTube 二か国語字幕 - ブラウザ PoC
//
// 動作:
//   1. YouTube が表示する字幕(原文)を DOM スクレイピングで取得
//   2. Google翻訳の無認証エンドポイント(client=gtx)で翻訳
//   3. 動画上に原文+翻訳の2行をピル状の半透明ボックスで自前描画
//   4. 画面下部の常駐バーから設定パネルを開いて言語・色・サイズを調整可
//   5. YouTube の CC ボタンと表示ON/OFFを双方向同期
//
// 使い方:
//   - DevTools Console に全文貼り付けて Enter
//   - 停止: __dualsubStop()
//
// 設計メモ:
//   - Trusted Types CSP のため innerHTML 不使用 (DOM API のみ)
//   - YouTube の captionTracks 直 fetch は PoToken で 0byte になるため
//     原文取得は .ytp-caption-segment の DOM スクレイピングのみ
//   - 翻訳エンドポイントは client=gtx (無認証だがレートリミットあり)

(() => {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================
  const STORAGE_KEY = 'dualsub-config-v1';

  const DEFAULT_CONFIG = {
    enabled: true,
    // Top (上の字幕): YouTube が描画する原文 + その色とサイズ
    topLang: 'auto',
    topColor: '#ffffff',
    topFontSize: 3.5,       // プレーヤー高さに対する % (1.0-10.0)
    // Bottom (下の字幕): 翻訳テキスト + その色とサイズ
    bottomLang: 'en',
    bottomColor: '#4fc3f7',
    bottomFontSize: 3.0,
    // 共通
    overlayBottom: 15,      // 下端からの % (位置)
    bgOpacity: 60,          // 字幕背後の半透明黒ボックスの濃さ %
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
    captions: ['.ytp-caption-segment', '.caption-visual-line', '[class*="caption-segment"]'],
    ccButton: '.ytp-subtitles-button, .ytp-subtitles-button-icon',
  };

  // ============================================================
  // 多重インストールガード + プレーヤー検出
  // ============================================================
  if (window.__dualsubInstalled) {
    console.log('既にインストール済み。停止するには __dualsubStop() を実行してください。');
    return;
  }
  const player = document.querySelector(SEL.player);
  if (!player) {
    console.error('[dualsub] プレーヤー要素が見つかりません');
    return;
  }
  window.__dualsubInstalled = true;

  // ============================================================
  // 状態
  // ============================================================
  const state = {
    lastText: '',           // 直近の原文(差分検知用)
    updateSeq: 0,           // 翻訳完了の競合解決用シーケンス番号
    lastVideoUrl: location.href,
    suppressCcEcho: false,  // 我々→YT クリック直後の YT→我々 同期を抑制
    ccBtnObserver: null,    // CC ボタンの aria-pressed 監視
    ccBtnRef: null,         // 監視中の CC ボタン要素
  };
  const cleanups = [];      // 停止時に呼ぶ teardown 関数群

  // ============================================================
  // 設定 (load/save/migrate)
  // ============================================================
  function migrate(saved) {
    if (!saved) return saved;
    // 旧 sourceLang/targetLang/overlayColor/overlayFontSize
    if (saved.targetLang && !saved.bottomLang) saved.bottomLang = saved.targetLang;
    if (saved.sourceLang && !saved.topLang) saved.topLang = saved.sourceLang;
    if (saved.overlayColor && !saved.bottomColor) saved.bottomColor = saved.overlayColor;
    if (saved.overlayFontSize) {
      if (!saved.bottomFontSize) saved.bottomFontSize = saved.overlayFontSize;
      if (!saved.topFontSize) saved.topFontSize = saved.overlayFontSize + 2;
    }
    delete saved.targetLang;
    delete saved.sourceLang;
    delete saved.overlayColor;
    delete saved.overlayFontSize;
    delete saved.shadowStrength;  // 背景色方式に変更されたので破棄
    // フォントサイズが旧 px 値 (>10) で保存されていれば % へリセット
    if (typeof saved.topFontSize === 'number' && saved.topFontSize > 10) delete saved.topFontSize;
    if (typeof saved.bottomFontSize === 'number' && saved.bottomFontSize > 10) delete saved.bottomFontSize;
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

  // ============================================================
  // DOM ヘルパー (Trusted Types 対応のため innerHTML 不使用)
  // ============================================================
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

  // ============================================================
  // 翻訳サービス
  // ============================================================
  const Translator = (() => {
    const cache = new Map();
    const MAX_CACHE = 500;

    function setCached(key, val) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, val);
    }

    async function translate(text, target, source) {
      const key = `${source}::${target}::${text}`;
      if (cache.has(key)) return cache.get(key);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const translated = data[0].map(seg => seg[0]).join('');
        setCached(key, translated);
        return translated;
      } catch (e) {
        console.warn('[dualsub] 翻訳エラー:', e.message);
        return null;
      }
    }

    return { translate };
  })();

  // ============================================================
  // 字幕 DOM スクレイパー
  // ============================================================
  function getCurrentCaption() {
    for (const sel of SEL.captions) {
      const els = document.querySelectorAll(sel);
      if (els.length) return [...els].map(e => e.textContent).join(' ').trim();
    }
    return '';
  }

  // ============================================================
  // CC ボタン双方向同期
  // ============================================================
  const CC = (() => {
    function getBtn() { return document.querySelector(SEL.ccButton); }

    // 我々→YT: config.enabled に YT を追従させる
    function syncToYt() {
      const btn = getBtn();
      if (!btn) return false;
      const ytOn = btn.getAttribute('aria-pressed') === 'true';
      const disabled = btn.getAttribute('aria-disabled') === 'true';
      if (config.enabled && !ytOn && !disabled) {
        state.suppressCcEcho = true;
        btn.click();
        console.log('[dualsub] CC を ON に同期');
        setTimeout(() => { state.suppressCcEcho = false; }, 200);
      } else if (!config.enabled && ytOn) {
        state.suppressCcEcho = true;
        btn.click();
        console.log('[dualsub] CC を OFF に同期');
        setTimeout(() => { state.suppressCcEcho = false; }, 200);
      } else if (config.enabled && disabled) {
        console.log('[dualsub] この動画には字幕がありません');
      }
      return true;
    }

    function syncToYtWithRetry(retries = 30) {
      if (!syncToYt() && retries > 0) {
        setTimeout(() => syncToYtWithRetry(retries - 1), 200);
      }
    }

    // YT→我々: CC ボタンの aria-pressed 変化を検知
    function watch(onChange, retries = 30) {
      const btn = getBtn();
      if (!btn) {
        if (retries > 0) setTimeout(() => watch(onChange, retries - 1), 200);
        return;
      }
      if (state.ccBtnRef === btn) return;
      if (state.ccBtnObserver) state.ccBtnObserver.disconnect();
      state.ccBtnRef = btn;
      state.ccBtnObserver = new MutationObserver(() => {
        if (state.suppressCcEcho) return;
        const ytOn = btn.getAttribute('aria-pressed') === 'true';
        if (ytOn !== config.enabled) {
          console.log(`[dualsub] YT 側 CC ${ytOn ? 'ON' : 'OFF'} 検知 → 同期`);
          onChange(ytOn);
        }
      });
      state.ccBtnObserver.observe(btn, { attributes: true, attributeFilter: ['aria-pressed', 'aria-disabled'] });
    }

    return { syncToYt, syncToYtWithRetry, watch };
  })();

  // ============================================================
  // オーバーレイ(原文 + 翻訳の2行を player 上に描画)
  // ============================================================
  const overlay = el('div', { id: 'dualsub-overlay' });
  const overlayOriginal = el('div', { className: 'ds-original' });
  const overlayTranslated = el('div', { className: 'ds-translated' });
  overlay.appendChild(overlayOriginal);
  overlay.appendChild(overlayTranslated);

  function computeFontSizes() {
    const h = player.clientHeight || 360;
    const topPx = Math.max(8, h * (config.topFontSize / 100));
    const bottomPx = Math.max(8, h * (config.bottomFontSize / 100));
    const root = document.documentElement;
    root.style.setProperty('--ds-top-size', `${topPx.toFixed(1)}px`);
    root.style.setProperty('--ds-bottom-size', `${bottomPx.toFixed(1)}px`);
  }

  function applyOverlayStyle() {
    const root = document.documentElement;
    root.style.setProperty('--ds-overlay-bottom', `${config.overlayBottom}%`);
    root.style.setProperty('--ds-top-color', config.topColor);
    root.style.setProperty('--ds-bottom-color', config.bottomColor);
    root.style.setProperty('--ds-bg-opacity', String(config.bgOpacity / 100));
    computeFontSizes();
    overlay.style.display = config.enabled ? 'block' : 'none';
    document.body.classList.toggle('dualsub-active', config.enabled);
  }

  function clearOverlay() {
    overlayOriginal.textContent = '';
    overlayTranslated.textContent = '';
  }

  async function updateOverlay() {
    maybeHandleNavigation();
    if (!config.enabled) {
      clearOverlay();
      state.lastText = '';
      return;
    }
    const text = getCurrentCaption();
    if (text === state.lastText) return;
    state.lastText = text;
    if (!text) {
      clearOverlay();
      return;
    }
    // 原文は即時表示、翻訳は非同期
    overlayOriginal.textContent = text;
    overlayTranslated.style.opacity = '0.4';

    const seq = ++state.updateSeq;
    const translated = await Translator.translate(text, config.bottomLang, config.topLang);
    if (seq !== state.updateSeq) return;  // 既に次の字幕に進んでいたら破棄
    overlayTranslated.style.opacity = '1';
    overlayTranslated.textContent = translated || '';
  }

  // 動画切替(SPA 遷移)時の追従
  function maybeHandleNavigation() {
    if (location.href === state.lastVideoUrl) return;
    state.lastVideoUrl = location.href;
    setTimeout(() => {
      CC.syncToYt();
      CC.watch(onCcExternalChange);  // ボタン要素が差し替わっている可能性
    }, 500);
  }

  // ============================================================
  // スタイル
  // ============================================================
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

      /* ==== Unified モード: YouTube 純正字幕を非表示 ==== */
      body.dualsub-active .caption-window,
      body.dualsub-active .ytp-caption-window-container,
      body.dualsub-active .ytp-caption-window-bottom,
      body.dualsub-active .caption-visual-line,
      body.dualsub-active .captions-text {
        visibility: hidden !important;
      }

      /* ==== 字幕オーバーレイ ==== */
      #dualsub-overlay {
        position: absolute;
        bottom: var(--ds-overlay-bottom, 15%);
        left: 0; right: 0;
        display: flex; flex-direction: column;
        align-items: center; gap: 6px;
        pointer-events: none;
        z-index: 60;
        padding: 4px 24px;
        font-family: "YouTube Noto", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", Roboto, "Arial Unicode Ms", Arial, sans-serif;
        transition: opacity 0.15s;
      }
      #dualsub-overlay .ds-original,
      #dualsub-overlay .ds-translated {
        display: block;
        width: fit-content;
        max-width: 100%;
        margin-left: auto;
        margin-right: auto;
        align-self: center;
        text-align: center;
        font-weight: 700;
        line-height: 1.35;
        padding: 2px 12px;
        border-radius: 6px;
        background-color: rgba(0, 0, 0, var(--ds-bg-opacity, 0.6));
        text-shadow:
          1px 1px 3px rgba(0,0,0, 0.45),
          0 0 8px rgba(0,0,0, 0.3),
          -1px -1px 0 rgba(0,0,0, 0.2),
          1px -1px 0 rgba(0,0,0, 0.2);
        white-space: pre-wrap;
        transition: opacity 0.15s, background-color 0.15s;
        box-sizing: border-box;
      }
      #dualsub-overlay .ds-original {
        color: var(--ds-top-color, #ffffff);
        font-size: var(--ds-top-size, 22px);
      }
      #dualsub-overlay .ds-translated {
        color: var(--ds-bottom-color, #4fc3f7);
        font-size: var(--ds-bottom-size, 19px);
      }
      #dualsub-overlay .ds-original:empty,
      #dualsub-overlay .ds-translated:empty {
        display: none;
      }

      /* ==== 設定パネル(下部固定バー) ==== */
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

      /* ==== バー本体 ==== */
      #dualsub-toggle {
        all: unset; box-sizing: border-box; cursor: pointer;
        pointer-events: auto;
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
        transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
                    box-shadow 0.18s ease, border-color 0.18s ease;
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

      .ds-bar-left { display: flex; align-items: center; gap: 10px; }
      .ds-bar-right { display: flex; align-items: center; gap: 12px; }

      .ds-status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--ds-accent);
        box-shadow: 0 0 0 0 var(--ds-accent-glow);
        animation: ds-pulse 2.2s ease-out infinite;
      }
      .ds-status-dot.ds-off {
        background: rgba(255,255,255,0.25);
        animation: none; box-shadow: none;
      }
      @keyframes ds-pulse {
        0%   { box-shadow: 0 0 0 0 var(--ds-accent-glow); }
        70%  { box-shadow: 0 0 0 10px rgba(79,195,247,0); }
        100% { box-shadow: 0 0 0 0 rgba(79,195,247,0); }
      }

      .ds-brand {
        font-weight: 700; letter-spacing: 0.02em;
        font-size: 14px; color: var(--ds-text);
      }
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
      .ds-lang-pair .ds-arrow { color: var(--ds-text-dim); font-weight: 400; opacity: 0.6; }
      .ds-lang-pair .ds-lang-top { color: var(--ds-top-color, #fff); }
      .ds-lang-pair .ds-lang-bottom { color: var(--ds-bottom-color, #4fc3f7); }

      .ds-chevron {
        width: 16px; height: 16px;
        transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
        color: var(--ds-text-dim);
      }
      #dualsub-panel.dualsub-open .ds-chevron { transform: rotate(180deg); color: var(--ds-accent); }

      /* ==== 展開パネル ==== */
      #dualsub-body {
        margin-bottom: 10px; width: 100%;
        max-height: calc(100vh - 120px);
        overflow-y: auto;
        background: linear-gradient(180deg, var(--ds-bg-strong) 0%, var(--ds-bg) 100%);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--ds-border);
        border-radius: 20px;
        padding: 18px 18px 16px;
        display: none;
        box-shadow:
          0 -12px 40px rgba(0,0,0,0.5),
          inset 0 1px 0 rgba(255,255,255,0.06);
        opacity: 0; transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      #dualsub-panel.dualsub-open #dualsub-body {
        display: block; opacity: 1; transform: translateY(0);
      }

      .ds-body-header {
        font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--ds-text-dim);
        margin-bottom: 14px; padding-bottom: 10px;
        border-bottom: 1px solid var(--ds-border);
      }

      .ds-grid { display: flex; flex-direction: column; gap: 12px; }
      .ds-row { display: flex; flex-direction: column; gap: 6px; }

      /* グループカード(Top / Bottom) */
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
      .ds-group-top .ds-group-dot { color: var(--ds-top-color, #fff); background: var(--ds-top-color, #fff); }
      .ds-group-bottom .ds-group-dot { color: var(--ds-bottom-color, #4fc3f7); background: var(--ds-bottom-color, #4fc3f7); }

      .ds-label {
        display: flex; justify-content: space-between; align-items: baseline;
        color: var(--ds-text-dim); font-size: 11px;
        font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ds-value { color: var(--ds-accent); font-size: 11px; font-weight: 600; }

      .ds-row select, .ds-row input[type=range], .ds-row input[type=color] {
        width: 100%; box-sizing: border-box; outline: none;
        background: rgba(255,255,255,0.06);
        color: var(--ds-text);
        border: 1px solid var(--ds-border);
        border-radius: 10px;
        font-size: 13px;
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .ds-row select {
        padding: 8px 10px;
        appearance: none; -webkit-appearance: none;
        background-image: linear-gradient(45deg, transparent 50%, var(--ds-text-dim) 50%),
                          linear-gradient(135deg, var(--ds-text-dim) 50%, transparent 50%);
        background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
        background-size: 5px 5px, 5px 5px;
        background-repeat: no-repeat;
        padding-right: 28px;
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
      .ds-row input[type=range]::-webkit-slider-runnable-track {
        height: 4px; border-radius: 999px; background: rgba(255,255,255,0.12);
      }
      .ds-row input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 16px; height: 16px; border-radius: 50%;
        background: var(--ds-accent);
        margin-top: -6px;
        box-shadow: 0 0 0 4px rgba(79,195,247,0.15), 0 2px 6px rgba(0,0,0,0.4);
        cursor: pointer; transition: transform 0.12s ease;
      }
      .ds-row input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.15); }
      .ds-row input[type=range]::-moz-range-track {
        height: 4px; border-radius: 999px; background: rgba(255,255,255,0.12);
      }
      .ds-row input[type=range]::-moz-range-thumb {
        width: 16px; height: 16px; border-radius: 50%; border: none;
        background: var(--ds-accent);
        box-shadow: 0 0 0 4px rgba(79,195,247,0.15);
        cursor: pointer;
      }
      .ds-row input[type=color] { height: 36px; padding: 4px; cursor: pointer; }
      .ds-row input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
      .ds-row input[type=color]::-webkit-color-swatch { border: none; border-radius: 6px; }

      /* スイッチ */
      .ds-switch {
        position: relative; display: inline-block;
        width: 38px; height: 22px;
      }
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
        transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
        box-shadow: 0 2px 4px rgba(0,0,0,0.4);
      }
      .ds-switch input:checked + .ds-switch-slider { background: var(--ds-accent); }
      .ds-switch input:checked + .ds-switch-slider::before { transform: translateX(16px); }

      .ds-row.ds-toggle-row {
        flex-direction: row; align-items: center; justify-content: space-between;
        padding: 4px 0 8px;
        border-bottom: 1px solid var(--ds-border); margin-bottom: 4px;
      }
      .ds-row.ds-toggle-row .ds-label {
        flex: 1; color: var(--ds-text);
        font-size: 13px; text-transform: none; letter-spacing: 0;
      }
    `;
    return s;
  }

  // ============================================================
  // 設定 UI(設定パネル + バー)
  // ============================================================

  // 表示は実際の値の10倍 (例: 3.5% → "35%")。スライダー範囲は内部値のまま
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
    const labelChildren = valueSpan ? [el('span', {}, [labelText]), valueSpan] : [labelText];
    return el('div', { className: 'ds-row' + (opts.wide ? ' ds-wide' : '') }, [
      el('label', { className: 'ds-label' }, labelChildren),
      inputEl,
    ]);
  }

  function buildGroup(side, langSelect, colorInput, sizeInput, sizeValSpan) {
    const headerLabel = side === 'top' ? 'Top  ·  上の字幕' : 'Bottom  ·  下の字幕';
    return el('div', { className: `ds-group ds-group-${side}` }, [
      el('div', { className: 'ds-group-header' }, [
        el('span', { className: 'ds-group-dot' }),
        el('span', {}, [headerLabel]),
      ]),
      buildRow('言語', null, langSelect, { wide: true }),
      buildRow('色', null, colorInput),
      buildRow('サイズ', sizeValSpan, sizeInput),
    ]);
  }

  function buildUI() {
    // ----- バー -----
    const statusDot = el('span', { className: 'ds-status-dot' });
    const brand = el('span', { className: 'ds-brand' }, [
      'Dual', el('span', { className: 'ds-accent' }, ['Sub']),
    ]);
    const langTop = el('span', { className: 'ds-lang-top' });
    const langBottom = el('span', { className: 'ds-lang-bottom' });
    const langPair = el('span', { className: 'ds-lang-pair' }, [
      langTop, el('span', { className: 'ds-arrow' }, ['/']), langBottom,
    ]);
    const chevron = svg('svg', {
      class: 'ds-chevron', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor',
      'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, [svg('polyline', { points: '6 15 12 9 18 15' })]);
    const toggleBtn = el('button', { id: 'dualsub-toggle', type: 'button' }, [
      el('span', { className: 'ds-bar-left' }, [statusDot, brand]),
      el('span', { className: 'ds-bar-right' }, [langPair, chevron]),
    ]);

    // ----- パネル本体 -----
    const cbEnabled = el('input', { type: 'checkbox', checked: config.enabled });
    const rowEnabled = el('div', { className: 'ds-row ds-toggle-row' }, [
      el('span', { className: 'ds-label' }, ['オーバーレイ表示']),
      el('label', { className: 'ds-switch' }, [cbEnabled, el('span', { className: 'ds-switch-slider' })]),
    ]);

    // Top
    const selTopLang = buildLangSelect(true, config.topLang);
    const inTopColor = el('input', { type: 'color', value: config.topColor });
    const inTopSize = el('input', { type: 'range', min: '1', max: '10', step: '0.25', value: String(config.topFontSize) });
    const topSizeVal = el('span', { className: 'ds-value' }, [fmtSize(config.topFontSize)]);
    const topGroup = buildGroup('top', selTopLang, inTopColor, inTopSize, topSizeVal);

    // Bottom
    const selBottomLang = buildLangSelect(false, config.bottomLang);
    const inBottomColor = el('input', { type: 'color', value: config.bottomColor });
    const inBottomSize = el('input', { type: 'range', min: '1', max: '10', step: '0.25', value: String(config.bottomFontSize) });
    const bottomSizeVal = el('span', { className: 'ds-value' }, [fmtSize(config.bottomFontSize)]);
    const bottomGroup = buildGroup('bottom', selBottomLang, inBottomColor, inBottomSize, bottomSizeVal);

    // 共通: 位置 / 背景濃さ
    const inPos = el('input', { type: 'range', min: '0', max: '40', step: '1', value: String(config.overlayBottom) });
    const posVal = el('span', { className: 'ds-value' }, [`${config.overlayBottom}%`]);
    const rowPos = buildRow('位置(下からの%)', posVal, inPos);

    const inBgOpacity = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(config.bgOpacity) });
    const bgOpacityVal = el('span', { className: 'ds-value' }, [`${config.bgOpacity}%`]);
    const rowBgOpacity = buildRow('背景の濃さ', bgOpacityVal, inBgOpacity);

    const grid = el('div', { className: 'ds-grid' }, [
      rowEnabled, topGroup, bottomGroup, rowPos, rowBgOpacity,
    ]);
    const body = el('div', { id: 'dualsub-body' }, [
      el('div', { className: 'ds-body-header' }, ['Subtitle Settings']),
      grid,
    ]);
    const panel = el('div', { id: 'dualsub-panel' }, [toggleBtn, body]);

    return {
      panel, toggleBtn, statusDot, langTop, langBottom,
      inputs: { cbEnabled, selTopLang, selBottomLang, inTopColor, inBottomColor, inTopSize, inBottomSize, inPos, inBgOpacity },
      vals: { topSizeVal, bottomSizeVal, posVal, bgOpacityVal },
    };
  }

  // UI を構築
  const ui = buildUI();

  function syncStatusDot() {
    ui.statusDot.classList.toggle('ds-off', !config.enabled);
  }

  function updateLangPair() {
    ui.langTop.textContent = config.topLang === 'auto' ? 'AUTO' : config.topLang.toUpperCase();
    ui.langBottom.textContent = config.bottomLang.toUpperCase();
  }

  // 設定パネルの入力変更ハンドラ
  function onUiInput() {
    const wasEnabled = config.enabled;
    const { inputs, vals } = ui;
    config.enabled = inputs.cbEnabled.checked;
    config.topLang = inputs.selTopLang.value;
    config.bottomLang = inputs.selBottomLang.value;
    config.topColor = inputs.inTopColor.value;
    config.bottomColor = inputs.inBottomColor.value;
    config.topFontSize = parseFloat(inputs.inTopSize.value);
    config.bottomFontSize = parseFloat(inputs.inBottomSize.value);
    config.overlayBottom = parseInt(inputs.inPos.value, 10);
    config.bgOpacity = parseInt(inputs.inBgOpacity.value, 10);
    vals.topSizeVal.textContent = fmtSize(config.topFontSize);
    vals.bottomSizeVal.textContent = fmtSize(config.bottomFontSize);
    vals.posVal.textContent = `${config.overlayBottom}%`;
    vals.bgOpacityVal.textContent = `${config.bgOpacity}%`;
    saveConfig();
    applyOverlayStyle();
    updateLangPair();
    syncStatusDot();
    state.lastText = '';  // 翻訳キャッシュは活きるが再描画を強制
    if (wasEnabled !== config.enabled) CC.syncToYt();
  }

  // YT 側からの CC 変化を受けた時の処理
  function onCcExternalChange(ytOn) {
    config.enabled = ytOn;
    ui.inputs.cbEnabled.checked = ytOn;
    saveConfig();
    applyOverlayStyle();
    syncStatusDot();
    state.lastText = '';
  }

  // ============================================================
  // 初期化
  // ============================================================

  // スタイル → オーバーレイ → パネルの順で DOM に挿入
  const styleEl = buildStyle();
  document.head.appendChild(styleEl);
  applyOverlayStyle();
  player.appendChild(overlay);
  document.body.appendChild(ui.panel);

  // 初期 UI 状態を同期
  updateLangPair();
  syncStatusDot();

  // 字幕変化を MutationObserver + 200ms ポーリングで検知
  const captionObserver = new MutationObserver(updateOverlay);
  captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  cleanups.push(() => captionObserver.disconnect());

  const pollInterval = setInterval(updateOverlay, 200);
  cleanups.push(() => clearInterval(pollInterval));

  // プレーヤーサイズ追従(フォントサイズ再計算)
  const playerResizeObs = new ResizeObserver(computeFontSizes);
  playerResizeObs.observe(player);
  cleanups.push(() => playerResizeObs.disconnect());

  // CC ボタン双方向同期(初回 + 監視)
  CC.syncToYtWithRetry();
  CC.watch(onCcExternalChange);
  cleanups.push(() => state.ccBtnObserver?.disconnect());

  // フルスクリーン時はパネル非表示
  const onFsChange = () => {
    ui.panel.style.display = document.fullscreenElement ? 'none' : '';
  };
  document.addEventListener('fullscreenchange', onFsChange);
  cleanups.push(() => document.removeEventListener('fullscreenchange', onFsChange));

  // 入力イベント
  for (const inp of Object.values(ui.inputs)) {
    inp.addEventListener('input', onUiInput);
    inp.addEventListener('change', onUiInput);
  }
  ui.toggleBtn.addEventListener('click', () => {
    ui.panel.classList.toggle('dualsub-open');
  });

  // 停止 API
  window.__dualsubStop = () => {
    for (const fn of cleanups) {
      try { fn(); } catch (e) { console.warn('[dualsub] cleanup error', e); }
    }
    overlay.remove();
    ui.panel.remove();
    styleEl.remove();
    document.body.classList.remove('dualsub-active');
    window.__dualsubInstalled = false;
    delete window.__dualsubStop;
    console.log('dualsub 停止しました');
  };

  console.log('=== dualsub 起動 ===');
  console.log('画面下部の DualSub バーから設定パネルを開けます');
  console.log('停止: __dualsubStop()');
})();
