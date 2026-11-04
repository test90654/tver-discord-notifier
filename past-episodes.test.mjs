import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planPastEpisodes, missingWarnings, savedEpisodes, warningMessages, createCatalog} from './past-episodes.mjs';
import {downloadCollection, postDownloadReport} from './download.mjs';

const url = id => `https://tver.jp/episodes/${id}`;
const episode = (id,number,extra={}) => ({id,number,seriesId:'srone',seasonId:'ssone',title:'テスト作品',available:true,...extra});
const fixture = items => ({episode:async id=>{
  if (!items[id]) throw new Error('Missing episode');
  return items[id];
},season:async()=>Object.keys(items)});

test('adds earlier episodes of same season only; deduplicates overlapping ranking works',async()=>{
  const items={epone:episode('epone',1),eptwo:episode('eptwo',2),epthree:episode('epthree',3),epfour:episode('epfour',4),epother:episode('epother',1,{seasonId:'sstwo'})};
  let calls=0;
  const catalog=fixture(items);
  const season=catalog.season; catalog.season=async()=>{calls++;return season();};
  const plan=await planPastEpisodes([url('epthree'),url('eptwo')],{catalog});
  assert.equal(plan.groups.length,1);
  assert.equal(plan.groups[0].through,3);
  assert.equal(calls,1);
  assert.deepEqual(new Set(plan.urls),new Set([url('epone'),url('eptwo'),url('epthree')]));
});

test('warns exactly which episodes are not saved; expired episodes excluded from download',async()=>{
  const items={epone:episode('epone',1,{available:false}),epthree:episode('epthree',3),epfive:episode('epfive',5)};
  const plan=await planPastEpisodes([url('epfive')],{catalog:fixture(items)});
  assert.ok(!plan.urls.includes(url('epone')));
  const saved=[1,3,5].map(number=>episode('saved',number));
  // Episode 1 already exists locally even though it expired on TVer.
  const warnings=missingWarnings(plan,saved,[{url:url('epfive'),ok:true}]);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/第2話・第4話/);
  assert.ok(!warnings[0].includes('第1話'));
  assert.deepEqual(missingWarnings(plan,[1,2,3,4,5].map(number=>episode('saved',number)),[]),[]);
});

test('unknown number, unavailable catalog and partial metadata errors warn without blocking seed',async()=>{
  const unknown=await planPastEpisodes([url('epunknown')],{catalog:fixture({epunknown:episode('epunknown',null)})});
  assert.deepEqual(unknown.urls,[url('epunknown')]);
  assert.match(unknown.warnings.join('\n'),/話数不明/);
  const failed=await planPastEpisodes([url('epthree')],{catalog:{episode:async()=>episode('epthree',3),season:async()=>{throw new Error('API error');}}});
  assert.match(failed.warnings.join('\n'),/一覧を取得できません/);
  assert.match(missingWarnings(failed,[],[]).join('\n'),/第1話・第2話・第3話/);
  const partial=await planPastEpisodes([url('epthree')],{catalog:{episode:async id=>{if(id==='epone')throw new Error('bad metadata');return episode(id,3);},season:async()=>['epone','epthree']}});
  assert.match(partial.warnings.join('\n'),/話数を確認できません/);
});

test('never silently truncates catalog or total download limits',async()=>{
  const catalog=fixture({epone:episode('epone',1),eptwo:episode('eptwo',2),epthree:episode('epthree',3)});
  const plan=await planPastEpisodes([url('epthree')],{catalog,maxPerSeason:2,maxTotal:2});
  assert.equal(plan.urls.length,2);
  assert.match(plan.warnings.join('\n'),/一覧上限/);
  assert.match(plan.warnings.join('\n'),/保存上限/);
});

test('saved coverage requires metadata AND a nonempty completed video; season isolated',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-saved-'));
  try {
    const metadata={series_id:'srone',season_id:'ssone',episode_number:1};
    for(const name of ['complete','partial','empty','metadata-only']) await writeFile(join(dir,`${name}.info.json`),JSON.stringify(metadata));
    await writeFile(join(dir,'complete.mp4'),'test-video');
    await writeFile(join(dir,'partial.mp4.part'),'partial');
    await writeFile(join(dir,'empty.mp4'),'');
    await writeFile(join(dir,'broken.info.json'),'{');
    assert.deepEqual(await savedEpisodes(dir),[{seriesId:'srone',seasonId:'ssone',number:1}]);
    const plan={warnings:[],groups:[{seriesId:'srone',seasonId:'sstwo',title:'シーズン2',through:1,episodes:[]}]};
    assert.match(missingWarnings(plan,await savedEpisodes(dir),[])[0],/不足/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('collection persists missing episode warnings even when downloader exits successfully',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-collection-'));
  try {
    const plan=await planPastEpisodes([url('epthree')],{catalog:fixture({epthree:episode('epthree',3)})});
    const result=await downloadCollection([url('epthree')],{
      directory:join(dir,'videos'),stateDirectory:join(dir,'state'),
      planner:async()=>plan,run:async()=>{},scan:async()=>[episode('epthree',3)]
    });
    assert.equal(result[0].ok,true);
    assert.match(result.warnings[0],/第1話・第2話/);
    const persisted=JSON.parse(await readFile(join(dir,'state','last-result.json'),'utf8'));
    assert.deepEqual(persisted.warnings,result.warnings);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Discord warnings are split below message limit and mentions disabled',async()=>{
  const warnings=Array.from({length:30},(_,i)=>`作品${i} `+'不足'.repeat(100));
  assert.ok(warningMessages(warnings).every(x=>x.length<=1800));
  const result=[{ok:false}];result.warnings=warnings;
  const posts=[];
  await postDownloadReport(result,'https://discord.com/api/webhooks/1/test',async(url,options)=>{posts.push(JSON.parse(options.body));return {ok:true};});
  assert.ok(posts.length>2);
  assert.ok(posts.every(x=>x.content.length<=1800 && x.allowed_mentions.parse.length===0));
  await assert.rejects(postDownloadReport(result,'https://evil.com/api/webhooks/1/test'));
});

test('catalog uses episode version, static episode number and season listing',async()=>{
  const calls=[];
  const catalog=createCatalog(async(value,options)=>{
    const target=new URL(value);calls.push(target);
    let data;
    if(target.pathname.endsWith('browser/create')) data={result:{platform_uid:'test',platform_token:'test'}};
    else if(target.pathname.includes('/callEpisode/')) data={result:{episode:{content:{id:'epone',version:'9',seriesTitle:'作品',isAvailable:true}}}};
    else if(target.hostname==='statics.tver.jp') data={no:'2',seriesID:'srone',seasonID:'ssone',viewStatus:{endAt:1}};
    else if(target.pathname.includes('/callSeasonEpisodes/')) data={result:{contents:[{type:'episode',content:{id:'epone'}}]}};
    else throw new Error('Unexpected call');
    return {ok:true,json:async()=>data};
  });
  const detail=await catalog.episode('epone');
  assert.equal(detail.number,2);
  assert.equal(detail.available,false);
  await catalog.episode('epone');
  assert.equal(calls.filter(x=>x.hostname==='statics.tver.jp').length,1);
  assert.equal(calls.find(x=>x.hostname==='statics.tver.jp').searchParams.get('v'),'9');
  assert.deepEqual(await catalog.season('ssone'),['epone']);
});
