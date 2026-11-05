import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createCatalog,episodeNumber} from './past-episodes.mjs';

let saving=Promise.resolve();
export function sourceEpisodeId(value){
  const url=new URL(value);
  if(url.protocol!=='https:' || url.hostname!=='tver.jp' || url.username || url.password || url.port || !/^\/episodes\/ep[a-z0-9]+\/?$/.test(url.pathname))throw new Error('TVerのエピソードURLを指定してください。');
  return url.pathname.split('/').filter(Boolean).at(-1);
}
export function youtubeVideoUrl(value){
  const url=new URL(value);
  if(url.protocol!=='https:' || url.username || url.password || url.port)throw new Error('YouTubeの動画URLを指定してください。');
  let id;
  if(['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)){
    if(url.pathname==='/watch')id=url.searchParams.get('v');
    else id=url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)\/?$/)?.[1];
  }else if(url.hostname==='youtu.be')id=url.pathname.slice(1);
  if(!/^[\w-]{11}$/.test(id || ''))throw new Error('YouTubeの動画URLを指定してください。');
  return `https://www.youtube.com/watch?v=${id}`;
}
export async function readExternalCopies(stateDirectory){
  try{
    const data=JSON.parse(await readFile(join(stateDirectory,'external-copies.json'),'utf8'));
    if(data.version!==1 || !Array.isArray(data.copies))throw new Error('Invalid external copy history');
    for(const item of data.copies){
      if(!/^ep[a-z0-9]+$/.test(item.id) || !/^sr[a-z0-9]+$/.test(item.seriesId) || !/^ss[a-z0-9]+$/.test(item.seasonId) || !episodeNumber(item.number))throw new Error('Invalid external copy entry');
      youtubeVideoUrl(item.youtubeUrl);
    }
    return data.copies;
  }catch(error){if(error.code==='ENOENT')return [];throw error;}
}
export function matchesExternalCopy(copies,item){
  return copies.some(x=>x.id===item.id || item.number && x.seriesId===item.seriesId && x.seasonId===item.seasonId && x.number===item.number);
}
export async function resolveUploadEpisode(value,{directory=process.env.DOWNLOAD_DIR || 'downloads',catalog=createCatalog(),stateDirectory=process.env.DOWNLOAD_STATE_DIR || '.download-state'}={}){
  const id=sourceEpisodeId(value);
  const existing=(await readExternalCopies(stateDirectory)).find(x=>x.id===id);
  if(existing)return existing;
  try{
    for(const file of await readdir(directory)){
      if(!file.endsWith('.info.json'))continue;
      try{
        const item=JSON.parse(await readFile(join(directory,file),'utf8'));
        if(item.id!==id && ![item.webpage_url,item.original_url].some(x=>{try{return sourceEpisodeId(x)===id;}catch{return false;}}))continue;
        if(/^sr[a-z0-9]+$/.test(item.series_id) && /^ss[a-z0-9]+$/.test(item.season_id) && episodeNumber(item.episode_number))return {id,seriesId:item.series_id,seasonId:item.season_id,number:episodeNumber(item.episode_number),title:String(item.series || item.title).slice(0,160)};
      }catch{}
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const item=await catalog.episode(id);
  if(!item.number)throw new Error('話数が不明なため登録できません。');
  return item;
}
export async function setExternalCopy({episode,youtubeUrl,declaredBy,remove=false},stateDirectory){
  if(!/^ep[a-z0-9]+$/.test(episode?.id || '') || !/^sr[a-z0-9]+$/.test(episode?.seriesId || '') || !/^ss[a-z0-9]+$/.test(episode?.seasonId || '') || !episodeNumber(episode?.number))throw new Error('Invalid episode metadata');
  const task=saving.catch(()=>{}).then(async()=>{
    const copies=await readExternalCopies(stateDirectory);
    const kept=copies.filter(x=>x.id!==episode.id && !(x.seriesId===episode.seriesId && x.seasonId===episode.seasonId && x.number===episode.number));
    if(!remove)kept.push({id:episode.id,seriesId:episode.seriesId,seasonId:episode.seasonId,number:episode.number,title:episode.title,youtubeUrl:youtubeVideoUrl(youtubeUrl),declaredAt:new Date().toISOString(),declaredBy,verification:'user-declared'});
    await mkdir(stateDirectory,{recursive:true});
    const path=join(stateDirectory,'external-copies.json');
    await writeFile(path+'.tmp',JSON.stringify({version:1,copies:kept},null,2)+'\n');
    await rename(path+'.tmp',path);
    return {removed:remove,episode};
  });
  saving=task;return task;
}
