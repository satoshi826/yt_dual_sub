// caption_probe.js
// YouTube の captionTracks / timedtext / innertube が WebView・ブラウザから
// どこまで取れるかを確認するための検証スクリプト。
//
// 使い方:
//   1. m.youtube.com もしくは www.youtube.com で動画ページを開く
//   2. DevTools Console にこのファイルの中身を貼って Enter
//   3. ログを目視確認。最後にサマリが出る
//
// 何も書き換えない読み取り専用スクリプト。

(async () => {
  const log = (label, ...rest) => console.log(`%c[probe] ${label}`, 'color:#0af', ...rest);
  const warn = (label, ...rest) => console.warn(`%c[probe] ${label}`, 'color:#f80', ...rest);
  const ok   = (label, ...rest) => console.log(`%c[probe] ✅ ${label}`, 'color:#0c0', ...rest);
  const ng   = (label, ...rest) => console.log(`%c[probe] ❌ ${label}`, 'color:#f44', ...rest);

  const result = {
    videoId: null,
    ytInitialPlayerResponse: false,
    captionTracks: null,
    baseUrlDirect: null,
    baseUrlSrv3: null,
    baseUrlTlang: null,
    innertube: null,
  };

  // ---- 1. videoId 取得 -----------------------------------------------------
  const url = new URL(location.href);
  let videoId = url.searchParams.get('v');
  if (!videoId) {
    const m = location.pathname.match(/\/(?:watch|shorts|embed|v)\/([^/?&#]+)/);
    if (m) videoId = m[1];
  }
  if (!videoId) {
    const v = document.querySelector('video');
    if (v && v.src) {
      const m = v.src.match(/[?&]docid=([^&]+)/);
      if (m) videoId = m[1];
    }
  }
  result.videoId = videoId;
  if (!videoId) {
    ng('videoId が取れない。動画ページで実行してください');
    return;
  }
  ok('videoId', videoId);

  // ---- 2. ytInitialPlayerResponse 経由で captionTracks ---------------------
  let captionTracks = null;
  try {
    const ypr = window.ytInitialPlayerResponse
      || (window.ytplayer && ytplayer.config && ytplayer.config.args && JSON.parse(ytplayer.config.args.player_response || 'null'));
    if (ypr) {
      result.ytInitialPlayerResponse = true;
      captionTracks = ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
    }
  } catch (e) {
    warn('ytInitialPlayerResponse parse 失敗', e);
  }

  if (captionTracks && captionTracks.length) {
    ok(`captionTracks: ${captionTracks.length} 本`);
    result.captionTracks = captionTracks.map(t => ({
      languageCode: t.languageCode,
      name: t.name?.simpleText || t.name?.runs?.map(r => r.text).join('') || '',
      kind: t.kind || '',
      isTranslatable: t.isTranslatable,
      baseUrl: t.baseUrl,
    }));
    console.table(result.captionTracks.map(t => ({
      lang: t.languageCode,
      name: t.name,
      kind: t.kind,
      tlang_ok: t.isTranslatable,
    })));
  } else {
    ng('ytInitialPlayerResponse から captionTracks 取れず');
  }

  // pick a track for direct probes
  const track = captionTracks?.[0];

  // ---- 3. baseUrl 直 fetch (no params) ------------------------------------
  if (track?.baseUrl) {
    log('--- A: baseUrl 直 fetch (formatなし) ---');
    try {
      const r = await fetch(track.baseUrl, { credentials: 'include' });
      const body = await r.text();
      result.baseUrlDirect = { status: r.status, length: body.length, head: body.slice(0, 200) };
      if (body.length === 0) ng(`A: 0 byte (status=${r.status}) ← PoToken ブロックの典型`);
      else ok(`A: ${body.length} bytes (status=${r.status})`);
    } catch (e) {
      ng('A: fetch 例外', e.message);
      result.baseUrlDirect = { error: e.message };
    }
  }

  // ---- 4. baseUrl + fmt=srv3 ----------------------------------------------
  if (track?.baseUrl) {
    log('--- B: baseUrl + fmt=srv3 ---');
    try {
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'srv3');
      const r = await fetch(u.toString(), { credentials: 'include' });
      const body = await r.text();
      result.baseUrlSrv3 = { status: r.status, length: body.length, head: body.slice(0, 200) };
      if (body.length === 0) ng(`B: 0 byte (status=${r.status})`);
      else ok(`B: ${body.length} bytes (status=${r.status})`);
    } catch (e) {
      ng('B: fetch 例外', e.message);
      result.baseUrlSrv3 = { error: e.message };
    }
  }

  // ---- 5. baseUrl + tlang=ja (auto translate) -----------------------------
  if (track?.baseUrl) {
    log('--- C: baseUrl + fmt=srv3&tlang=ja (自動翻訳) ---');
    try {
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'srv3');
      u.searchParams.set('tlang', 'ja');
      const r = await fetch(u.toString(), { credentials: 'include' });
      const body = await r.text();
      result.baseUrlTlang = { status: r.status, length: body.length, head: body.slice(0, 200) };
      if (body.length === 0) ng(`C: 0 byte (status=${r.status})`);
      else {
        ok(`C: ${body.length} bytes (status=${r.status})`);
        // 簡易パース: srv3 <p t="ms" d="ms">..<s>word</s>..</p>
        const cues = [];
        const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
        let m;
        while ((m = pRe.exec(body)) !== null) {
          const inner = m[3];
          let text = '';
          const sRe = /<s[^>]*>([^<]*)<\/s>/g;
          let sm;
          while ((sm = sRe.exec(inner)) !== null) text += sm[1];
          if (!text) text = inner.replace(/<[^>]+>/g, '');
          text = text
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
          if (text) cues.push({ t: +m[1], d: +m[2], text });
        }
        log(`C: parsed ${cues.length} cues`);
        if (cues.length) console.table(cues.slice(0, 5));
      }
    } catch (e) {
      ng('C: fetch 例外', e.message);
      result.baseUrlTlang = { error: e.message };
    }
  }

  // ---- 6. InnerTube API (Android client 装い) -----------------------------
  log('--- D: InnerTube /youtubei/v1/player (ANDROID client) ---');
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            androidSdkVersion: 34,
          },
        },
        videoId,
      }),
    });
    const data = await r.json().catch(() => null);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    result.innertube = {
      status: r.status,
      ok: r.ok,
      hasTracks: !!tracks,
      trackCount: tracks?.length || 0,
      firstTrack: tracks?.[0] && {
        languageCode: tracks[0].languageCode,
        baseUrl: tracks[0].baseUrl,
      },
    };
    if (tracks?.length) {
      ok(`D: innertube OK, tracks=${tracks.length}`);
      // try fetching the innertube-issued baseUrl
      log('--- D2: innertube baseUrl + fmt=srv3 ---');
      const u = new URL(tracks[0].baseUrl);
      u.searchParams.set('fmt', 'srv3');
      const r2 = await fetch(u.toString(), { credentials: 'include' });
      const body2 = await r2.text();
      result.innertube.baseUrlSrv3 = { status: r2.status, length: body2.length, head: body2.slice(0, 200) };
      if (body2.length === 0) ng(`D2: 0 byte (status=${r2.status})`);
      else ok(`D2: ${body2.length} bytes (status=${r2.status})`);
    } else {
      ng(`D: innertube 応答に captionTracks なし (status=${r.status})`);
    }
  } catch (e) {
    ng('D: innertube 例外', e.message);
    result.innertube = { error: e.message };
  }

  // ---- summary ------------------------------------------------------------
  console.log('%c--- summary ---', 'color:#0af; font-weight:bold');
  console.log(JSON.stringify(result, (k, v) => {
    // baseUrl は長いので短縮
    if (k === 'baseUrl' && typeof v === 'string') return v.slice(0, 80) + '...';
    if (k === 'head' && typeof v === 'string') return v.slice(0, 80);
    return v;
  }, 2));

  window.__probeResult = result;
  log('window.__probeResult に保存しました');
})();
