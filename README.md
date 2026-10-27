# TVer → Discord

毎日21:00（日本時間）に、TVer公式ドラマランキングの上位10エピソードをDiscordへ投稿します。順位・番組名・エピソード名・視聴リンクを掲載します。

## 設定

1. Discordの「サーバー設定 → 連携サービス → ウェブフック」で通知先のWebhookを作成し、URLをコピー。
2. GitHubリポジトリの「Settings → Secrets and variables → Actions → New repository secret」で、名前を `DISCORD_WEBHOOK_URL`、値をWebhook URLにして保存。URLをコードやIssueに書かないでください。
3. Actionsの「TVer drama ranking → Run workflow」を開き、`dry_run` をオンのまま実行して取得を確認。
4. `dry_run` をオフにして手動実行し、Discordへの投稿を確認。

スケジュールはデフォルトブランチ上で動きます。GitHub Actionsは混雑時に遅延・実行漏れが生じる可能性があります。公開リポジトリでは60日間リポジトリの活動がないと定期実行が無効になるため、無効化された場合はActions画面から再有効化してください。

[TVerRec](https://github.com/dongaba/TVerRec) の匿名トークン取得・ランキングAPI呼び出しを参考に、Node.jsからAPIへ直接アクセスします。TVerRec本体のインストールや動画ダウンロードは行いません。出典とMITライセンスは THIRD_PARTY_NOTICES.md に記載しています。順位はAPIの rank を使用します。公式に保証された外部向けAPIではないため、サイト変更やGitHub実行環境からのアクセス制限により停止する場合があります。取得できない、または上位10件を検証できない場合は投稿せず、Actionsを失敗にします。失敗はActions画面で確認してください。

## ローカルプレビュー

Node.js 22以降で `npm run preview`（外部パッケージのインストール不要）。プレビューはDiscordへ送信しません。

コード変更時のpushでも、Discordへ送信しない取得プレビューを自動実行します。

## 停止

Actionsの対象ワークフローで「Disable workflow」。Webhookの削除でも投稿を止められます。
