import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeadlineWatcher,prioritizeEpisodes,retryDelay,mainSeasonLabel} from './deadline-watch.mjs';
import {downloadArgs} from './download.mjs';
import {missingWarnings} from './past-episodes.mjs';

const episode=(id,number,extra={})=>({id,number,seriesId:'srone',seasonId:'ssone',title:'作品',available:true,...extra});
async function setup({items=[episode('epone',1),episode('eptwo',2)],run,report,availableIds}={}){
  const dir=await mkdtemp(join(tmpdir(),'tver-watch-'));
  let now=1800000000;
  let saved=[];
  const runs=[];const messages=[];
  const controller={stateDirectory:dir,schedule:{enabled:true},active:false,lastResults:[],start:async(_,options)=>{
    runs.push(options.plan);
    if(run){controller.lastResults=await run(options.plan);return;}
    saved.push(...options.plan.urls.map(url=>items.find(x=>url.endsWith(x.id))));
    controller.lastResults=options.plan.urls.map(url=>({url,ok:true}));
  }};
  const catalogFactory=()=>({season:async()=>availableIds || items.map(x=>x.id),episode:async id=>{
    const item=items.find(x=>x.id===id);if(!item)throw new Error('gone');return {...item};
  }});
  const watcher=new DeadlineWatcher({controller,stateDirectory:dir,directory:join(dir,'videos'),catalogFactory,ranking:async()=>items.length?[`https://tver.jp/episodes/${items.at(-1).id}`]:[],scan:async()=>saved,report:report || (async text=>{messages.push(text);return true;}),now:()=>now});
  await watcher.init();
  return {dir,watcher,controller,runs,messages,items,advance:seconds=>{now+=seconds;},setSaved:value=>{saved=value;}};
}

test('normal order is oldest first; only imminent deadlines override episode order',()=>{
  const now=1800000000;
  const items=[episode('epthree',3,{endAt:now+100}),episode('epone',1,{endAt:now+90000}),episode('eptwo',2,{endAt:now+80000})];
  assert.deepEqual(prioritizeEpisodes(items,now).map(x=>x.number),[3,1,2]);
  assert.deepEqual(prioritizeEpisodes(items.map(x=>({...x,endAt:null})),now).map(x=>x.number),[1,2,3]);
});

