# yt_dual_sub — プロジェクトステータス

最終更新: 2026-05-23(www.youtube.com への切替で WebView 回避策を全廃)

このドキュメントは中断と再開のためのハンドオーバーです。
コードは進化していくので、不一致を感じたら `git log` と現物コードを優先してください。

---

## 1. 目的

YouTube の動画上に **二か国語字幕**(原文 + 翻訳)を同時表示するアプリ。
語学学習用途を主想定。個人利用前提(ストア配布は YouTube TOS の関係で困難)。

例: 英語動画を観ながら、画面下部に「英文 + 日本語訳」を縦に並べて表示。

---

## 2. 全体アーキテクチャ

```
[ ブラウザ Console 貼付 ] ──┐
                           ├─→ poc/dualsub_overlay.js (単一ソース)
[ Android WebView 注入  ] ──┘            │
                                          ├─ InnerTube /youtubei/v1/player (ANDROID client)
                                          │      └─ captionTracks 取得
                                          ├─ Top lane:    resolveLane(top wantLang)    ─┐
                                          ├─ Bottom lane: resolveLane(bottom wantLang) ─┤ 並列 fetch (dedupe)
                                          │                                              ↓
                                          │      各 lane の cues[] を独立に保持
                                          ├─ video.currentTime に応じて両 lane の cue を描画
                                          └─ 画面下部に常駐バー UI
```

### 重要な設計判断

| 決定 | 理由 |
|------|------|
| **InnerTube /youtubei/v1/player (ANDROID client)** で captionTracks 取得 | `ytInitialPlayerResponse` の baseUrl は PoToken で 0バイト応答に弾かれるが、InnerTube ANDROID client が返す baseUrl は PoToken をバイパスできる(2026 時点の検証で確認、`poc/caption_probe.js`) |
| **YouTube 自動翻訳 (`tlang` パラメータ)** で訳文取得 | 同じ baseUrl に `&tlang=xx` を付けると YouTube 側が翻訳した srv3 を返す。Google翻訳 API を別途叩く必要なし。全字幕をタイミング情報付きで一括取得できる |
| **Top / Bottom は完全対等な 2 lane** | UI 上の区別は配置と色だけ。データ構造も lanes.{top,bottom} で並列。どちらの lane も独立に言語を指定可能 |
| **lane ごとに「ネイティブ > 翻訳 fallback」** | 同言語の手動字幕があれば直接取得(`tlang` 不要)、無ければ asr、それも無ければ別字幕 + `tlang` で翻訳。動画に両言語の手動字幕があれば両方ともネイティブ |
| **video.currentTime ベースで描画** | 全 cue を事前取得済みなので DOM 監視・per-segment 翻訳・YT 字幕同期は不要 |
| **WebView + JS 注入** | ReVanced 流の Smali 改造は難度高すぎ。WebView で `www.youtube.com` を表示し JS で augment |
| **`www.youtube.com` (desktop) を使う** | `m.youtube.com` (mobile) は WebView だと sticky-player クラスが強制発動してプレーヤーが 125px に固定される。UA 偽装などでは回避不能だったが、デスクトップ版にはそもそも sticky-player の概念が無いので問題ごと消える。UA は WebView デフォルトのまま、`window.chrome` 等の偽装も不要 |
| **JS を symlink で単一ソース** | ブラウザ Console 貼付と Android 注入で同じコードを共有 |
| **Trusted Types 対応**(innerHTML 不使用) | YouTube の CSP が `require-trusted-types-for 'script'` を課しているため |
| **YT 純正字幕は常に非表示** | プレーヤーがマウントされている間 `body.dualsub-active` を付与して visibility:hidden。表示はすべて自前 overlay |

---

## 3. ファイル構成

