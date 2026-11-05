import {spawn} from 'node:child_process';
import {mkdir, open, unlink, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getRanking} from './ranking.mjs';
import {planPastEpisodes, savedEpisodes, missingWarnings, warningMessages} from './past-episodes.mjs';
import {classifyDownloadError, downloadErrorMessage, permissionErrors} from './download-errors.mjs';

export function episodeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'tver.jp' || url.port || url.username || url.password || !/^\/episodes\/ep[a-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('TVerのエピソードURLを指定してください。');
  }
  return `https://tver.jp${url.pathname.replace(/\/$/, '')}`;
}

export function runProcess(command, args, {timeout = 3600000, ...options} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {stdio:['ignore','inherit','pipe'], shell:false, ...options});
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderrTail = (stderrTail+chunk).slice(-32768);
      process.stderr.write(chunk);
    });
    let expired = false;
    const timer = setTimeout(() => {expired = true; child.kill('SIGTERM');}, timeout);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {
      clearTimeout(timer);
      if (expired || code !== 0) {
        const error = new Error(expired ? 'Download timed out' : `Downloader exited with ${code}`);
        error.stderrTail = stderrTail;
        if (expired) error.code = 'DOWNLOAD_TIMEOUT';
        reject(error);
      } else resolvePromise();
    });
  });
}

export function downloadArgs(url, directory, archive) {
  return ['--ignore-config', '--no-playlist', '--no-progress', '--windows-filenames',
    '--write-info-json',
    '--download-archive', archive, '--paths', directory,
    '--output', '%(title).150B [%(id)s].%(ext)s',
    '--format', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '30', '--', episodeUrl(url)];
}

export async function downloadEpisodes(urls, {directory = process.env.DOWNLOAD_DIR || 'downloads', stateDirectory = process.env.DOWNLOAD_STATE_DIR || '.download-state', run = runProcess, onProgress = () => {}, plan = null, scan = savedEpisodes} = {}) {
  const targets = [...new Set(urls.map(episodeUrl))];
  if (!targets.length || targets.length > 300) throw new Error('Specify 1–300 episodes');
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
  const diagnostics = new Set();
  let consecutiveDenials = 0;
  let lastDenial;
  try {
    for (const [index, url] of targets.entries()) {
      onProgress({index:index+1, total:targets.length, url});
      try {
        await run(process.env.YTDLP_BIN || 'yt-dlp', downloadArgs(url, directory, join(stateDirectory, 'archive.txt')));
        results.push({url, ok:true});
        consecutiveDenials = 0;
        lastDenial = null;
      } catch (error) {
        const reason = classifyDownloadError(error);
        results.push({url, ok:false, reason});
        if (reason !== 'downloader_failed') diagnostics.add(downloadErrorMessage(reason));
        consecutiveDenials = permissionErrors.has(reason) ? (lastDenial === reason ? consecutiveDenials+1 : 1) : 0;
        lastDenial = reason;
        console.error(`Download failed: ${url} (see yt-dlp output)`);
        if (consecutiveDenials >= 3 || reason === 'not_installed') {
          const remaining = targets.slice(index+1);
          for (const pending of remaining) results.push({url:pending,ok:false,skipped:true,reason});
          if (remaining.length) diagnostics.add(`同じ再生許可エラーが3件連続、またはyt-dlpを起動できないため、残り${remaining.length}件は未試行で停止しました。配信終了や話数不足が原因とは限りません。`);
          break;
        }
      }
    }
    if (plan) {
      let saved = [];
      try {saved = await scan(directory);}
      catch {plan = {...plan,warnings:[...plan.warnings,'保存先を確認できません。全話そろっているか未確認です。']};}
      results.warnings = missingWarnings(plan,saved,results);
    }
    if (diagnostics.size) results.warnings = [...diagnostics,...(results.warnings || [])];
    await writeFile(join(stateDirectory, 'last-result.json'), JSON.stringify({at:new Date().toISOString(), results, warnings:results.warnings || []},null,2)+'\n');
    return results;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function downloadCollection(urls, {planner = planPastEpisodes, ...options} = {}) {
  const plan = await planner([...new Set(urls.map(episodeUrl))]);
  return downloadEpisodes(plan.urls,{...options,plan});
}

export async function postDownloadReport(results, webhook, fetchImpl = fetch) {
  if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook || '')) throw new Error('Set valid DISCORD_WEBHOOK_URL for --discord-report');
  const ok = results.filter(x=>x.ok).length;
  const skipped = results.filter(x=>x.skipped).length;
  for (const content of [`動画保存の処理結果：成功または保存履歴あり ${ok}/${results.length}件、失敗 ${results.length-ok-skipped}件、未試行 ${skipped}件`,...warningMessages(results.warnings || [])]) {
    const response = await fetchImpl(`${webhook}?wait=true`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Discord download report HTTP ${response.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = process.argv.includes('--discord-report');
    const args = process.argv.slice(2).filter(x=>x!=='--discord-report');
    const urls = args.length === 1 && args[0] === '--ranking' ? await getRanking() : args;
    const results = await downloadCollection(urls);
    console.log(`Completed or already saved: ${results.filter(x=>x.ok).length}/${results.length}`);
    for (const warning of results.warnings) console.warn(`WARNING: ${warning}`);
    if (report) await postDownloadReport(results,process.env.DISCORD_WEBHOOK_URL);
    if (results.some(x=>!x.ok)) process.exitCode = 1;
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
