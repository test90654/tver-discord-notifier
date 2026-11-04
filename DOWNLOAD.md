# ランキング自動保存とDiscordからの操作

毎日21:10（日本時間）に、最新のドラマランキング上位10**エピソード**をyt-dlpで保存します。同じ作品でも別エピソードは別扱いです。保存済み履歴にあるエピソードは再保存しません。失敗したものは履歴に入らず、手動再実行や次回のランキング対象になったときに再試行できます。

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
| `/download ranking` | 最新のドラマTOP10を保存 |
| `/download url url:https://tver.jp/episodes/ep...` | 指定した1話を保存 |
| `/status` | 実行中の件数、直近の結果、自動保存設定を表示 |
| `/auto enabled:True` | 毎日21:10の自動保存をON |
| `/auto enabled:False` | Botの自動保存をOFF |

手動指示にはすぐ応答し、長時間の処理結果は設定した通知チャンネルへ投稿します。並行実行と待ち行列は受け付けず、実行中の再指示は拒否します。1話に失敗しても残りの対象は続行します。`/status` の進行件数は処理順であり、成功件数とは限りません。

初回は `AUTO_DOWNLOAD` で自動保存のON/OFFを決め、以後は `.download-state/schedule.json` の設定を優先します。21:10以降に起動した場合、当日まだ試行していなければ実行します。停止していた過去の日付は遡りません。自動実行は失敗しても当日1回の試行として記録されるため、その日の再試行は `/download ranking` を使います。

### 保存先と履歴

`DOWNLOAD_DIR` は絶対パスも指定可能です。相対パスは起動した作業フォルダーを基準にします。`.download-state/archive.txt` はyt-dlpの成功履歴です。動画と履歴は一緒にバックアップしてください。動画だけ削除して履歴を残すと再保存されません。

BotとCLIで同じ `DOWNLOAD_STATE_DIR` を使うとロックで同時実行を防ぎます。異常終了して `.download-state/download.lock` が残った場合は、**yt-dlpを含む関連プロセスが停止していることを確認してから**ロックだけ削除します。Botを停止する際は処理完了を待ってください。1話の処理は最大60分、再試行は3回です。

## Botを使わずローカルで保存

`.env` の保存先設定を使い、以下も実行できます。DiscordのトークンやWebhookは不要です。

```sh
npm run download -- --ranking
npm run download -- https://tver.jp/episodes/epxxxxxxxx
```

## GitHub Actionsだけで自動保存

`.github/workflows/download.yml` は既存の毎日21:00の通知とは別に、21:10の保存を実行します。Discordからの操作は常駐Botが担当するため、この方式だけでは利用できません。

1. Settings → Secrets and variables → Actions → Variables に `DOWNLOAD_ENABLED=true` を登録すると定期保存が有効になります。未設定なら定期ダウンロードはしません。Actionsの「TVer download ranking → Run workflow」では変数にかかわらず手動実行できます。
2. 成功した動画と結果JSONを実行画面のArtifactsから取得します。保持期間は7日です。履歴はActions cacheに保存するので、同じエピソードを次の日に再保存しません。
3. 一部失敗でも保存済み動画をアップロードし、アップロード成功後に成功分の履歴をキャッシュします。キャッシュが失効した場合や保存に失敗した場合は重複する可能性があります。成果物期限後に再取得したい場合は対応する `tver-download-` キャッシュを削除して再実行します。

TVerは日本国内向けです。通常の `ubuntu-latest` は海外環境となる場合があり、ダウンロードできる保証はありません。日本国内のself-hosted runnerを使う場合は `TVER_DOWNLOAD_RUNNER=self-hosted` を設定し、その専用runnerにNode.js、yt-dlp、ffmpegをあらかじめ導入してください。外部のPRを実行する用途とrunnerを共用しないでください。

Botの自動保存を使う場合、Actions側の `DOWNLOAD_ENABLED` は未設定または `false` にします。両方式の履歴は共有されず、`/auto` はBot側だけを切り替えます。Actionsの動画保存にはストレージ容量と実行時間を使用します。

## 確認と制約

`npm test` はURL検証、ランキング検証、失敗時の継続、排他制御、権限判定、日本時間のスケジュール、既存通知をネットワークなしで検証します。Botトークンを使う接続試験と実際のTVer動画ダウンロードは、利用する日本国内のホストで確認してください。

地域制限やDRMを回避する処理はありません。アクセスできない番組、配信終了、DRM、サイト変更などは失敗として扱います。

参照：[yt-dlp公式](https://github.com/yt-dlp/yt-dlp)、[TVer extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tver.py)、[Discord application commands](https://docs.discord.com/developers/interactions/application-commands)。ランキング取得のAPIフローは既存通知と同様にTVerRecを参考にしています（`THIRD_PARTY_NOTICES.md`）。
