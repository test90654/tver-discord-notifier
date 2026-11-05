import {readdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';

const headers = {Origin:'https://tver.jp', Referer:'https://tver.jp/', 'x-tver-platform-type':'web'};
const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[a-z0-9]+$`).test(value);
export function episodeNumber(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : null;
}

export function createCatalog(fetchImpl = fetch) {
  let identity;
  const cache = new Map();
  async function json(url, options={}) {
    const response = await fetchImpl(url,{...options,signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`TVer catalog HTTP ${response.status}`);
    return response.json();
  }
  async function service(endpoint) {
    identity ||= json('https://platform-api.tver.jp/v2/api/platform_users/browser/create',{
      method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:'device_type=pc'
    }).then(data=>{
      if (!data.result?.platform_uid || !data.result?.platform_token) throw new Error('Missing TVer identity');
      return data.result;
    });
    const credentials = await identity;
    const url = new URL(`https://platform-api.tver.jp/service/api/v1/${endpoint}`);
    url.search = new URLSearchParams({platform_uid:credentials.platform_uid,platform_token:credentials.platform_token});
    return (await json(url,{headers})).result;
  }
  return {
    episode(id) {
      if (!validId(id,'ep')) throw new Error('Invalid episode ID');
      if (!cache.has(id)) cache.set(id,(async()=>{
        const result = await service(`callEpisode/${id}`);
        const content = result?.episode?.content;
        if (!content || content.id && content.id !== id) throw new Error('Invalid episode detail');
        const url = new URL(`https://statics.tver.jp/content/episode/${id}.json`);
        url.searchParams.set('v',String(content.version || '5'));
        const data = await json(url,{headers});
        const seriesId = data.seriesID || content.seriesID;
        const seasonId = data.seasonID || content.seasonID;
        if (!validId(seriesId,'sr') || !validId(seasonId,'ss')) throw new Error('Missing series/season ID');
        const now = Date.now()/1000;
        const start = Number(data.viewStatus?.startAt || content.startAt || result.episode.startAt);
        const end = Number(data.viewStatus?.endAt || content.endAt || result.episode.endAt);
        return {id, seriesId, seasonId, number:episodeNumber(data.no),
          title:String(content.seriesTitle || data.series || seriesId).slice(0,160),
          startAt:Number.isFinite(start) && start>0?start:null,endAt:Number.isFinite(end) && end>0?end:null,
          available:content.isAvailable !== false && !(start > now) && !(end > 0 && end <= now)};
      })());
      return cache.get(id);
    },
    async season(id) {
      if (!validId(id,'ss')) throw new Error('Invalid season ID');
      const result = await service(`callSeasonEpisodes/${id}`);
      if (!Array.isArray(result?.contents)) throw new Error('Invalid season episodes');
      return [...new Set(result.contents.filter(x=>x.type==='episode').map(x=>x.content?.id))].map(id=>{
        if (!validId(id,'ep')) throw new Error('Invalid catalog episode ID');
        return id;
      });
    },
    async seriesSeasons(id){
      if(!validId(id,'sr'))throw new Error('Invalid series ID');
      const response=await json(`https://service-api.tver.jp/api/v1/callSeriesSeasons/${id}`,{headers});
      if(!Array.isArray(response.result?.contents))throw new Error('Invalid series seasons');
      return response.result.contents.filter(x=>x.type==='season').map(x=>{
        const seasonId=x.content?.id;
        if(!validId(seasonId,'ss'))throw new Error('Invalid series season ID');
        return {id:seasonId,title:String(x.content.title || '')};
      });
    }
  };
}

// Verify a completed local video, rather than treating archive entries or .part files as saved.
export async function savedEpisodes(directory,{includeIds=false}={}) {
  const saved = [];
  let files;
  try {files = await readdir(directory,{withFileTypes:true});}
  catch(error) {if (error.code==='ENOENT') return saved; throw error;}
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.info.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(directory,file.name),'utf8'));
      const number = episodeNumber(data.episode_number);
      if (!validId(data.series_id,'sr') || !validId(data.season_id,'ss') || !number) continue;
      const base = file.name.slice(0,-'.info.json'.length);
      const video = files.find(x=>x.isFile() && ['mp4','mkv','webm','mov','m4v'].some(ext=>x.name===`${base}.${ext}`));
      if (!video || (await stat(join(directory,video.name))).size === 0) continue;
      const record={seriesId:data.series_id,seasonId:data.season_id,number};
      if(includeIds){
        const id=validId(data.id,'ep')?data.id:String(data.webpage_url || data.original_url || '').match(/tver\.jp\/episodes\/(ep[a-z0-9]+)/)?.[1];
        if(id)record.id=id;
      }
      saved.push(record);
    } catch { /* An unreadable sidecar does not prove an episode is saved. */ }
  }
  return saved;
}