```
yt_dual_sub/
├── STATUS.md                         ← このファイル
├── .gitignore
├── poc/
│   ├── browser_test.js               (Step 1 の検証スクリプト、参考)
│   ├── dom_scrape.js                 (Step 1 の検証スクリプト、参考)
│   ├── caption_probe.js              (InnerTube / baseUrl の到達性検証、参考)
│   └── dualsub_overlay.js            ★ 本体 PoC スクリプト(約 990行、現役)
└── android/
    ├── README.md                     (Android セットアップ手順)
    ├── settings.gradle.kts
    ├── build.gradle.kts              AGP 8.5.2 / Kotlin 2.0.20
    ├── gradle.properties
    ├── gradle/wrapper/gradle-wrapper.properties (Gradle 8.9)
    └── app/
        ├── build.gradle.kts          minSDK 29 / targetSDK 34
        ├── proguard-rules.pro
        └── src/main/
            ├── AndroidManifest.xml   INTERNET / PiP supported
            ├── assets/
            │   └── dualsub_overlay.js  ← symlink to ../../../../../poc/dualsub_overlay.js
            ├── java/jp/hata/ytdualsub/
            │   ├── MainActivity.kt   Compose entry + 戻るボタン処理
            │   └── DualSubWebView.kt WebView 設定 + JS 注入 + chrome://inspect 有効化
            └── res/values/
                ├── strings.xml
                └── themes.xml        黒背景ダークテーマ
```

### Git ブランチ

| ブランチ | 役割 | 内容 |
|---------|------|------|
| `main` | 安定版 | PoC のみ(4ファイル) |
| `develop` | 開発中 | PoC + Android 雛形 + 各種 fix(現在ここ) |

### Gradle wrapper jar について

`android/gradle/wrapper/gradle-wrapper.jar` は **コミット対象外** (.gitignore)。
Android Studio で初回 Sync 時に自動生成される。CLI ビルドする場合は `gradle wrapper` で生成。

---

## 4. PoC スクリプトの動作モデル (poc/dualsub_overlay.js)

### 起動シーケンス
1. `window.__dualsubInstalled` チェック(多重インストール防止)
2. config を localStorage から復元(旧スキーマは migrate)
3. オーバーレイ DOM 構築(player にはまだ append しない)
4. 設定パネル(バー)構築 → body に追加(初期は display:none)
5. `<style>` 注入
6. `syncMountState()` を実行 → プレーヤー検出 + CaptionStore.load 起動
7. ポーリング(250ms)で `syncMountState` + `updateOverlay`

### プレーヤーの検出ロジック (`findPlayer`)
1. `#movie_player, .html5-video-player` を探す
2. 無ければ `<video>` を起点に position 持ち祖先まで遡る
3. それも無ければ null(動画ページ以外)

### バー表示の条件
**プレーヤーが見つかったページのみ**バー出現。
ホーム・検索画面など player 不在ではバーは非表示。SPA 遷移にも追従。

### 字幕取得(CaptionStore)

videoId が変わるたびに非同期ロード。Top / Bottom は完全対等な 2 lane:

1. `POST /youtubei/v1/player` を ANDROID client context で叩いて captionTracks を取得
   - `clientName: 'ANDROID'`, `clientVersion: '20.10.38'`
   - `credentials: 'include'` で cookie 付き
2. 各 lane の希望言語に対して `resolveLane(tracks, wantLang)` で取得プランを決定:
   - 希望言語の **手動字幕** があれば → 直接取得(`source: 'native'`)
   - 希望言語の **asr 字幕** があれば → 直接取得(`source: 'asr'`)
   - どちらも無ければ → 別字幕 + `tlang=希望言語`(`source: 'translated'`)
3. 2 lane 分のプランを `Promise.all` で並列 fetch。**同一 URL は dedupe** されるので、両 lane が同じ字幕を指せば fetch は 1 回。
4. `parseSrv3` で `[{ t, d, text }]` 配列に変換、`state.lanes[name].cues` に格納
5. ロード状態は `'idle' | 'loading' | 'ready' | 'no-captions' | 'error'`
6. `loadSeq` で連続変更時の古い fetch をサイレント破棄

#### state 構造
```
{
  videoId, status, captionTracks, isLive,
  lanes: {
    top:    { wantLang, resolvedLang, source, cues },
    bottom: { wantLang, resolvedLang, source, cues },
  }
}
```

### 描画ループ
ポーリング毎に `video.currentTime * 1000` から各 lane の cues を二分探索し、
Top/Bottom のテキストをそれぞれ `.ds-original` / `.ds-translated` に書き込むだけ。
DOM 監視や翻訳 API 呼び出しはランタイムには発生しない。

### 字幕無し動画 / ライブ配信
captionTracks が空 or `videoDetails.isLive == true` → `'no-captions'` 状態。
バーは出るが、訳文側に「字幕なし」or「字幕なし(ライブ)」を半透明表示。

