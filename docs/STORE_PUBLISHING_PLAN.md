# NERO Swipe Reader：Google Playを優先したアプリ化の検討

## 結論

AndroidアプリとしてGoogle Playへ出す方向は現実的。ただし、Firefox拡張ZIPをそのままPlayへ提出することはできない。画面・スワイプ・未対応判定は活かし、Android用の認証・通信・保存を作る。最初の検証は「Android内でnoteにログインし、本人の記事のコメントを取得して、本人の明示操作で1件返信できること」。

Mozillaの署名・審査通過はFirefox版についてのもので、Google・Appleの審査、noteとの正式な連携許可を代替しない。本書は技術・公開計画であり、ストア承認を保証するものではない。公式ページは更新されるため、提出時にも確認する。

## 費用

| 項目 | Google Play | Apple App Store |
| --- | --- | --- |
| 開発者登録 | 25米ドル、1回限り | 99米ドル／年、または対応する現地通貨 |
| 登録に含まれないもの | Android実機、開発作業、必要なら会員確認サーバー・ドメイン・運用 | iPhone/iPad実機、開発・テスト、必要ならビルド環境・サーバー |
| 売上手数料 | 有料アプリ・アプリ内デジタル販売等を行う場合に該当条件を確認 | 有料配布・アプリ内販売等を行う場合に契約と対象プログラムを確認 |

