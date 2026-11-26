import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CANCELLED, downloadEpisodes, killTree, runProcess} from './download.mjs';
import {DownloadController} from './bot-control.mjs';

test('runProcess kills the downloader when cancelled',async()=>{
  const aborter=new AbortController();
  const started=Date.now();
  const running=runProcess(process.execPath,['-e','setTimeout(()=>{},60000)'],{signal:aborter.signal});
  setTimeout(()=>aborter.abort(),200);
  await assert.rejects(running,error=>error.code===CANCELLED);
  assert.ok(Date.now()-started<10000);
  await assert.rejects(runProcess(process.execPath,['-e','1'],{signal:aborter.signal}),error=>error.code===CANCELLED);
});

test('on Windows the whole yt-dlp/ffmpeg process tree is stopped',()=>{
  const calls=[];
  killTree({pid:1234,kill:()=>calls.push('kill')},'win32',(command,args)=>{calls.push([command,...args]);return {once(){}};});
  assert.deepEqual(calls,[['taskkill','/pid','1234','/T','/F']]);
});

test('cancelling skips the remaining episodes, records nothing as saved and releases the lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-cancel-'));
  try {
    const aborter=new AbortController();
    const ran=[];
    const run=async(command,args,{signal})=>{
      ran.push(args.at(-1));
      aborter.abort();
      assert.equal(signal.aborted,true);
      throw Object.assign(new Error('stopped'),{code:CANCELLED});
    };
    const urls=['https://tver.jp/episodes/epa','https://tver.jp/episodes/epb','https://tver.jp/episodes/epc'];
    const results=await downloadEpisodes(urls,{directory:join(dir,'v'),stateDirectory:join(dir,'s'),run,signal:aborter.signal,scan:async()=>[]});
    assert.deepEqual(ran,['https://tver.jp/episodes/epa']);
    assert.equal(results.cancelled,true);
    assert.deepEqual(results.map(x=>[x.ok,x.skipped,x.reason]),[[false,true,'cancelled'],[false,true,'cancelled'],[false,true,'cancelled']]);
    assert.match(results.warnings[0],/中止しました/);
    await assert.rejects(stat(join(dir,'s','download.lock')),{code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('controller cancel aborts the job and reports a cancelled summary',async()=>{
  let signal;
  let release;
  const control=new DownloadController({directDownload:(urls,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});}});
  assert.equal(control.cancel(),false);
  const job=control.start(null,{selected:['https://tver.jp/episodes/epa','https://tver.jp/episodes/epb']});
  assert.equal(control.cancel(),true);
  assert.equal(signal.aborted,true);
  assert.match(control.status(),/中止しています/);
  assert.equal(control.cancel(),false,'second click is a no-op');
  const results=[{url:'a',ok:true},{url:'b',ok:false,skipped:true,reason:'cancelled'}];results.cancelled=true;
  release(results);
  assert.match(await job,/中止しました：保存成功または保存済み 1件、失敗 0件、未保存 1件/);
  assert.equal(control.active,false);
});

test('cancelling during the catalog step ends quietly',async()=>{
  const control=new DownloadController({download:(urls,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('x'),{code:CANCELLED})))),ranking:async()=>['https://tver.jp/episodes/epa']});
  const job=control.start(null);
  await new Promise(r=>setTimeout(r,10));
  control.cancel();
  assert.match(await job,/中止しました/);
});
