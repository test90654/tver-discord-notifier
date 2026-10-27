import { readFile, writeFile } from 'node:fs/promises';
import { detectOldDramas } from './old-dramas.mjs';

const source = 'https://tver.jp/rankings/episode/drama';
const dryRun = process.argv.includes('--dry-run');
const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!dryRun && (!webhook || !/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook))) {
  throw new Error('Set a valid DISCORD_WEBHOOK_URL repository secret.');
}
// API flow adapted from dongaba/TVerRec (MIT); see THIRD_PARTY_NOTICES.md.
const headers = { 'Origin': 'https://tver.jp', 'Referer': 'https://tver.jp/', 'x-tver-platform-type': 'web' };
async function apiJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('TVer API request failed.'); }
  if (!response.ok) throw new Error(`TVer API returned HTTP ${response.status}.`);
  let data;
  try { data = await response.json(); } catch { throw new Error('Invalid TVer API response.'); }
  if (!data.result) throw new Error('TVer API returned no result.');
  return data.result;
}
const identity = await apiJson('https://platform-api.tver.jp/v2/api/platform_users/browser/create', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'device_type=pc'
});
if (!identity.platform_uid || !identity.platform_token) throw new Error('Could not obtain TVer anonymous credentials.');
const url = new URL('https://platform-api.tver.jp/service/api/v1/callEpisodeRankingDetail/drama');
url.search = new URLSearchParams({ platform_uid: identity.platform_uid, platform_token: identity.platform_token });
async function service(endpoint) {
  const target = new URL('https://platform-api.tver.jp/service/api/v1/' + endpoint);
  target.search = url.search;
  return apiJson(target, {headers});
}
const observedAt = new Date();
const [ranking, catalog, newer] = await Promise.all([
  apiJson(url, {headers}), service('callTagSearch/drama'), service('callNewerDetail/drama')
]);
if (!Array.isArray(catalog.contents) || catalog.contents.length === 0 || newer?.contents?.content?.id !== 'drama' || !Array.isArray(newer.contents.contents)) {
  throw new Error('Invalid old-drama catalog/newer response; notification history preserved.');
}
const statePath = new URL('./.state/old-dramas.json', import.meta.url);
const history = JSON.parse(await readFile(statePath, 'utf8'));
const { additions, nextState } = detectOldDramas(history, catalog.contents, newer.contents.contents, observedAt);
if (ranking?.contents?.content?.id !== 'drama') throw new Error('Unexpected ranking category.');
const rows = ranking.contents.contents.filter(x => x.type === 'episode').sort((a,b) => a.rank-b.rank).slice(0,10);
if (rows.length !== 10 || rows.some((x,i) => x.rank !== i+1 || !/^ep[a-z0-9]+$/.test(x.content?.id) || !x.content?.seriesTitle) || new Set(rows.map(x=>x.content.id)).size !== 10) {
  throw new Error('Could not validate the top 10; no notification sent.');
}
const escape = s => String(s).replace(/[\\*_~`|\[\]<>]/g, '\\$&');
const date = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'short'}).format(new Date());
const embeds = [{
  title: 'TVer ドラマランキング TOP10', url: source, color: 0x00aa99,
  description: `${date}（日本時間）取得\nエピソード単位のランキングです。\n旧作の新規検出：${additions.length}作品`,
  fields: rows.map(x => ({name: `${x.rank}位　${x.content.seriesTitle}`.slice(0,256),value: `[${escape(x.content.title || '視聴する').slice(0,700)}](https://tver.jp/episodes/${x.content.id})`,inline:false})),
  footer: {text:'出典：TVer公式ドラマランキング'}
}];
const formatTime = seconds => new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'short'}).format(new Date(seconds * 1000));
for (let i=0; i<additions.length; i+=10) {
  embeds.push({
    title:'新しく配信が始まった旧作ドラマ', color:0xe8a63b,
    description:'監視開始後、初めて新着一覧で確認した作品です。同じ作品の追加話は通知しません。',
    fields:additions.slice(i,i+10).map(x=>({
      name:x.title.slice(0,256),
      value:`[${x.year}年放送・作品ページ](https://tver.jp/series/${x.id})\n配信開始：${formatTime(x.startAt)}\n今回の新着一覧に${x.episodeCount}話／掲載話の最短期限：${formatTime(x.endAt)}`,
      inline:false
    })),
    footer:{text:'時刻は日本時間。話数は新着一覧で確認した範囲です。'}
  });
}
if (dryRun) console.log(JSON.stringify({embeds}, null, 2));
else {
  // Do not retry ambiguous failures: a retry could post the same message twice.
  for (const embed of embeds) {
  let response;
  try { response = await fetch(`${webhook}?wait=true`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(30000)}); }
  catch { throw new Error('Discord request failed; check the channel before retrying.'); }
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);
  }
  await writeFile(statePath, JSON.stringify(nextState, null, 2) + '\n');
  console.log(`Posted ranking and ${additions.length} new archive works; history updated.`);
}