test('watch survives ranking removal and scans complete season, then skips verified saved episodes',async()=>{
  const s=await setup();
  try{
    await s.watcher.tick();
    assert.deepEqual(s.runs[0].urls.map(x=>x.split('/').at(-1)),['epone','eptwo']);
    s.watcher.ranking=async()=>[];
    s.items.push(episode('epthree',3));
    s.advance(600);await s.watcher.tick();
    assert.deepEqual(s.runs[1].urls,['https://tver.jp/episodes/epthree']);
    assert.equal(Object.keys(s.watcher.state.seasons).length,1);
    const stored=JSON.parse(await readFile(join(s.dir,'deadline-watch.json'),'utf8'));
    assert.ok(stored.episodes.epthree);
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('failed available episodes retry with backoff rather than being treated as expired',async()=>{
  const s=await setup({run:async plan=>plan.urls.map(url=>({url,ok:false,reason:'downloader_failed'}))});
  try{
    await s.watcher.tick();
    assert.equal(s.watcher.state.episodes.epone.status,'retry');
    await s.watcher.tick({force:true});assert.equal(s.runs.length,1);
    s.advance(600);await s.watcher.tick();assert.equal(s.runs.length,2);
    assert.equal(s.watcher.state.episodes.epone.nextRetryAt-s.watcher.now(),1200);
    assert.ok(s.messages.some(x=>x.includes('配信中ですが保存失敗')));
    assert.ok(!s.messages.some(x=>x.includes('期限を過ぎました')));
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('alerts before expiry, deduplicates, and never downloads expired episodes',async()=>{
  const s=await setup({items:[episode('epone',1,{endAt:1800000000+100})],run:async plan=>plan.urls.map(url=>({url,ok:false}))});
  try{
    await s.watcher.tick();
    const count=s.messages.filter(x=>x.includes('まもなく配信終了')).length;
    await s.watcher.tick({force:true});
    assert.equal(s.messages.filter(x=>x.includes('まもなく配信終了')).length,count);
    s.advance(120);await s.watcher.tick({force:true});
    assert.equal(s.runs.length,1);
    assert.equal(s.watcher.state.episodes.epone.status,'expired');
    assert.ok(s.messages.some(x=>x.includes('期限を過ぎました')));
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('busy controller still permits scans and alerts but cannot start concurrent downloads',async()=>{
  const s=await setup({items:[episode('epone',1,{endAt:1800000000+100})]});
  try{
    s.controller.active=true;await s.watcher.tick();
    assert.equal(s.runs.length,0);
    assert.ok(s.messages.some(x=>x.includes('まもなく配信終了')));
    s.controller.active=false;s.advance(600);await s.watcher.tick();
    assert.equal(s.runs.length,0); // now expired
    s.controller.schedule.enabled=false;s.advance(600);await s.watcher.tick();
    assert.equal(s.runs.length,0);
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('known episode remains a candidate when absent from the listing; API failures do not imply expiry',async()=>{
  const s=await setup({availableIds:['epone']});
  try{
    await s.watcher.track({groups:[{episodes:[episode('eptwo',2)]}]});
    s.watcher.ranking=async()=>[];
    await s.watcher.tick();
    assert.ok(s.runs[0].urls.includes('https://tver.jp/episodes/eptwo'));
    assert.ok(!s.messages.some(x=>x.includes('期限を過ぎました')));
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('unknown deadlines are explicit; failed alerts can retry; history alone cannot prove a video exists',async()=>{
  let calls=0;
  const s=await setup({items:[episode('epone',1)],report:async()=>{calls++;return calls!==1;},run:async plan=>plan.urls.map(url=>({url,ok:true}))});
  try{
    await s.watcher.tick();
    assert.equal(s.watcher.state.episodes.epone.status,'retry');
    assert.equal(s.watcher.state.episodes.epone.lastError,'saved_file_not_confirmed');
    assert.equal(s.watcher.state.alerts['unknown-deadline:ssone'],undefined);
    await s.watcher.tick({force:true});
    assert.ok(s.watcher.state.alerts['unknown-deadline:ssone']);
    const args=downloadArgs('https://tver.jp/episodes/epone','videos','archive',{ignoreArchive:true});
    assert.ok(!args.includes('--download-archive'));
    assert.equal(retryDelay(10),3600);
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('local metadata imports watched works, including files whose original download failed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-import-'));
  try{
    const videos=join(dir,'videos');await mkdir(videos);
    await writeFile(join(videos,'failed.info.json'),JSON.stringify({id:'eptwo',season_id:'ssone',series_id:'srone',series:'作品',episode_number:2}));
    const controller={stateDirectory:dir,schedule:{enabled:true}};
    const watch=new DeadlineWatcher({controller,directory:videos});await watch.init();
    assert.equal(watch.state.episodes.eptwo.number,2);
    assert.ok(watch.state.seasons.ssone);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('missing warnings explicitly separate a failed available episode from unlisted episodes',()=>{
  const plan={warnings:[],groups:[{title:'作品',seasonId:'ssone',seriesId:'srone',through:4,episodes:[episode('eptwo',2)]}]};
  const warnings=missingWarnings(plan,[],[{url:'https://tver.jp/episodes/eptwo',ok:false}]);
  assert.ok(warnings.some(x=>x.includes('配信中・取得失敗') && x.includes('第2話')));
  assert.ok(warnings.some(x=>x.includes('配信終了とは限りません')));
});

test('a previously expired episode is saved when it becomes available again',async()=>{
  const s=await setup({items:[episode('eptwo',2,{available:false,endAt:1799999900})]});
  try{
    await s.watcher.tick();assert.equal(s.runs.length,0);
    assert.equal(s.watcher.state.episodes.eptwo.status,'expired');
    Object.assign(s.items[0],{available:true,endAt:1800100000});
    s.advance(600);await s.watcher.tick();
    assert.deepEqual(s.runs[0].urls,['https://tver.jp/episodes/eptwo']);
    assert.ok(s.messages.some(x=>x.includes('再掲載・視聴可能を確認')));
    assert.equal(s.watcher.state.episodes.eptwo.status,'saved');
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('reissued IDs do not redownload saved episode numbers; only the missing part is saved',async()=>{
  const items=[episode('eponenew',1),episode('eptwoold',2,{available:false,endAt:1799999900}),episode('eptwonew',2)];
  const s=await setup({items});
  try{
    await s.watcher.track({groups:[{episodes:[items[1]]}]});
    s.watcher.state.episodes.eptwoold.status='expired';
    s.setSaved([episode('eponeold',1)]);
    await s.watcher.tick();
    assert.deepEqual(s.runs[0].urls,['https://tver.jp/episodes/eptwonew']);
    assert.ok(s.messages.some(x=>x.includes('再掲載・視聴可能を確認')));
    assert.equal(s.watcher.isSaved(episode('epdifferent',1,{seasonId:'sstwo'}),[episode('eponeold',1)]),false);
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('new seasons under a watched series are discovered without requiring a ranking entry',async()=>{
  const s=await setup({items:[episode('epone',1)]});
  try{
    await s.watcher.track({groups:[{episodes:[s.items[0]]}]});
    s.watcher.ranking=async()=>[];
    const original=s.watcher.catalogFactory;
    s.watcher.catalogFactory=()=>({...original(),seriesSeasons:async()=>[{id:'ssone'},{id:'sstwo',title:'シーズン2'}]});
    s.controller.active=true;await s.watcher.tick();
    assert.ok(s.watcher.state.seasons.sstwo);
    assert.equal(s.watcher.state.seasons.sstwo.seriesId,'srone');
  }finally{await rm(s.dir,{recursive:true,force:true});}
});

test('series discovery does not automatically add trailers, commentary or bonus categories',()=>{
  for(const value of ['本編','シーズン2','Season 1','第2シリーズ','2023年放送'])assert.equal(mainSeasonLabel(value),true,value);
  for(const value of ['解説放送版','ダイジェスト・予告','配信限定','見どころ','2023年解説版',''])assert.equal(mainSeasonLabel(value),false,value);
});
