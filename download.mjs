import {spawn} from 'node:child_process';
import {mkdir, open, unlink, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getRanking} from './ranking.mjs';

export function episodeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'tver.jp' || url.port || url.username || url.password || !/^\/episodes\/ep[a-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('TVerのエピソードURLを指定してください。');
  }
  return `https://tver.jp${url.pathname.replace(/\/$/, '')}`;
}

export function runProcess(command, args, {timeout = 3600000, ...options} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {stdio:'inherit', shell:false, ...options});
    let expired = false;
    const timer = setTimeout(() => {expired = true; child.kill('SIGTERM');}, timeout);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {
      clearTimeout(timer);
      if (expired || code !== 0) reject(new Error(expired ? 'Download timed out' : `Downloader exited with ${code}`));
      else resolvePromise();
    });
  });
}

export function downloadArgs(url, directory, archive) {
  return ['--ignore-config', '--no-playlist', '--no-progress', '--windows-filenames',
    '--download-archive', archive, '--paths', directory,
    '--output', '%(title).150B [%(id)s].%(ext)s',
    '--format', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '30', '--', episodeUrl(url)];
}

export async function downloadEpisodes(urls, {directory = process.env.DOWNLOAD_DIR || 'downloads', stateDirectory = process.env.DOWNLOAD_STATE_DIR || '.download-state', run = runProcess, onProgress = () => {}} = {}) {
  const targets = [...new Set(urls.map(episodeUrl))];
  if (!targets.length || targets.length > 10) throw new Error('Specify 1–10 episodes');
  directory = resolve(directory);
  stateDirectory = resolve(stateDirectory);
  await mkdir(directory, {recursive:true});
  await mkdir(stateDirectory, {recursive:true});
  const lockPath = join(stateDirectory, 'download.lock');
  let lock;
  try {lock = await open(lockPath, 'wx');}
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('別のダウンロードが実行中です。異常終了後はプロセスが停止していることを確認してdownload.lockを削除してください。');
    throw error;
  }
  const results = [];
  try {
    for (const [index, url] of targets.entries()) {
      onProgress({index:index+1, total:targets.length, url});
      try {
        await run(process.env.YTDLP_BIN || 'yt-dlp', downloadArgs(url, directory, join(stateDirectory, 'archive.txt')));
        results.push({url, ok:true});
      } catch {
        results.push({url, ok:false});
        console.error(`Download failed: ${url} (see yt-dlp output)`);
      }
    }
    await writeFile(join(stateDirectory, 'last-result.json'), JSON.stringify({at:new Date().toISOString(), results},null,2)+'\n');
    return results;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const urls = args.length === 1 && args[0] === '--ranking' ? await getRanking() : args;
    const results = await downloadEpisodes(urls);
    console.log(`Completed or already saved: ${results.filter(x=>x.ok).length}/${results.length}`);
    if (results.some(x=>!x.ok)) process.exitCode = 1;
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
