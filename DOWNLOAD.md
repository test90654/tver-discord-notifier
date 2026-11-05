# ランキング自動保存とDiscordからの操作

毎日21:10（日本時間）に、最新のドラマランキング上位10**エピソード**と、それぞれと同じシーズンの第1話から対象話までの配信中エピソードをyt-dlpで保存します。同じ作品でも別エピソードは別扱いです。保存済み履歴にあるエピソードは再保存しません。失敗したものは履歴に入らず、手動再実行や次回のランキング対象になったときに再試行できます。

## おすすめ：日本国内のPCでBotを常駐

Discordから操作する場合はこちらを使います。PCの電源とBotの起動が必要です。動画はBotを動かすPCの `downloads/` に保存します。Discordへ動画ファイルは添付せず、進行状況と完了結果を通知します。

### 1. 必要なもの

- Node.js 22.12以降（npmを含む）
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) とffmpeg。両方の実行ファイルをPATHへ追加
- Discordの専用Botアプリケーション

まずターミナルで `node --version`、`yt-dlp --version`、`ffmpeg -version` が実行できることを確認します。Pythonを使う場合は `python -m pip install -U yt-dlp` でも導入できます。TVerの仕様変更に対応するためyt-dlpは適宜更新してください。

### 2. Discordの設定