### 表示モード: Unified
YT 純正字幕は `body.dualsub-active` クラス + `visibility: hidden !important` で常に非表示
(プレーヤー mount 中)。原文・訳文の両方を `.ds-original` / `.ds-translated` に
自前描画。両方とも半透明黒ピル(background-color + border-radius)上に乗る。

### 設定項目
- 表示 ON/OFF(自前 overlay のみ。YT 純正字幕は常に非表示)
- Top(上)/ Bottom(下): それぞれ独立に **言語(明示指定)・色・サイズ**
  - サイズ: プレーヤー高さ %、内部値 1.0-10.0 / UI 表示 ×10倍
  - 言語の `auto` は廃止 — ユーザーは常に2言語ペアを明示
  - Top/Bottom の入れ替えはユーザーが手動でドロップダウンを操作
- 共通: 位置(下からの%)、背景の濃さ %

いずれかの lane の言語が変わると CaptionStore.load を再実行
(両 lane の cues を取り直し、ただし同一 URL は dedupe)。

### 永続化
`localStorage['dualsub-config-v1']` に JSON で保存。旧スキーマからの migration あり。

### デバッグ API
- `window.__dualsubStop()` — クリーンアップして停止
- `window.__dualsubState()` — `{ config, caption }` を返す(状態確認用)

---

## 5. Android アプリ (android/)

### 役割
PoC スクリプトを WebView に注入するシェル。

### 主要コード

**MainActivity.kt**
- Compose entry point
- `FLAG_KEEP_SCREEN_ON` で動画再生中の画面オフ防止
- `OnBackPressedCallback` で WebView 履歴を戻る

**DualSubWebView.kt** (120 行、極めて素直)
- `www.youtube.com` (desktop 版) を WebView で表示。UA は WebView デフォルトのまま
- JS / DOM storage / Cookie 有効化、`loadWithOverviewMode = false` / `useWideViewPort = true`
- `WebView.setWebContentsDebuggingEnabled(true)` で `chrome://inspect` から覗ける
- `onPageFinished` で assets/dualsub_overlay.js を `evaluateJavascript` 注入
- assets/dualsub_overlay.js の内容ハッシュ(8桁 hex)を毎ページ Logcat と JS console に出力(リビルド反映確認用)
- `WebChromeClient.onConsoleMessage` で `console.log` を Logcat (`DualSubJS` tag) に転送

### 開発手順
1. Android Studio で `/Users/satoshihata/git/yt_dual_sub/android` を開く
2. Gradle Sync を待つ
3. `Build → Rebuild Project` でクリーンビルド
4. ▶ Run でエミュレータ(Pixel 3a API 34)に実行

### 動作確認
1. アプリ起動 → www.youtube.com ホーム
2. 動画タップ → DualSub バー出現
3. バーをタップして設定パネル展開
4. Logcat `DualSubJS` で JS のログ確認

### Android Studio バージョン注意
古い Android Studio (Hedgehog, AGP 8.1.x まで) で開くと AGP 8.5.2 互換性エラーが出る。
2024 年後半以降のバージョン(Koala / Ladybug など)が必要。
更新コマンド: `brew install --cask --force android-studio`

---

## 6. ここまでの流れ(主要マイルストーン)

### Phase 0: 設計検証
- ReVanced 流の Smali 改造を検討 → 難度高すぎで断念
- WebView ベース + JS 注入方針に決定
- YouTube の `timedtext` API を curl で検証 → **PoToken でブロック**されることを発見
- DOM スクレイピング方針に転換

### Phase 1: ブラウザ PoC 完成
- DOM 監視(`.ytp-caption-segment` + MutationObserver)で字幕読取り成功
- Google翻訳 `client=gtx` 無認証エンドポイントで翻訳
- 動画上に黄色オーバーレイで翻訳表示(成功)

### Phase 1.5: PoC を作り込み
- 設定 UI 追加(下部常駐バー + 展開パネル、Trusted Types CSP 対応)
- Unified モード(YT 純正字幕を非表示、両方自前描画)
- CC ボタン自動 ON / 双方向同期
- Top/Bottom 並列構造(各々の言語・色・サイズ独立設定)
- 影 → 半透明黒背景方式
- フォントサイズをプレーヤー高さ % に(ResizeObserver で全画面追従)
- プロダクション化リファクタ(927行 → 821行)

