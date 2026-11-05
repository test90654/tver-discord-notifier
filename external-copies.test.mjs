import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {youtubeVideoUrl,setExternalCopy,readExternalCopies,matchesExternalCopy,resolveUploadEpisode} from './external-copies.mjs';
import {downloadEpisodes} from './download.mjs';
import {DeadlineWatcher} from './deadline-watch.mjs';

const episode={id:'epone',seriesId:'srone',seasonId:'ssone',number:1,title:'作品'};
test('YouTube URLs accept video links only and remove tracking',()=>{
  assert.equal(youtubeVideoUrl('https://youtu.be/Abcde123_-Z?si=tracking'),'https://www.youtube.com/watch?v=Abcde123_-Z');
  for(const value of ['https://evil.com/watch?v=Abcde123_-Z','http://youtube.com/watch?v=Abcde123_-Z','https://youtube.com/playlist?list=x','https://youtube.com/watch?v=bad'])assert.throws(()=>youtubeVideoUrl(value));
});
test('register persists across reads; changed IDs match by season and number; undo restores eligibility',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-external-'));
  try{
    await setExternalCopy({episode,youtubeUrl:'https://youtu.be/Abcde123_-Z',declaredBy:'1'},dir);
    const copies=await readExternalCopies(dir);
    assert.equal(copies[0].verification,'user-declared');
    assert.equal(matchesExternalCopy(copies,{...episode,id:'epnew'}),true);
    assert.equal(matchesExternalCopy(copies,{...episode,id:'epnew',seasonId:'sstwo'}),false);
    assert.equal((await resolveUploadEpisode('https://tver.jp/episodes/epone',{stateDirectory:dir})).number,1);
    await setExternalCopy({episode,remove:true},dir);
    assert.deepEqual(await readExternalCopies(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('deleted local video does not redownload or warn missing after external registration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-no-redownload-'));
  try{
    await setExternalCopy({episode,youtubeUrl:'https://youtu.be/Abcde123_-Z',declaredBy:'1'},dir);
    let runs=0;
    const results=await downloadEpisodes(['https://tver.jp/episodes/epone'],{stateDirectory:dir,directory:join(dir,'empty-videos'),run:async()=>{runs++;},plan:{groups:[{...episode,through:1,episodes:[episode]}],warnings:[]},scan:async()=>[]});
    assert.equal(runs,0);assert.equal(results[0].external,true);assert.deepEqual(results.warnings,[]);
    const watcher=new DeadlineWatcher({controller:{stateDirectory:dir,schedule:{enabled:true},active:true},directory:join(dir,'empty-videos'),ranking:async()=>[],catalogFactory:()=>({season:async()=>['epone'],episode:async()=>({...episode,available:true})}),scan:async()=>[]});
    await watcher.init();await watcher.tick();
    assert.equal(watcher.state.episodes.epone.status,'saved');
  }finally{await rm(dir,{recursive:true,force:true});}
});
