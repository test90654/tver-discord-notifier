import {mkdir,readFile,writeFile,rename,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createCatalog,savedEpisodes,episodeNumber} from './past-episodes.mjs';
import {getRanking} from './ranking.mjs';

const valid=(id,prefix)=>typeof id==='string' && new RegExp(`^${prefix}[a-z0-9]+$`).test(id);
const label=episode=>`${episode.title} 第${episode.number || '?'}話`;
const url=episode=>`https://tver.jp/episodes/${episode.id}`;
const time=value=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'short'}).format(new Date(value*1000));
export function prioritizeEpisodes(episodes,now,urgentSeconds=21600){
  return [...episodes].sort((a,b)=>{
    const urgent=x=>x.endAt>now && x.endAt-now<=urgentSeconds;
    if(urgent(a)!==urgent(b))return urgent(a)?-1:1;
    if(urgent(a) && a.endAt!==b.endAt)return a.endAt-b.endAt;
    if(a.seasonId===b.seasonId)return (a.number || 10000)-(b.number || 10000);
    return (a.seasonFirstSeen || a.firstSeen || 0)-(b.seasonFirstSeen || b.firstSeen || 0) || a.seasonId.localeCompare(b.seasonId);
  });
}
export function retryDelay(attempts,interval=600){return Math.min(3600,interval*2**Math.min(6,Math.max(0,attempts-1)));}
export function mainSeasonLabel(value){
  const title=String(value || '').trim();
  if(/解説|予告|ダイジェスト|見どころ|限定|特典|インタビュー|メイキング/i.test(title))return false;
  return /^(?:本編(?:[（(].*[）)])?|シーズン\s*[0-9０-９]+|season\s*\d+|第[0-9０-９一二三四五六七八九十]+(?:期|シリーズ)|20\d{2}年(?:放送|版)?)$/i.test(title);
}