### Phase 2: Android アプリ化
- A-0: Android Studio セットアップ
- A-1: Gradle プロジェクト雛形(Compose / minSDK 29)
- A-2: WebView + JS インジェクション実装
- A-3: エミュレータ動作確認
- A-3a: モバイル YouTube の DOM 差分対応
- A-3b: ツールバー非表示問題の修正
- A-3c: プレーヤー無いページではバー非表示に
- 観察ベース CC sync に刷新
- マルチシグナル検知 + 一度きり auto-enable
- シメトリカル sync + 失敗時プレーヤー追従

### Phase 3: YouTube 字幕直接取得への刷新
- `poc/caption_probe.js` で innertube ANDROID client / baseUrl の到達性を検証
- `ytInitialPlayerResponse.baseUrl` 直 fetch は依然 0バイト(PoToken 健在)を確認
- **innertube ANDROID client が返す baseUrl は PoToken をバイパスできる**ことを発見
- `baseUrl + fmt=srv3 + tlang=ja` で YouTube 自動翻訳の取得に成功
- PoC スクリプトを全面書き換え:
  - DOM スクレイピング / gtx 翻訳 / YT 字幕双方向 sync を撤廃
  - innertube + srv3 + currentTime 描画に刷新
  - 「字幕なし」プレースホルダ対応
- **Top / Bottom を完全対等な 2 lane 並列構造に**:
  - lane ごとに「ネイティブ手動 > asr > 翻訳 fallback」で独立に取得
  - 同一 URL は fetch dedupe
  - 言語の `auto` 概念は廃止、両 lane とも明示指定

### Phase 4: sticky-player 問題の調査と本質的な解決(現在ここ)
- WebView で動画ページを開くと YT が即座にミニプレーヤー (`#player-container-id.sticky-player` / `position: fixed; height: 125px`) に固定する症状を確認
- **試行錯誤 (遠回り)**: WebView 検知が原因と仮定して以下を順に試行 — Chrome モバイル完全 UA → `navigator.userAgentData` 偽装 → `window.chrome` 偽装。いずれも単独では sticky 化を防げず、対症療法として `documentElement` 直下に `!important` CSS を注入する MutationObserver 自己修復付きの仕組みを構築
- **本質特定**: 実機 Android Chrome で `m.youtube.com` を開くと普通に表示されることから WebView 特有問題と確信。さらに切り分けると **URL を `www.youtube.com` に変えるだけ**で UA は WebView デフォルトのまま問題が消えることが判明
- **真因**: `sticky-player` クラスは m.youtube.com に固有の「スクロール時 mini-player」機能。WebView 上では何らかの内部シグナルでロード直後から発動していた。一方 www.youtube.com には sticky-player クラスが存在しないため、デスクトップ版に切り替えるだけで問題は消滅する
- **クリーンアップ**: 試行錯誤で積んだ UA 偽装(CHROME_MOBILE_UA)、`BROWSER_SPOOF`、`UNSTICK_PLAYER` を全廃。DualSubWebView.kt は 365 → 120 行(67% 減)に
- **教訓**: 「現象が WebView で再現するから WebView が原因」とは限らない。サイト側の差(m. vs www.)が真因のこともある。怪しい仮説の検証で時間を使う前に、別 URL や別ブラウザでの比較を先にやるべきだった

---

## 7. これからの流れ(残タスク)

### Android 機能拡張
- [ ] **A-4: フルスクリーン処理** — 動画全画面化時のレイアウト/ステータスバー隠蔽、`WebChromeClient.onShowCustomView` ハンドリング
- [ ] **A-5: PiP / 戻るボタン処理強化** — Picture-in-Picture、戻るボタンで履歴→終了確認ダイアログ

### 拡張機能候補(優先順未定)
- [ ] 単語クリック → 辞書ポップアップ(語学学習向け)
- [ ] 字幕履歴ビュー / エクスポート
- [ ] 再生速度・A-B リピート

### バックログ
- [ ] Userscript 版(Tampermonkey)— 単一 JS でデスクトップ/モバイルブラウザ常駐
- [ ] iOS 対応検討(WebView ベース、Safari 拡張 or アプリ)
- [ ] CSS の `100vh` 問題の追跡(`bodyMaxHeight: 0px` の根本原因)

---

## 8. 既知の制約 / Gotchas

