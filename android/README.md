# DualSub Android

YouTube 二か国語字幕アプリ。`m.youtube.com` を WebView で表示し、
`poc/dualsub_overlay.js`(Console 貼付け用の単一ソース)をページロード時に注入する。

## 構成

```
android/
├── settings.gradle.kts
├── build.gradle.kts          # ルート(プラグインバージョン宣言)
├── gradle.properties
├── gradle/wrapper/
│   └── gradle-wrapper.properties
└── app/
    ├── build.gradle.kts      # アプリモジュール
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/
        │   └── dualsub_overlay.js  → symlink to ../../../../../poc/dualsub_overlay.js
        ├── java/jp/hata/ytdualsub/
        │   ├── MainActivity.kt
        │   └── DualSubWebView.kt
        └── res/values/
            ├── strings.xml
            └── themes.xml
```

### JS は単一ソース

`app/src/main/assets/dualsub_overlay.js` は `poc/dualsub_overlay.js` への **シンボリックリンク**。
PoC スクリプトを更新すると Android アプリ側も自動で反映される。
Console 貼付けでの動作確認は引き続き `poc/dualsub_overlay.js` を使えばよい。

## 初回セットアップ手順

1. Android Studio をインストール
   ```bash
   brew install --cask android-studio
   ```
2. 起動して "Standard" セットアップ完了
3. **SDK Manager**: SDK Platform 34 + Build Tools 34.x をインストール
4. **AVD Manager**: Pixel 6 + API 34 (Google Play 入り) のエミュレータを作成
5. このディレクトリ `yt_dual_sub/android` を Android Studio で開く
   - File → Open → `yt_dual_sub/android`
6. Gradle Sync 完了を待つ(初回は数分かかる、依存DL)
7. 緑の ▶ ボタンでエミュレータに起動

## 動作確認のチェック

- アプリ起動 → m.youtube.com が表示されるか
- 字幕付き動画を開く → 画面下部に **DualSub バー** が出るか
- 字幕(CC)が自動でオンになるか
- Top 字幕(原文) + Bottom 字幕(英訳)がオーバーレイ表示されるか
- 設定パネルから言語・色・サイズ変更が反映されるか

## Logcat フィルタ

PoC スクリプトの `console.log` は Logcat に流れる:

- `DualSubWebView`: Android 側のログ
- `DualSubJS`: JS の console.log/warn/error

## 既知の制約

- YouTube ログインは初回のみブラウザ的に必要(以降は Cookie で維持)
- フルスクリーン再生時の挙動は別タスク(A-4)で対応予定
- Picture-in-Picture は別タスク(A-5)で対応予定
