# Chrome版 v0.5.1 — ログイン確認とnote通信の修正

**通常のChrome版を更新するファイル：`nero-swipe-reader-0.5.1-chrome.zip`（85,959バイト）**

[導入・更新ガイド](CHROME_INSTALL.md)

## 0.5.0から更新する

1. リーダータブを閉じます。拡張機能は削除しません。
2. Chrome用ZIPを解凍し、今まで使っていた拡張フォルダーへ中身を上書きします。
3. `chrome://extensions`でNERO Swipe Readerの再読み込みボタンを押します。
4. 同じChromeプロフィールでnote.comのタブを開き、ログインを確認します。
5. noteタブを開いたままNEROを開き、「再確認」を押します。

Chromeの追加権限`scripting`を使用します。対象サイトは引き続きnote.comだけです。拡張IDは`fcopjoegochallbjmkmllabgdcmhpdng`を維持し、既存リスト・下書き・投稿の重複防止情報を引き継ぎます。

## 修正内容

- 拡張ページからの直接通信に代えて、ログイン中のnoteタブの隔離された実行環境から同じオリジンのAPIへ通信します。ChromeのCookie制限等で拡張ページからの認証通信が失敗する場合に対応します。ユーザーの実環境での原因をCookie制限と断定したものではありません。
- ログイン確認だけでなく、記事・コメントの取得、スキ・コメント送信も同じnoteタブ経由に統一しました。
- 未ログイン、HTTP 403の接続拒否、429の制限、noteタブなし、権限不足、通信・タイムアウトなどを区別して案内します。
- Chromeのサイトアクセスをnote.comに限定し、実行先・API・HTTPメソッド・ヘッダーを二重に確認します。Cookie値を読み出す処理や、開発者へ送る処理はありません。
- 送信前のアカウント確認と永続的な重複防止を維持します。失敗した投稿を別タブや別経路で自動再送しません。遅延した注入が期限後に投稿を開始しないよう、通信に絶対期限を設けています。
- 通常モードとシークレットのnoteセッションを混在させません。

記事取得・送信中はnoteタブとリーダータブの両方を開いておいてください。noteタブの自動作成・再読み込み・画面切り替えは行いません。Chrome全体のCookie設定を緩める手順はありません。送信結果が不明な場合はnoteで確認してから操作してください。

## 検証

共通機能・Chrome起動・通信・診断・生成物の検査に合格。拡張ページのfetchを失敗させ、noteの別コンテキストでだけ通信が成功する条件を再現し、ログイン確認・未スキ3本／深掘り50本・401／403・タブなし・投稿先・重複防止を確認しました。Cookieの手動読出しを禁止した検査、投稿後の応答喪失、キャンセル注入の紛失や31秒遅延でも期限後POSTを開始しない検査も含みます。

ChromeソースZIPから再ビルドした本体全体は配布ZIPとバイト単位で一致しています。実際のChromeとnoteログイン状態での確認は、この実行環境では未実施です。修正後も失敗する場合は、新しく表示されるエラー文言で切り分けます。

## その他のファイル

- `nero-swipe-reader-0.5.1-chrome-source.zip`：Chrome再ビルド用ソース。Node.js 22以降で`node scripts/package-chrome.mjs`を実行します。
- `nero-swipe-reader-0.5.1-unsigned.zip`：Firefox向けMozilla提出用本体。Chromeには使いません。Firefox通常配布にはMozilla署名済みXPIが必要です。
- `nero-swipe-reader-0.5.1-source.zip`：Firefox向けMozilla審査用ソース。

会員名簿・パスワード・Cookie・秘密鍵は含みません。通信先と保存内容は[プライバシー方針](https://github.com/neronote100/nero-swipe-reader/blob/main/members/PRIVACY.md)を参照してください。