| 制約 | 影響 / 回避策 |
|------|--------------|
| **PoToken** | `ytInitialPlayerResponse` の baseUrl 直 fetch は 0バイト。**InnerTube ANDROID client 経由で取得した baseUrl** なら通る |
| **CORS** | 外部オリジンから YouTube への fetch は不可。WebView/youtube.com 内なら same-site で OK |
| **Trusted Types CSP** | `innerHTML` 不可、`createElement` + `setAttribute` で構築 |
| **YouTube SPA** | ページ遷移で videoId が変わる → `syncMountState` → `maybeReloadCaptions` で再ロード |
| **ライブ配信** | captionTracks が無い or 動的に変化 → 「字幕なし(ライブ)」表示 |
| **WebView の `calc(100vh - X)`** | 0px に化けるケースあり → JS で `innerHeight` ベースに直書き |
| **YT TOS** | 改造アプリのストア配布は禁止。**個人/学習用途のみ** |
| **InnerTube API の安定性** | Google が clientVersion を弾く可能性あり。fallback は無し(現状) |
| **AGP/AS バージョン** | AS Hedgehog (2023.x) は AGP 8.1.2 まで。新版 AS が必要 |
| **`m.youtube.com` の sticky-player 暴発** | WebView で m.youtube.com を開くとプレーヤーが 125px に固定される(UA 偽装などでは回避不能)。**`www.youtube.com` を使えば回避可能**(sticky-player クラスがそもそも無い) |

---

## 9. 開発ワークフロー

### PoC を弄りたい時(ブラウザで素早く反復)
1. `poc/dualsub_overlay.js` を編集
2. `cat poc/dualsub_overlay.js | pbcopy` でクリップボードへ
3. YouTube ページの DevTools Console に貼付け → Enter
4. 既存 instance があれば `__dualsubStop()` 先に呼ぶ

### Android で確認したい時
1. `poc/dualsub_overlay.js` を編集(symlink で Android assets も自動反映)
2. Android Studio で **Build → Rebuild Project**
3. ▶ Run → エミュレータで起動
4. Logcat の `DualSubJS` tag で JS console を見る

### WebView の DOM を覗きたい時
1. エミュレータでアプリ起動
2. Mac の Chrome で `chrome://inspect/#devices`
3. `WebView in jp.hata.ytdualsub` → **inspect**
4. フル DevTools が使える(DOM / Console / Network / Performance)

### Git 運用
- 機能開発は `develop` で進行
- 安定したら `git switch main && git merge develop`
- リリース時は main に tag (`v0.1.0` 等)

---

## 10. キーリファレンス

### YouTube
| 項目 | 値 |
|------|-----|
| 使用 URL | `https://www.youtube.com/` (desktop 版。m.youtube.com は sticky-player 問題で不採用) |
| プレーヤー | `#movie_player`(`.html5-video-player` でも可) |

### InnerTube API (字幕取得)
```
POST https://www.youtube.com/youtubei/v1/player?prettyPrint=false
Content-Type: application/json
credentials: include
{
  "context": { "client": { "clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 34 } },
  "videoId": "<11文字>"
}
```
Response から `captions.playerCaptionsTracklistRenderer.captionTracks[]` を取り出す。
各トラックは `{ baseUrl, languageCode, kind ('asr' or ''), name }`。

### 字幕 XML 取得
```
<baseUrl>?fmt=srv3                       → 原文 (srv3 XML)
<baseUrl>?fmt=srv3&tlang=<langCode>       → YouTube 自動翻訳
```
srv3 形式: `<p t="ms" d="ms">...<s>word</s>...</p>` の連続。
内部の `<s>` を結合(無ければタグ除去)し、エンティティ解除して cue にする。

### localStorage キー
`dualsub-config-v1` — 設定 JSON

### Console ログ tag
- `DualSubWebView` — Android 側
- `DualSubJS` — JS 内 console.log

### 内部 API
```js
window.__dualsubStop()   // クリーンアップして PoC を停止
window.__dualsubState()  // { config, caption } を返す(デバッグ用)
```

---

## 11. メモリリンク

このプロジェクトの方針はクロード補助メモリにも記録されています:
- `project-yt-dual-sub` — プロジェクト基本方針
- `project-yt-dual-sub-architecture` — アーキテクチャ決定事項(PoToken の罠など)
