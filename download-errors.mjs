export function classifyDownloadError(error) {
  if (error?.code === 'ENOENT') return 'not_installed';
  if (error?.code === 'DOWNLOAD_TIMEOUT') return 'timed_out';
  const text = String(error?.stderrTail || error?.message || '');
  if (/REQUEST_FAILED\s*:\s*163\b/i.test(text)) return 'streaks_163';
  if (/REQUEST_FAILED\s*:\s*124\b|not available (?:in|from) your country|available in Japan|geo.?restrict/i.test(text)) return 'geo_restricted';
  if (/REQUEST_FAILED\s*:\s*126\b|Access is denied \(possibly due to invalid\/missing API key\)/i.test(text)) return 'api_access_denied';
  return 'downloader_failed';
}

export function downloadErrorMessage(reason) {
  const messages = {
    streaks_163:'STREAKS 163：動画再生APIが視聴を拒否しています。地域・IP制限などの可能性がありますが、このコードだけでは原因を断定できません。日本国内の同じPC・回線でブラウザー再生と node diagnose.mjs <番組URL> を確認してください。',
    geo_restricted:'地域制限：日本国内の、公式プレイヤーで再生できるPC・回線で実行してください。通常のGitHub標準ランナーは日本国内の実行を保証しません。',
    api_access_denied:'再生APIのアクセス拒否：yt-dlpのバージョンと同じPCでの公式プレイヤー再生を確認してください。更新後も続く場合はyt-dlp側の対応状況を確認してください。',
    not_installed:'yt-dlpを起動できません。インストールとPATH、YTDLP_BIN設定を確認してください。',
    timed_out:'動画処理がタイムアウトしました。回線と配信状況を確認してください。'
  };
  return messages[reason] || '動画処理に失敗しました。ホストのyt-dlpログを確認してください。';
}

export const permissionErrors = new Set(['streaks_163','geo_restricted','api_access_denied']);
