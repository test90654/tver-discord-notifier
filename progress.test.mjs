import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseProgress,formatProgress} from './progress.mjs';
import {LivePanel} from './live-panel.mjs';
import {planPastEpisodes} from './past-episodes.mjs';
import {downloadEpisodes,runProcess} from './download.mjs';

test('each work starts at episode 1 even when the ranking starts at episode 3',async()=>{
  const episodes={epthree:{number:3,seriesId:'srone',seasonId:'ssone'},epone:{number:1,seriesId:'srone',seasonId:'ssone'},eptwo:{number:2,seriesId:'srone',seasonId:'ssone'},epother:{number:2,seriesId:'srtwo',seasonId:'sstwo'},epfirst:{number:1,seriesId:'srtwo',seasonId:'sstwo'}};
  const catalog={episode:async id=>({id,...episodes[id],title:'作品',available:true}),season:async id=>id==='ssone'?['epthree','epone','eptwo']:['epother','epfirst']};
  const plan=await planPastEpisodes(['https://tver.jp/episodes/epthree','https://tver.jp/episodes/epother'],{catalog});
  assert.deepEqual(plan.urls.map(x=>x.split('/').at(-1)),['epone','eptwo','epthree','epfirst','epother']);
});

test('yt-dlp progress and ffmpeg elapsed/speed have honest per-stream percentages',()=>{
  const native=parseProgress('TV_PROGRESS|downloading| 12.5%| 4.2MiB/s|00:20');
  assert.equal(native.percent,12.5);
  assert.equal(native.eta,'00:20');
  const external=parseProgress('frame=1200 time=00:10:00.00 bitrate=1kbits/s speed=20x',1200);
  assert.equal(external.percent,50);
  assert.equal(external.eta,'30秒');
  assert.equal(parseProgress('frame=12 time=00:10:00.00 speed=20x').percent,null);
  assert.equal(parseProgress('[Merger] Merging formats').stage,'merge');
  assert.equal(parseProgress('Other log line'),null);
  assert.match(formatProgress({index:2,total:5,completed:1,title:'作品',number:2,...native}),/作品 第2話/);
  assert.match(formatProgress({index:2,total:5,completed:1,...native}),/現在の動画・音声ストリーム：12.5%/);
});

test('live panel edits only changed states and does not overlap requests',async()=>{
  let value='idle',finish;
  const calls=[];
  const live=new LivePanel({render:()=>({content:value}),update:payload=>{calls.push(payload);return new Promise(resolve=>{finish=resolve;});}});
  const pending=live.refresh();
  await live.refresh();
  assert.equal(calls.length,1);
  finish();await pending;
  await live.refresh();assert.equal(calls.length,1);
  value='progress';const changed=live.refresh();
  assert.equal(calls.length,2);finish();await changed;
});

test('download forwards per-stream progress and counters, and stdout chunks are parsed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-progress-'));
  try{
    const events=[];
    await downloadEpisodes(['https://tver.jp/episodes/epone'],{directory:join(dir,'videos'),stateDirectory:join(dir,'state'),onProgress:event=>events.push(event),run:async(command,args,options)=>{options.onLine('TV_PROGRESS|downloading|33.0%|2MiB/s|00:03');}});
    assert.equal(events.find(x=>x.stage==='transfer').percent,33);
    assert.equal(events.at(-1).completed,1);
    assert.equal(events.at(-1).ok,1);
    const lines=[];
    await runProcess(process.execPath,['-e','process.stdout.write("TV_PRO");setTimeout(()=>process.stdout.write("GRESS|downloading|50%|1MiB/s|00:01\\n"),5)'],{onLine:line=>lines.push(line)});
    assert.equal(parseProgress(lines[0]).percent,50);
  }finally{await rm(dir,{recursive:true,force:true});}
});