1. [Discord Developer Portal](https://discord.com/developers/applications) で専用アプリを作成し、Botトークンを取得します。既存の通知Webhookとは別です。
2. OAuth2のURL Generatorで `bot` と `applications.commands` を選択し、通知先チャンネルの「チャンネルを見る」「メッセージを送信」を許可してサーバーへ招待します。特権Intentと管理者権限は不要です。
3. Discordの「ユーザー設定 → 詳細設定 → 開発者モード」を有効にします。右クリックでサーバーID、通知先チャンネルID、操作を許可するユーザーIDをコピーします。
4. このフォルダーの `.env.example` を `.env` にコピーし、以下を設定します。トークンをGitHubやチャットに貼らないでください。

```dotenv
DISCORD_BOT_TOKEN=取得したBotトークン
DISCORD_GUILD_ID=サーバーID
DISCORD_CHANNEL_ID=完了通知のチャンネルID
DISCORD_ALLOWED_USER_IDS=自分のユーザーID
AUTO_DOWNLOAD=true
DOWNLOAD_DIR=downloads
DOWNLOAD_STATE_DIR=.download-state
```

複数人に操作を許可する場合はユーザーIDをカンマ区切りにします。指定サーバーかつ許可ユーザーのみ操作できます。Bot起動時、このアプリの対象サーバー内のコマンド一覧を置換登録するため、専用アプリを使ってください。

### 3. 起動

リポジトリのフォルダーで実行します。

```sh
npm ci
npm test
npm run bot
```

`TVer bot ready.` が表示されたら利用できます。起動中はターミナルを開いたままにし、再起動後も利用したい場合はOSのサービスやタスクスケジューラで同じ作業フォルダーから起動します。

| Discordコマンド | 動作 |
| --- | --- |
| `/download ranking` | 最新のドラマTOP10と同じシーズンの過去話を保存 |
| `/download url url:https://tver.jp/episodes/ep...` | 指定した話と同じシーズンの過去話を保存 |
| `/status` | 実行中の件数、直近の結果、自動保存設定を表示 |
| `/auto enabled:True` | 毎日21:10の自動保存をON |
| `/auto enabled:False` | Botの自動保存をOFF |

手動指示にはすぐ応答し、長時間の処理結果は設定した通知チャンネルへ投稿します。並行実行と待ち行列は受け付けず、実行中の再指示は拒否します。1話に失敗しても残りの対象は続行します。`/status` の進行件数は処理順であり、成功件数とは限りません。

初回は `AUTO_DOWNLOAD` で自動保存のON/OFFを決め、以後は `.download-state/schedule.json` の設定を優先します。21:10以降に起動した場合、当日まだ試行していなければ実行します。停止していた過去の日付は遡りません。自動実行は失敗しても当日1回の試行として記録されるため、その日の再試行は `/download ranking` を使います。

### 保存先と履歴

`DOWNLOAD_DIR` は絶対パスも指定可能です。相対パスは起動した作業フォルダーを基準にします。`.download-state/archive.txt` はyt-dlpの成功履歴です。動画と履歴は一緒にバックアップしてください。動画だけ削除して履歴を残すと再保存されません。

BotとCLIで同じ `DOWNLOAD_STATE_DIR` を使うとロックで同時実行を防ぎます。異常終了して `.download-state/download.lock` が残った場合は、**yt-dlpを含む関連プロセスが停止していることを確認してから**ロックだけ削除します。Botを停止する際は処理完了を待ってください。1話の処理は最大60分、再試行は3回です。

## 過去話の収集と不足警告

ランキング対象やURL指定の話が第5話なら、**同じシーズンの第1〜5話**を確認して配信中の話を追加保存します。別シーズン、対象話より後の話、話数を判定できない予告・特別映像は自動追加しません。ランキングに同じ作品が複数あれば、最も後の対象話までをまとめ、重複URLを除きます。

保存後、同じシーズンの話数を照合し、例えば「⚠ 不足：作品名 第1〜5話のうち 第2話・第4話 の保存を確認できません」と通知します。Botは設定したチャンネルへ詳細を投稿し、`/status` には警告件数を表示します。Actionsは既存の `DISCORD_WEBHOOK_URL` secretで結果と警告を投稿します。CLI単独では標準出力と結果JSONに記録し、Discordにも送りたい場合だけ `--discord-report` を付けます。

確認対象は保存フォルダー直下の動画と、yt-dlpが出力する `.info.json` です。両方を残してください。履歴だけ、ゼロバイト動画、`.part` ファイル、別シーズンの同じ話数は保存済みと数えません。動画の完全性や前後編の全パートまでは検証しません。旧バージョンで保存して話数情報ファイルがないものは確認できないため警告対象です。

話数・作品情報が不明、一覧取得失敗、取得上限などの場合も「確認できない」と警告します。警告がなくても対象話より先の最終回までそろったことを意味しません。配信終了した過去話はTVerから取得できず、不足として残ります。1シーズンの一覧確認は200件、1回の保存対象は300件までで、上限に達した場合は省略を警告します。

Actionsの一時環境には過去のArtifactsの動画がないため、キャッシュ履歴にある話でも今回の保存先に動画を確認できなければ警告します。ローカルの常駐Botで保存先を継続利用する構成が、この不足確認に適しています。履歴を残したまま動画を移動・削除した場合は警告されますが、自動で履歴を消して再取得はしません。

## Botを使わずローカルで保存

`.env` の保存先設定を使い、以下も実行できます。DiscordのトークンやWebhookは不要です。

```sh
npm run download -- --ranking
npm run download -- https://tver.jp/episodes/epxxxxxxxx
```

## GitHub Actionsだけで自動保存

`.github/workflows/download.yml` は既存の毎日21:00の通知とは別に、21:10の保存を実行します。Discordからの操作は常駐Botが担当するため、この方式だけでは利用できません。

事前に通知用の `DISCORD_WEBHOOK_URL` secretを設定してください。動画処理後に結果と不足警告を送信します。

1. Settings → Secrets and variables → Actions → Variables に `DOWNLOAD_ENABLED=true` を登録すると定期保存が有効になります。未設定なら定期ダウンロードはしません。Actionsの「TVer download ranking → Run workflow」では変数にかかわらず手動実行できます。
2. 成功した動画と結果JSONを実行画面のArtifactsから取得します。保持期間は7日です。履歴はActions cacheに保存するので、同じエピソードを次の日に再保存しません。
3. 一部失敗でも保存済み動画をアップロードし、アップロード成功後に成功分の履歴をキャッシュします。キャッシュが失効した場合や保存に失敗した場合は重複する可能性があります。成果物期限後に再取得したい場合は対応する `tver-download-` キャッシュを削除して再実行します。

TVerは日本国内向けです。通常の `ubuntu-latest` は海外環境となる場合があり、ダウンロードできる保証はありません。日本国内のself-hosted runnerを使う場合は `TVER_DOWNLOAD_RUNNER=self-hosted` を設定し、その専用runnerにNode.js、yt-dlp、ffmpegをあらかじめ導入してください。外部のPRを実行する用途とrunnerを共用しないでください。

Botの自動保存を使う場合、Actions側の `DOWNLOAD_ENABLED` は未設定または `false` にします。両方式の履歴は共有されず、`/auto` はBot側だけを切り替えます。Actionsの動画保存にはストレージ容量と実行時間を使用します。

## 確認と制約

### 全件が `REQUEST_FAILED: 163` で失敗する場合

これはSTREAKSの動画再生APIからの視聴許可拒否です。作品一覧や話数情報が取得できても、動画を再生・保存できるとは限りません。163だけでは地域制限、IP制限、API対応など、どれが原因か断定できません。

2026年11月5日（日本時間）の本リポジトリの失敗実行では、GitHub標準Ubuntuランナーと、当時の最新版yt-dlp `2026.10.26` を使用していました。更新だけで解決するとは限りません。GitHub標準ランナーは日本国内の実行を保証しないため、まず日本国内のPC・回線で切り分けてください。

1. 同じPCのブラウザーで対象のTVer番組が再生できることを確認します。
2. そのPCでyt-dlpを更新し、リポジトリのフォルダーから次の診断を実行します。動画も履歴も保存しません。

```sh
node --env-file-if-exists=.env diagnose.mjs https://tver.jp/episodes/epikrjbomm
```

診断が成功したら `npm run download -- https://tver.jp/episodes/epikrjbomm` で保存を確認します。ブラウザーでは再生できるのに診断は失敗する場合、実行環境、yt-dlpのバージョン、エラー本文を確認して[yt-dlpのIssue](https://github.com/yt-dlp/yt-dlp/issues)で同じ報告があるか調べてください。163を地域制限と決めつけて回避設定を追加する処理はありません。

ローカルで動作したら、Discord操作にはそのPCで `npm run bot` を使います。Actionsから実行したい場合は、その日本国内PCをGitHubの Settings → Actions → Runners でself-hosted runnerとして登録し、リポジトリのActions変数に `TVER_DOWNLOAD_RUNNER=self-hosted` を設定します。`TVER_DOWNLOAD_RUNNER` を設定するだけではrunner本体は作成されません。Node.js、yt-dlp、ffmpegをrunnerの実行ユーザーのPATHから起動できるようにしてください。

同じ再生許可エラーが3件連続した場合、残りは「未試行」として止め、エラーの種類と次の確認方法をDiscord・ログ・結果JSONへ表示します。単発の配信終了などの通常エラーでは残りの番組を続行します。この改善は外部APIの許可拒否そのものを解除するものではありません。

`npm test` はURL検証、ランキング検証、失敗時の継続、排他制御、権限判定、日本時間のスケジュール、既存通知をネットワークなしで検証します。Botトークンを使う接続試験と実際のTVer動画ダウンロードは、利用する日本国内のホストで確認してください。

地域制限やDRMを回避する処理はありません。アクセスできない番組、配信終了、DRM、サイト変更などは失敗として扱います。

参照：[yt-dlp公式](https://github.com/yt-dlp/yt-dlp)、[TVer extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tver.py)、[Discord application commands](https://docs.discord.com/developers/interactions/application-commands)。ランキング取得のAPIフローは既存通知と同様にTVerRecを参考にしています（`THIRD_PARTY_NOTICES.md`）。
