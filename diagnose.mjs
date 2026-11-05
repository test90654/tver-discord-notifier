import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {episodeUrl, runProcess} from './download.mjs';
import {classifyDownloadError, downloadErrorMessage} from './download-errors.mjs';

export function diagnosticArgs(url) {
  // Resolves playback formats only; never writes a video, metadata or download history.
  return ['--ignore-config','--simulate','--no-playlist','--no-progress','--socket-timeout','30','--retries','1','--',episodeUrl(url)];
}

export async function diagnose(url, run = runProcess) {
  const args = diagnosticArgs(url);
  const binary = process.env.YTDLP_BIN || 'yt-dlp';
  console.log(`実行環境：${process.env.GITHUB_ACTIONS === 'true' ? 'GitHub Actions / '+(process.env.RUNNER_ENVIRONMENT || 'unknown') : 'ローカル／独自ホスト'}`);
  console.log('yt-dlpのバージョン：');
  try {
    await run(binary,['--version'],{timeout:30000});
    console.log('1話の再生情報を確認します。動画は保存しません。');
    await run(binary,args,{timeout:120000});
    console.log('再生情報の取得に成功しました。動画本体の転送・保存は未確認です。');
    return {ok:true};
  } catch (error) {
    const reason = classifyDownloadError(error);
    console.error(downloadErrorMessage(reason));
    return {ok:false,reason};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node --env-file-if-exists=.env diagnose.mjs https://tver.jp/episodes/ep...');
    if (!(await diagnose(process.argv[2])).ok) process.exitCode = 1;
  } catch(error) {console.error(error.message);process.exitCode = 1;}
}