export class DeadlineWatcher {
  constructor({controller,stateDirectory=controller.stateDirectory,directory=process.env.DOWNLOAD_DIR || 'downloads',catalogFactory=createCatalog,ranking=getRanking,scan=savedEpisodes,report=async()=>true,now=()=>Date.now()/1000,interval=600,batchSize=5,urgentSeconds=21600}={}){
    Object.assign(this,{controller,stateDirectory,directory,catalogFactory,ranking,scan,report,now,interval,batchSize,urgentSeconds});
    this.state={version:1,seasons:{},episodes:{},alerts:{},lastScan:null};
    this.busy=false;this.lastTick=0;this.saving=Promise.resolve();this.lastSummary='未確認';
  }
  enabled(){return this.controller.schedule.enabled && process.env.WATCH_ENABLED!=='false';}
  status(){return `取り逃し監視：${this.enabled()?'ON':'OFF'}（${Math.round(this.interval/60)}分ごと／${Object.keys(this.state.seasons).length}作品・シーズン）\n監視状況：${this.lastSummary}`;}
  async save(){
    const body=JSON.stringify(this.state,null,2)+'\n';
    const path=join(this.stateDirectory,'deadline-watch.json');
    this.saving=this.saving.catch(()=>{}).then(async()=>{await writeFile(path+'.tmp',body);await rename(path+'.tmp',path);});
    await this.saving;
  }
  add(item){
    if(!valid(item.id,'ep') || !valid(item.seriesId,'sr') || !valid(item.seasonId,'ss'))return;
    const now=this.now();
    const season=this.state.seasons[item.seasonId] ||= {id:item.seasonId,seriesId:item.seriesId,title:String(item.title || item.seriesId).slice(0,160),firstSeen:now};
    const previous=this.state.episodes[item.id] || {id:item.id,firstSeen:now,attempts:0,nextRetryAt:0};
    const wasUnavailable=previous.status==='expired' || previous.available===false || (!this.state.episodes[item.id] && item.number && Object.values(this.state.episodes).some(x=>x.seasonId===item.seasonId && x.seriesId===item.seriesId && x.number===item.number && (x.status==='expired' || x.available===false)));
    const record={...previous,...item,title:season.title,seasonFirstSeen:season.firstSeen};
    if(item.available===true && (!item.endAt || item.endAt>now) && wasUnavailable){Object.assign(record,{relistedAt:now,relistedPending:true,status:'pending',nextRetryAt:0});}
    this.state.episodes[item.id]=record;
  }
  async track(plan){for(const group of plan.groups)for(const item of group.episodes)this.add(item);await this.save();}
  async init(){
    await mkdir(this.stateDirectory,{recursive:true});
    try{
      const data=JSON.parse(await readFile(join(this.stateDirectory,'deadline-watch.json'),'utf8'));
      if(data.version!==1 || !data.seasons || !data.episodes || !data.alerts || Array.isArray(data.episodes))throw new Error('Invalid deadline-watch state');
      this.state=data;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    let files=[];
    try{files=await readdir(this.directory);}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const name of files){
      if(!name.endsWith('.info.json'))continue;
      try{
        const item=JSON.parse(await readFile(join(this.directory,name),'utf8'));
        const id=valid(item.id,'ep')?item.id:String(item.webpage_url || item.original_url || '').match(/\/episodes\/(ep[a-z0-9]+)/)?.[1];
        this.add({id,seriesId:item.series_id,seasonId:item.season_id,title:item.series || item.title,number:episodeNumber(item.episode_number)});
      }catch{}
    }
    await this.save();
  }
  async alert(key,message,ttl=86400){
    const now=this.now();
    if(this.state.alerts[key] && now-this.state.alerts[key]<ttl)return;
    try{if(await this.report(message)!==false)this.state.alerts[key]=now;}
    catch{console.error('Could not send deadline warning; will retry.');}
  }
  isSaved(item,saved){
    return saved.some(x=>x.id===item.id || item.number && x.seriesId===item.seriesId && x.seasonId===item.seasonId && x.number===item.number);
  }
  async tick({force=false}={}){
    const now=this.now();
    if(!this.enabled() || this.busy || !force && now-this.lastTick<this.interval)return null;
    this.busy=true;this.lastTick=now;
    try{
      this.lastSummary='配信一覧と期限を確認中';
      const saved=await this.scan(this.directory,{includeIds:true});
      const catalog=this.catalogFactory();
      // Keep watching a work after it drops out of the ranking, and discover newly ranked works.
      try{for(const target of await this.ranking())this.add(await catalog.episode(new URL(target).pathname.split('/').at(-1)));}
      catch{await this.alert('ranking-error','⚠ 終了前監視：ランキングを取得できません。登録済み作品の確認は続けます。',3600);}
      if(catalog.seriesSeasons){
        const representatives=[...new Map(Object.values(this.state.seasons).map(x=>[x.seriesId,x])).values()];
        for(const representative of representatives.slice(0,100)){
          try{
            const seasons=await catalog.seriesSeasons(representative.seriesId);
            for(const season of seasons){
              if(!this.state.seasons[season.id] && !mainSeasonLabel(season.title))continue;
              this.state.seasons[season.id] ||= {id:season.id,seriesId:representative.seriesId,title:representative.title,seasonLabel:season.title,firstSeen:now};
            }
          }catch{await this.alert(`series:${representative.seriesId}`,`⚠ ${representative.title}：シーズン一覧の取得に失敗しました。既存のシーズンは引き続き確認します。`,3600);}
        }
      }
      const seasons=Object.values(this.state.seasons);
      if(seasons.length>100)await this.alert('season-limit','⚠ 監視作品が100シーズンを超えています。今回確認できない作品があります。',3600);
      for(const season of seasons.slice(0,100)){
        let ids;
        try{ids=await catalog.season(season.id);}
        catch{await this.alert(`catalog:${season.id}`,`⚠ ${season.title}：配信一覧の取得に失敗しました。配信終了とは判定せず、次回確認します。`,3600);ids=[];}
        const known=Object.values(this.state.episodes).filter(x=>x.seasonId===season.id && !this.isSaved(x,saved));
        const targets=[...new Set([...ids,...known.map(x=>x.id)])];
        if(targets.length>200)await this.alert(`limit:${season.id}`,`⚠ ${season.title}：一覧が200件を超え、一部の期限を確認できません。`,3600);
        for(const id of targets.slice(0,200)){
          const old=this.state.episodes[id];
          if(old && this.isSaved(old,saved)){old.status='saved';continue;}
          try{this.add({...await catalog.episode(id),lastSeen:this.now()});}
          catch{if(old)old.lastCheckError=true;await this.alert(`detail:${id}`,`⚠ ${season.title}：話の詳細を取得できません。保存・期限を再確認します。 https://tver.jp/episodes/${id}`,3600);}
        }
      }
      const pending=[];
      for(const item of Object.values(this.state.episodes)){
        if(this.isSaved(item,saved)){item.status='saved';item.relistedPending=false;continue;}
        if(item.relistedPending){
          const key=`relisted:${item.id}:${item.relistedAt}`;
          await this.alert(key,`再掲載・視聴可能を確認：${label(item)}。未保存のため自動保存の対象に加えました。\n${url(item)}`);
          if(this.state.alerts[key])item.relistedPending=false;
        }
        if(item.endAt && item.endAt<=now){
          item.status='expired';
          await this.alert(`expired:${item.id}`,`⚠ 未保存のまま配信期限を過ぎました：${label(item)}（期限 ${time(item.endAt)}）\n${url(item)}`);
          continue;
        }
        if(item.endAt && item.endAt-now<=86400){
          const urgent=item.endAt-now<=this.urgentSeconds;
          await this.alert(`${urgent?'urgent':'soon'}:${item.id}`,`⚠ ${urgent?'まもなく配信終了':'24時間以内に配信終了'}・未保存：${label(item)}\n期限：${time(item.endAt)}（日本時間）\n${url(item)}`);
        }else if(!item.endAt){await this.alert(`unknown-deadline:${item.seasonId}`,`⚠ ${item.title}：一部の配信期限を取得できません。期限不明の話も未保存なら確認・保存を試みます。`);}
        if(!item.number || item.available!==true)continue;
        const urgent=item.endAt && item.endAt-now<=this.urgentSeconds;
        if((item.nextRetryAt || 0)<=now || urgent && now-(item.lastAttemptAt || 0)>=this.interval)pending.push(item);
      }
      const candidates=prioritizeEpisodes(pending,now,this.urgentSeconds);
      this.state.lastScan=now;
      this.lastSummary=`最終確認 ${time(now)}／保存待ち ${candidates.length}話`;
      await this.save();
      let externalLock=false;
      try{await access(join(this.stateDirectory,'download.lock'));externalLock=true;}catch{}
      if(!candidates.length || this.controller.active || externalLock || !this.enabled())return {pending:candidates.length};
      const selected=candidates.slice(0,this.batchSize);
      const groups=[...new Set(selected.map(x=>x.seasonId))].map(id=>{
        const season=this.state.seasons[id];
        const episodes=Object.values(this.state.episodes).filter(x=>x.seasonId===id && x.number);
        return {...season,seasonId:id,through:Math.max(...episodes.map(x=>x.number)),episodes};
      });
      const plan={urls:selected.map(url),groups,warnings:[]};
      await this.controller.start(null,{plan,monitor:true});
      const results=this.controller.lastResults || [];
      const confirmed=await this.scan(this.directory,{includeIds:true});
      let successful=0;
      for(const item of selected){
        const result=results.find(x=>x.url===url(item));
        if(!result || result.skipped)continue;
        item.lastAttemptAt=this.now();
        if(this.isSaved(item,confirmed)){
          successful++;Object.assign(item,{status:'saved',attempts:0,nextRetryAt:0,lastError:null});
        }else{
          item.attempts=(item.attempts || 0)+1;
          item.nextRetryAt=this.now()+retryDelay(item.attempts,this.interval);
          item.status='retry';item.lastError=result.reason || 'saved_file_not_confirmed';
          await this.alert(`failed:${item.id}`,`⚠ 配信中ですが保存失敗：${label(item)}。${Math.round(retryDelay(item.attempts,this.interval)/60)}分後に再試行します。\n${url(item)}`,3600);
        }
      }
      this.lastSummary=`最終確認 ${time(now)}／今回 ${successful}話の保存を確認`;
      await this.save();
      if(successful)await this.report(`終了前監視：${successful}話の保存を確認しました。残りの未保存話は引き続き確認します。`);
      return {pending:candidates.length,saved:successful};
    }catch{
      this.lastSummary='確認に失敗しました。次回再試行します。';
      await this.alert('watch-error','⚠ 終了前監視の処理に失敗しました。PCのログを確認してください。次回も確認します。',3600);
      return {error:true};
    }finally{this.busy=false;}
  }
}
