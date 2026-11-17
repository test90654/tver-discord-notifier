import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {classifyDownloadError, downloadErrorMessage} from './download-errors.mjs';
import {downloadEpisodes, runProcess} from './download.mjs';
import {diagnose, diagnosticArgs} from './diagnose.mjs';

const refusal = () => Object.assign(new Error('Downloader exited with 1'),{stderrTail:'ERROR: [TVer] epabc: REQUEST_FAILED: 163: この動画の視聴は許可されていません。'});
const urls=Array.from({length:5},(_,i)=>`https://tver.jp/episodes/ep${i}`);

test('163 is a playback denial, not proof of geographic restriction',()=>{
  assert.equal(classifyDownloadError(refusal()),'streaks_163');
  assert.match(downloadErrorMessage('streaks_163'),/原因を断定できません/);
  assert.equal(classifyDownloadError({message:'REQUEST_FAILED: 124: denied'}),'geo_restricted');
  assert.equal(classifyDownloadError({message:'REQUEST_FAILED: 126: denied'}),'api_access_denied');
  assert.equal(classifyDownloadError({code:'ENOENT'}),'not_installed');
  assert.equal(classifyDownloadError(new Error('Other episode error')),'downloader_failed');
});

test('three consecutive permission denials stop the batch and persist unattempted URLs separately',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-denied-'));
  try {
    let attempts=0;
    const result=await downloadEpisodes(urls,{directory:join(dir,'video'),stateDirectory:join(dir,'state'),run:async()=>{attempts++;throw refusal();}});
    assert.equal(attempts,3);
    assert.equal(result.filter(x=>!x.ok && !x.skipped).length,3);
    assert.equal(result.filter(x=>x.skipped).length,2);
    assert.ok(result.every(x=>x.reason==='streaks_163'));
    assert.match(result.warnings.join('\n'),/STREAKS 163/);
    assert.match(result.warnings.join('\n'),/残り2件/);
    const persisted=JSON.parse(await readFile(join(dir,'state','last-result.json'),'utf8'));
    assert.equal(persisted.results.filter(x=>x.skipped).length,2);
    assert.deepEqual(persisted.warnings,result.warnings);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('a successful download resets the consecutive denial counter',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-reset-'));
  try {
    let attempts=0;
    const result=await downloadEpisodes(urls,{directory:join(dir,'video'),stateDirectory:join(dir,'state'),run:async()=>{attempts++;if(attempts!==3)throw refusal();}});
    assert.equal(attempts,5);
    assert.equal(result.filter(x=>x.skipped).length,0);
    assert.equal(result.filter(x=>x.ok).length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('ordinary episode errors do not stop unrelated episodes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-ordinary-'));
  try {
    let attempts=0;
    await downloadEpisodes(urls,{directory:join(dir,'video'),stateDirectory:join(dir,'state'),run:async()=>{attempts++;throw new Error('Video expired');}});
    assert.equal(attempts,5);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('real child stderr is available for classification',async()=>{
  await assert.rejects(runProcess(process.execPath,['-e','console.error("ERROR: REQUEST_FAILED: 163: denied");process.exit(1)']),error=>classifyDownloadError(error)==='streaks_163');
});

test('diagnostic checks version and simulates one episode without downloading or history',async()=>{
  const calls=[];
  const result=await diagnose(urls[0],async(command,args)=>{calls.push(args);if(args.includes('--simulate'))throw refusal();});
  assert.deepEqual(calls[0],['--version']);
  assert.ok(calls[1].includes('--simulate'));
  assert.ok(!calls[1].includes('--download-archive'));
  assert.ok(!calls[1].includes('--write-info-json'));
  assert.deepEqual(result,{ok:false,reason:'streaks_163'});
  assert.throws(()=>diagnosticArgs('https://evil.com/episodes/epabc'));
});