根拠：[Google登録料と本人確認](https://support.google.com/googleplay/android-developer/answer/6112435?hl=ja)、[Apple登録料](https://developer.apple.com/help/account/membership/program-enrollment/)。円での支払額は登録画面で確認する。

初期案は、無料ダウンロード・アプリ内課金なしで、読む／返信する価値を実証すること。有料メンバー限定にするなら、利用資格の照合と課金方針を設計段階で決める。「noteで既に払っているから、アプリ内から自由に入会・購入へ誘導できる」とは限らない。[Google支払いFAQ](https://support.google.com/googleplay/android-developer/answer/10281818?hl=ja)

Googleの売上手数料は国、取引、適用プログラム等で異なる。日本を含む新体系では、公式表に自動更新定期購入10%＋Google Play請求利用時5%等が記載されている。一律に15%・30%と予算化せず、販売方法と配布国を決めて試算する。[Google現行手数料](https://support.google.com/googleplay/android-developer/answer/112622?hl=ja)

サーバー費は現時点で確定できない。会員確認や同期を持たず端末中心にする試作なら常設サーバー不要の設計を検討できる。会員限定・端末間同期・運営側の通報受付を自前で行うなら、その分のインフラと保守費が増える。開発費の見積もりは認証の実証と範囲確定後に行う。

## Google Playの手続き

1. Play Consoleへ個人または組織として登録。個人・組織の実態に合わせ、本人確認、連絡先、必要な端末確認を行う。登録料は上記25米ドル。公開される開発者情報も事前に確認する。
2. Android版を作成。Google Playへの新規提出はAAB（Android App Bundle）が基本。署名鍵・Play App Signing・バージョン番号を管理する。現在の公式案内では新規アプリはAndroid 16／API 36以上を対象にする。
3. 掲載情報、アイコン、画面写真、対象年齢、コンテンツレーティング、広告の有無、データセーフティ、公開URLのプライバシーポリシー、審査用アクセス手順を用意する。
4. 内部テストで操作・端末差・回線切断を検証する。
5. 2023年11月13日以降に作成した個人アカウントの場合は、12人以上が14日間連続で参加するクローズドテストが必要。テスト参加の維持に加え、実際の利用とフィードバックを記録する。
6. テスト結果・改善内容を添えて製品版アクセスを申請し、承認後に公開申請する。14日経過だけで自動公開にはならない。

根拠：[登録手順](https://support.google.com/googleplay/android-developer/answer/6112435?hl=ja)、[テスト要件](https://support.google.com/googleplay/android-developer/answer/14151465?hl=ja)、[AAB](https://support.google.com/googleplay/android-developer/answer/9859348?hl=ja)、[対象API](https://support.google.com/googleplay/android-developer/answer/11926878?hl=ja)。テスター募集・招待はユーザーが行うか、別途明示指示があった場合にのみ代行する。

## 現在の実装から見た課題

| 優先度 | 課題 | 現状と対応 |
| --- | --- | --- |
| 最優先 | アプリのログイン | 現在はFirefoxのCookieと拡張の権限を利用。Androidアプリは別のセッションとなり、Firefoxのログインは引き継げない。アプリ内のnote認証または利用可能な正式認可を実証する。 |
| 最優先 | noteとの連携範囲 | 現在のコードはnoteのWebサイト内部APIへ接続。一般ユーザーのコメント取得・スキ・返信について正式な利用方法と提供条件を確認する。 |
| 高 | Firefox専用処理 | `members/reader/app.js`の`browser.runtime`・`browser.storage`、`members/member-api.js`の拡張URL検証をAndroid用へ置換する。 |
| 高 | 投稿と認証の安全性 | 外部記事HTMLにネイティブ権限を渡さず、送信先・操作を限定。アカウント切替、ログアウト、セッション消去、端末終了・通信中断からの復旧を実装する。 |
| 高 | 記事・コメントの安全対策 | 通報・ユーザー非表示／ブロック、不適切コンテンツ対応、利用条件への同意等を設計。元記事リンクだけでは要件を満たせると判断しない。 |
| 高 | メンバー専用 | 現行拡張には会員資格の検証なし。Playで公開しただけではメンバー限定にならない。資格照合方式と失効・問い合わせ対応が必要。 |
| 高 | プライバシー | 現在のMarkdown方針を、公開URLとアプリ内から読める形にする。ログイン情報・コメント・下書き・診断データの扱いとデータセーフティを一致させる。 |
| 中 | Androidでの品質 | 戻る操作、キーボード、読み込み・エラー、バックグラウンド中断、スワイプ、アクセシビリティを実機で確認する。 |

WebViewはアプリ固有のCookie領域を持ち、Firefoxの権限付き`fetch`をそのまま再現しない。noteのGoogleログイン等が埋め込み画面で動作するかも未検証。外部ブラウザーでログインを開くだけでは、そのCookieがアプリ側へ渡るわけではない。[Chromium WebView設計](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/architecture.md)、[Androidの安全なブリッジ設計](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)

noteは2026年10月に法人向けの公式APIを発表しているが、note pro利用企業・契約パートナー向けの記事作成管理が中心。今回必要な一般個人向けのログイン・コメント・スキに使えるかは未確認。「公式APIがあるから現行の内部APIを自由に使える」と解釈しない。[note公式発表](https://note.jp/n/n6e16e4dc9e26)

Googleは権利者の許可を得ないWebView主体アプリを認めていない。また、UGCポリシーは専用クライアントにも適用される。独自の返信管理や下書きは価値になるが、第三者コンテンツ利用やUGCの要件を免除しない。[WebView・Spamポリシー](https://support.google.com/googleplay/android-developer/answer/9899034?hl=en)、[UGC要件](https://support.google.com/googleplay/android-developer/answer/9876937?hl=ja)

独自アカウントをアプリ内で作成させる場合は削除導線も必要。既存noteログインだけの構成では、アプリが作るアカウント・データの実態に沿って申告する。[ユーザーデータ](https://support.google.com/googleplay/android-developer/answer/10144311?hl=ja)、[アカウント削除要件](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)

## 推奨する開発順

| 段階 | 成果物 | 次へ進む条件 |
| --- | --- | --- |
| 1. 認証・利用方法の確認 | noteへの連携確認事項、Android認証の小さな試作 | 正当な方法でログイン・本人確認・コメント取得・手動返信が成立 |
| 2. Android最小版 | 読む／返信待ち／返信・下書きの3機能。初期は広告・課金・自動返信を入れない | 端末差・通信切断・アカウント切替でも誤送信や二重送信を防ぐ |
| 3. 公開要件 | 通報・ブロック、データ削除、公開プライバシー方針、必要なら会員照合 | 申告と実装が一致し、審査用の操作を説明できる |
| 4. Playテスト | AAB、内部テスト、必要な12人・14日のクローズドテスト | 実使用の記録と修正を用意し、製品版アクセス申請 |
| 5. 公開・保守 | 製品版申請、問い合わせ窓口、更新手順 | Googleの審査承認。note側の変更に対応できる体制 |

再利用するのはHTML/CSS、本文の無害化、スワイプ、コメントの対応判定、重複防止の考え方。通信・保存・認証を`NoteClient`、`Storage`、`Session`等の境界で分け、まずAndroid用の実装を検証する。Capacitor等を使う場合でも、単なるWebページの包装で認証やストア要件が解決するわけではない。

登録とテスター候補の確保は並行可能。ただし登録料を払えば公開できる状態ではない。テスト期間の14日は開発・連携調整・審査日数とは別に必要で、現状からの公開日や開発費はまだ確定しない。

## Appleへの展開

Apple Developer Programへ登録し、App Store Connectで掲載・プライバシー・審査用情報を用意して審査を受ける。独立したiOSアプリのほか、今の拡張をSafari拡張へ移植してApp Storeで配る案も検討できる。Apple公式はZIPをApp Store Connectへ送り、MacやXcodeなしでSafari拡張を変換・パッケージ化する方法も案内している。ただしFirefoxとのAPI・権限・Cookie・画面互換は検証が必要で、既存ZIPが無変更で動くとは限らない。[Safari拡張の公式案内](https://developer.apple.com/safari/extensions/)

Appleは4.2でWebサイトの再包装を超える有用性、5.2.2で第三者サービスの利用条件・許可に沿うことを求めている。独立iOS版・Safari拡張版のどちらでも関連する審査要件を確認する。[Apple審査基準](https://developer.apple.com/app-store/review/guidelines/)

今回はGoogle Playを先行し、Androidで認証と使い勝手を実証した後、iOS独立アプリかSafari拡張かを選ぶのが妥当。
