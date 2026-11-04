# NERO Swipe Reader v0.5.0

## PCのChromeへ無料で導入する

**配布ファイル：`nero-swipe-reader-0.5.0-chrome.zip`（78,024バイト）**

[Chrome版の導入・更新手順](CHROME_INSTALL.md)

ZIPを解凍し、PCのChromeで`chrome://extensions`を開いて「デベロッパーモード」をONにします。「パッケージ化されていない拡張機能を読み込む」から、`manifest.json`が直下にあるフォルダーを選びます。Chrome Web Store登録やGoogleへの登録料は不要です。解凍したフォルダーは保管してください。

Windows・Mac・LinuxのChrome 120以降向けです。iPhone・iPad・Android版Chromeへは導入できません。同じChromeプロフィールでnoteへログインし、NEROを開いて「再確認」します。会員向けJSONは別途「読み込み」から登録します。

Chrome用ZIPには導入・更新・操作・トラブル対処・プライバシー説明の`INSTALL.md`を同梱しています。更新は同じ保管フォルダーのファイルを差し替え、拡張を再読み込みします。拡張IDは`fcopjoegochallbjmkmllabgdcmhpdng`で固定しています。

長時間の取得はリーダータブで実行するため、取得中はタブを開いたままにしてください。別タブでの作業は可能です。タブを閉じると処理は止まり、取得全体が自動再開する機能はありません。

## 機能

- 11個のウォッチリスト、未スキ記事を各人最大3本まで補充、全体をランダム表示。
- 1人の深掘り最大50本と、通常・深掘りそれぞれのスキ済みON/OFF。
- 記事内リンクカード、note記事の内部移動・元の位置へ戻る、外部リンクの別タブ表示。
- noteログインを使う記事へのスキ・コメント、未返信一括取得、コメントへのスキと返信時の同時スキ。
- 下書き・保存内容のアカウント分離、送信前アカウント確認、永続的な二重投稿防止。

## ソースとFirefox版

- `nero-swipe-reader-0.5.0-chrome-source.zip`：Chrome版の再ビルド用ソース。導入するファイルは上記のChrome本体ZIPです。
- `nero-swipe-reader-0.5.0-unsigned.zip`：Firefox用のMozilla提出用本体。Chromeへは使いません。Firefoxへ配布するにはMozilla署名後のXPIが必要です。
- `nero-swipe-reader-0.5.0-source.zip`：Firefox版のMozilla審査用ソース。

ChromeソースはNode.js 22以降で`node scripts/package-chrome.mjs`を実行します。Gitチェックアウト・追加npm依存・外部ZIPツールは不要です。ソース内の`CHROME_BUILD.txt`に手順を記載しています。

## 検証状況

既存機能の検査、Chromeの単一リーダー制御・起動と終了・通信順序、生成されたエンジンを使う統合検査に合格しました。模擬HTTPで、未スキ補充・深掘り50本・スキ済み切替・中断・投稿先・アカウント拒否・重複送信防止を確認しました。

ソースZIPから再ビルドしたChrome本体の全15ファイルとZIP全体、Firefox本体の全17ファイルとZIP全体が配布用の内容に一致しました。Firefox用web-ext lintはエラー・警告0件です。

この実行環境ではOS制限によりChromium本体を起動できず、実ブラウザーでの検査は未実施です。Mac・Windowsの実機、実際のnoteログイン状態での表示・投稿も未確認です。Googleのストア審査やFirefox v0.5.0のMozilla署名は行っていません。

会員名簿・パスワード・Cookie・秘密鍵はZIPに含めていません。noteと画像配信元への通信はありますが、開発者サーバーへの収集・広告・アクセス解析・外部AI送信はありません。