export async function planPastEpisodes(urls, {catalog=createCatalog(), maxPerSeason=200, maxTotal=300, onProgress=()=>{}} = {}) {
  const targets = new Set();
  const groups = new Map();
  const warnings = [];
  for (const url of urls) {
    try {
      const episode = await catalog.episode(new URL(url).pathname.split('/').at(-1));
      if (!episode.number) {
        warnings.push(`話数不明：${episode.title}。過去話の不足を判定できません。 ${url}`);
        continue;
      }
      const key = `${episode.seriesId}/${episode.seasonId}`;
      const group = groups.get(key) || {seriesId:episode.seriesId,seasonId:episode.seasonId,title:episode.title,through:0,episodes:[]};
      group.through = Math.max(group.through,episode.number);
      group.episodes.push(episode);
      groups.set(key,group);
    } catch {
      warnings.push(`作品情報を取得できません。過去話の不足は未確認です。 ${url}`);
    }
  }
  let groupIndex=0;
  for (const group of groups.values()) {
    onProgress({stage:'catalog',title:group.title,groupIndex:++groupIndex,groupTotal:groups.size});
    try {
      const ids = await catalog.season(group.seasonId);
      if (ids.length > maxPerSeason) warnings.push(`一覧上限：${group.title}。${maxPerSeason}件を超えるため過去話の確認が一部できません。`);
      for (const id of ids.slice(0,maxPerSeason)) {
        try {
          const item = await catalog.episode(id);
          if (item.seriesId !== group.seriesId || item.seasonId !== group.seasonId) continue;
          if (!item.number) {
            warnings.push(`話数不明：${group.title} https://tver.jp/episodes/${id}。過去話への自動追加を見送りました。`);
            continue;
          }
          if (item.number <= group.through) {
            group.episodes.push(item);
          }
        } catch {warnings.push(`話数を確認できません：${group.title} https://tver.jp/episodes/${id}`);}
      }
    } catch {warnings.push(`過去話一覧を取得できません：${group.title}。全話そろっているか未確認です。`);}
    group.episodes=[...new Map(group.episodes.map(item=>[item.id,item])).values()].sort((a,b)=>a.number-b.number);
    for(const item of group.episodes){
      const url=`https://tver.jp/episodes/${item.id}`;
      if(item.available || urls.includes(url))targets.add(url);
    }
  }
  for(const url of urls)targets.add(url);
  if (targets.size > maxTotal) warnings.push(`保存上限：対象${targets.size}件のうち${maxTotal}件まで処理します。残りは未保存です。`);
  return {urls:[...targets].slice(0,maxTotal),groups:[...groups.values()],warnings:[...new Set(warnings)]};
}

export function missingWarnings(plan, saved, results) {
  const warnings = [...plan.warnings];
  for (const group of plan.groups) {
    const numbers = new Set(saved.filter(x=>x.seriesId===group.seriesId && x.seasonId===group.seasonId).map(x=>x.number));
    const missing = Array.from({length:group.through},(_,i)=>i+1).filter(n=>!numbers.has(n));
    if (missing.length) {
      const available = new Set(group.episodes.filter(x=>x.available).map(x=>x.number));
      const unavailable = missing.filter(n=>!available.has(n));
      const label = missing.slice(0,50).map(n=>`第${n}話`).join('・') + (missing.length>50?` ほか${missing.length-50}話`:'');
      warnings.push(`不足：${group.title}［${group.seasonId}］第1〜${group.through}話のうち ${label} の保存を確認できません。${unavailable.length?'配信一覧で確認できない話を含みます。配信終了とは限りません。':''}`);
      const failedNumbers=group.episodes.filter(x=>missing.includes(x.number) && x.available && results.some(result=>!result.ok && !result.skipped && result.url===`https://tver.jp/episodes/${x.id}`)).map(x=>x.number);
      if(failedNumbers.length)warnings.push(`配信中・取得失敗：${group.title} ${[...new Set(failedNumbers)].map(n=>`第${n}話`).join('・')}。配信終了ではなく保存処理の失敗です。`);
    }
  }
  const failed = results.filter(x=>!x.ok && !x.skipped);
  if (failed.length) warnings.push(`ダウンロード失敗：${failed.length}件。対象URLは実行結果JSONを確認してください。`);
  const skipped = results.filter(x=>x.skipped);
  if (skipped.length) warnings.push(`未試行：${skipped.length}件。再生許可エラーの連続などで停止したため保存していません。`);
  return [...new Set(warnings)];
}

export function warningMessages(warnings) {
  const messages = [];
  for (const warning of warnings) {
    const line = `⚠ ${warning}`;
    if (!messages.length || messages.at(-1).length+line.length+1>1800) messages.push(line);
    else messages[messages.length-1]+='\n'+line;
  }
  return messages;
}
