// YouTube 字幕 DOM スクレイピング PoC
// 使い方:
//   1. https://www.youtube.com/watch?v=8jPQjjsBbIc を開く(別動画でもOK)
//   2. CC(字幕)ボタンを押して字幕をオンに、言語は英語などにしておく
//   3. 動画を再生開始
//   4. DevTools Console にこのスクリプト全体を貼り付けて Enter
//   5. 30秒間、字幕が変化するたびにログに記録される
//   6. window.__dualsubLog で結果を確認

(() => {
  console.log('=== DOM スクレイピング PoC 開始 ===');

  // 字幕要素の候補セレクタ(デスクトップ・モバイル両対応)
  const SELECTORS = [
    '.ytp-caption-segment',           // デスクトップ標準
    '.caption-visual-line',           // モバイル m.youtube.com の可能性
    '.captions-text',                 // 別パターン
    '[class*="caption-segment"]',     // 部分一致フォールバック
    '[class*="captionWindowContainer"] span',
  ];

  function findCaptionElements() {
    for (const sel of SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return { selector: sel, elements: els };
    }
    return null;
  }

  // 動画要素を取得(currentTime同期用)
  const video = document.querySelector('video');
  if (!video) {
    console.error('NG: <video> 要素が見つかりません');
    return;
  }
  console.log(`OK: video 要素検出 (duration=${video.duration.toFixed(1)}s)`);

  // 初期検出
  let found = findCaptionElements();
  if (found) {
    console.log(`OK: 字幕要素検出  selector="${found.selector}"  count=${found.elements.length}`);
    const initialText = [...found.elements].map(e => e.textContent).join(' ').trim();
    if (initialText) console.log(`  現在表示中: "${initialText}"`);
  } else {
    console.warn('字幕要素は現時点で見つかりません(まだ表示されていない可能性)。観察を続けます…');
  }

  // ログ格納
  const log = window.__dualsubLog = [];
  let lastText = '';

  function snapshot() {
    const f = findCaptionElements();
    if (!f) return;
    const text = [...f.elements].map(e => e.textContent).join(' ').trim();
    if (text && text !== lastText) {
      const entry = {
        time: video.currentTime.toFixed(2),
        text,
        selector: f.selector,
      };
      log.push(entry);
      console.log(`[${entry.time}s] ${text}`);
      lastText = text;
    }
  }

  // MutationObserver で字幕変化を監視
  const observer = new MutationObserver(snapshot);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // 念のためポーリングも併用(MO で拾えない場合の保険)
  const interval = setInterval(snapshot, 200);

  // 30 秒後に停止して結果報告
  setTimeout(() => {
    observer.disconnect();
    clearInterval(interval);
    console.log('=== 観察終了 ===');
    console.log(`記録した字幕変化: ${log.length} 件`);
    console.log('全ログ: window.__dualsubLog');
    if (log.length === 0) {
      console.warn('NG: 字幕変化が一度も記録されませんでした。');
      console.warn('  確認: 字幕(CC)はオンになっていますか? 動画は再生中ですか?');
    } else {
      console.log('OK: DOMスクレイピング方式で字幕取得可能。実装方針として採用可能。');
      console.table(log.slice(0, 10));  // 最初の10件表形式で表示
    }
  }, 30000);

  console.log('観察中… 30秒後に結果を表示します。動画を再生し続けてください。');
})();
