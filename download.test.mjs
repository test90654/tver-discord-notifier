import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadEpisodes, downloadArgs, episodeUrl, runProcess} from './download.mjs';
import {getRanking} from './ranking.mjs';
import {DownloadController, authorized} from './bot-control.mjs';

test('accepts only TVer episodes and strips tracking; rejects command injection/other hosts',()=>{
  assert.equal(episodeUrl('https://tver.jp/episodes/epabc?utm_source=x'),'https://tver.jp/episodes/epabc');
  for (const value of ['--exec=evil','https://evil.com/episodes/epabc','https://tver.jp.evil.com/episodes/epabc','https://user@tver.jp/episodes/epabc','http://tver.jp/episodes/epabc','https://tver.jp/series/srabc','https://tver.jp/episodes/epabc;calc']) assert.throws(()=>episodeUrl(value));
  const args = downloadArgs('https://tver.jp/episodes/epabc','dir with spaces','archive.txt');
  assert.deepEqual(args.slice(-2),['--','https://tver.jp/episodes/epabc']);
  assert.ok(args.includes('dir with spaces'));
  assert.ok(args.includes('--ignore-config'));
});

test('continues after failed episode, deduplicates input, records result, releases lock',async()=>{
  const dir = await mkdtemp(join(tmpdir(),'tver-download-'));
  try {
    const calls=[];
    const options={directory:join(dir,'videos'),stateDirectory:join(dir,'state'),run:async(command,args)=>{calls.push(args);if(args.at(-1).endsWith('epbad')) throw new Error('failed');}};
    const result = await downloadEpisodes(['https://tver.jp/episodes/epbad','https://tver.jp/episodes/epok','https://tver.jp/episodes/epok'],options);
    assert.deepEqual(result.map(x=>x.ok),[false,true]);
    assert.equal(calls.length,2);
    assert.deepEqual(JSON.parse(await readFile(join(dir,'state','last-result.json'),'utf8')).results,result);
    await assert.rejects(access(join(dir,'state','download.lock')));
    let finish;
    const pending=downloadEpisodes(['https://tver.jp/episodes/eplock'],{...options,run:()=>new Promise(resolve=>{finish=resolve;})});
    while(!finish) await new Promise(resolve=>setTimeout(resolve,5));
    await assert.rejects(downloadEpisodes(['https://tver.jp/episodes/epother'],options),/実行中/);
    finish(); await pending;
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('process runner reports nonzero, missing binary and timeout',async()=>{
  await assert.rejects(runProcess(process.execPath,['-e','process.exit(2)']),/2/);
  await assert.rejects(runProcess('nonexistent-tver-test-binary',[]));
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100}),/timed out/);
});

test('ranking validates and sorts exactly ten unique episode IDs',async()=>{
  const rows=Array.from({length:10},(_,i)=>({type:'episode',rank:i+1,content:{id:`ep${i}`}})).reverse();
  const mock=async url=>({ok:true,json:async()=>({result:String(url).includes('browser/create')?{platform_uid:'a',platform_token:'b'}:{contents:{content:{id:'drama'},contents:rows}}})});
  const urls=await getRanking(mock);
  assert.equal(urls[0],'https://tver.jp/episodes/ep0');
  rows[0].content.id=rows[1].content.id;
  await assert.rejects(getRanking(mock),/Invalid ranking/);
});

test('bot authorizes by guild AND user; schedules once per JST date and persists OFF',async()=>{
  assert.equal(authorized({guildId:'1',user:{id:'2'}},'1',new Set(['2'])),true);
  assert.equal(authorized({guildId:'3',user:{id:'2'}},'1',new Set(['2'])),false);
  assert.equal(authorized({guildId:'1',user:{id:'3'}},'1',new Set(['2'])),false);
  const dir=await mkdtemp(join(tmpdir(),'tver-bot-'));
  let calls=0;
  try {
    const options={stateDirectory:dir,automatic:true,ranking:async()=>['https://tver.jp/episodes/epone'],download:async()=>{calls++;return [{ok:true}];}};
    const control=new DownloadController(options);await control.init();
    assert.equal(await control.tick(new Date('2026-11-04T12:09:00Z')),null);
    assert.match(await control.tick(new Date('2026-11-04T12:10:00Z')),/完了/);
    assert.equal(await control.tick(new Date('2026-11-04T12:11:00Z')),null);
    const restarted=new DownloadController(options);await restarted.init();
    assert.equal(await restarted.tick(new Date('2026-11-04T12:12:00Z')),null);
    await restarted.setAutomatic(false);
    const disabled=new DownloadController(options);await disabled.init();
    assert.equal(await disabled.tick(new Date('2026-11-05T12:10:00Z')),null);
    assert.equal(calls,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('bot rejects concurrent job and releases busy state after failure',async()=>{
  let rejectJob;
  const control=new DownloadController({ranking:()=>new Promise((_,reject)=>{rejectJob=reject;})});
  const pending=control.start();
  await assert.rejects(control.start(),/実行中/);
  rejectJob(new Error('API failed'));
  await assert.rejects(pending,/API failed/);
  assert.equal(control.active,false);
});
