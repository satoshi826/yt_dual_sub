// YouTube 二か国語字幕 - 実ブラウザ検証スクリプト
// 使い方:
//   1. Chrome/Safari で任意の字幕付き YouTube 動画を開く
//      例) https://www.youtube.com/watch?v=8jPQjjsBbIc (Steve Jobs Stanford)
//   2. 動画を一度再生して字幕をロードさせる
//   3. F12 (または右クリック→検証) で DevTools を開き Console タブへ
//   4. このファイル全体をコピペして Enter
//
// 期待される結果:
//   - "OK fetched English: N events" のような出力
//   - "OK fetched Japanese: N events"
//   - 各字幕の最初の3行が時刻付きで表示される
//
// もし bytes=0 が出る場合は、WebView 方式でも追加対策が必要

(async () => {
  console.log('=== YouTube Dual Subtitle PoC ===');

  // 1. captionTracks 取得(ページ内グローバルから)
  const tracks = ytInitialPlayerResponse
    ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks?.length) {
    console.error('NG: captionTracks が見つかりません。字幕付き動画ですか?');
    return;
  }
  console.log(`OK: ${tracks.length} 言語の字幕が利用可能`);
  console.table(tracks.map(t => ({
    lang: t.languageCode,
    kind: t.kind || 'manual',
    name: t.name?.runs?.[0]?.text,
  })));

  // 2. 英語(手動)と日本語のトラックを選ぶ
  const en = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr');
  const ja = tracks.find(t => t.languageCode === 'ja');

  if (!en) { console.warn('英語(手動)字幕なし'); }
  if (!ja) { console.warn('日本語字幕なし'); }

  // 3. fmt=json3 で fetch
  async function fetchCaption(track, label) {
    if (!track) return;
    const url = track.baseUrl + '&fmt=json3';
    try {
      const res = await fetch(url);
      const text = await res.text();
      console.log(`[${label}] status=${res.status} bytes=${text.length}`);
      if (!text) {
        console.error(`  NG: ${label} は空応答。PoToken/Cookieが効いていない可能性`);
        return;
      }
      const data = JSON.parse(text);
      console.log(`  OK fetched ${label}: ${data.events?.length || 0} events`);
      // 最初の3つの非空イベントを表示
      let shown = 0;
      for (const ev of (data.events || [])) {
        const segs = ev.segs;
        if (!segs) continue;
        const t = segs.map(s => s.utf8 || '').join('').trim();
        if (!t) continue;
        const start = (ev.tStartMs / 1000).toFixed(2);
        console.log(`    [${start}s] ${t.substring(0, 80)}`);
        if (++shown >= 3) break;
      }
    } catch (e) {
      console.error(`  NG: ${label} fetch error`, e);
    }
  }

  await fetchCaption(en, 'English');
  await fetchCaption(ja, 'Japanese');

  // 4. 自動翻訳(tlang)も試す: 英語字幕→日本語へ翻訳
  if (en) {
    const url = en.baseUrl + '&fmt=json3&tlang=ja';
    try {
      const res = await fetch(url);
      const text = await res.text();
      console.log(`[Auto-translate EN->JA] status=${res.status} bytes=${text.length}`);
      if (text) {
        const data = JSON.parse(text);
        console.log(`  OK: ${data.events?.length || 0} events`);
        let shown = 0;
        for (const ev of (data.events || [])) {
          const segs = ev.segs;
          if (!segs) continue;
          const t = segs.map(s => s.utf8 || '').join('').trim();
          if (!t) continue;
          console.log(`    [${(ev.tStartMs/1000).toFixed(2)}s] ${t.substring(0, 80)}`);
          if (++shown >= 3) break;
        }
      }
    } catch (e) {
      console.error('  Auto-translate error', e);
    }
  }

  console.log('=== 検証完了。上記結果をAIに共有してください ===');
})();
