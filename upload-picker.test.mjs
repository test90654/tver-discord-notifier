import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UploadPicker} from './upload-picker.mjs';
import {listUploadCandidates,setExternalCopies,readExternalCopies} from './external-copies.mjs';

const episode=n=>({id:`ep${n}`,seriesId:'srone',seasonId:'ssone',number:n,title:'作品',episodeTitle:`第${n}話 本編`});
const group=count=>({title:'作品',key:'srone/ssone',episodes:Array.from({length:count},(_,i)=>episode(i+1))});
function event(customId='',values=[],userId='1'){
  const replies=[];
  return {customId,values,user:{id:userId},guildId:'2',replies,deferReply:async()=>{},deferUpdate:async()=>{},reply:async payload=>replies.push(payload),editReply:async payload=>replies.push(payload)};
}
async function open(picker){const first=event();await picker.open(first);return [...picker.sessions.values()].at(-1);}
async function click(picker,session,action,values=[]){const current=event(picker.id(session,action),values);await picker.handle(current);return current;}

test('URL-free multi-select registers only after explicit confirmation',async()=>{
  const writes=[];
  const picker=new UploadPicker({stateDirectory:'unused',list:async()=>[group(3)],save:async data=>writes.push(data)});
  const session=await open(picker);
  await click(picker,session,'work',['g0']);
  await click(picker,session,'episodes',['e0','e2']);
  assert.equal(writes.length,0);
  const confirmation=await click(picker,session,'confirm');
  assert.match(confirmation.replies.at(-1).content,/第1話・第3話/);
  assert.equal(writes.length,0);
  await click(picker,session,'commit');
  assert.deepEqual(writes[0].episodes.map(x=>x.number),[1,3]);
  assert.equal(writes[0].youtubeUrl,null);
  assert.equal(picker.sessions.size,0);
});

test('cancel and another user cannot register a selection; expired sessions do not write',async()=>{
  let now=1,writes=0;
  const picker=new UploadPicker({list:async()=>[group(2)],save:async()=>{writes++;},now:()=>now});
  const session=await open(picker);
  const other=event(picker.id(session,'commit'),[],'3');await picker.handle(other);
  assert.equal(writes,0);assert.match(other.replies[0].content,/別の利用者/);
  await click(picker,session,'work',['g0']);await click(picker,session,'all');
  await click(picker,session,'cancel');assert.equal(writes,0);
  const expired=await open(picker);now+=1800001;
  const response=await click(picker,expired,'commit');
  assert.match(response.replies[0].content,/期限切れ/);assert.equal(writes,0);
});

test('selection is retained across episode pages and work pages obey the 25-option limit',async()=>{
  const groups=Array.from({length:26},(_,i)=>({...group(30),title:`作品${i}`}));
  const picker=new UploadPicker({list:async()=>groups,save:async()=>{}});
  const session=await open(picker);
  assert.equal(picker.render(session).components[0].components[0].options.length,25);
  await click(picker,session,'works-next');
  assert.equal(picker.render(session).components[0].components[0].options.length,1);
  await click(picker,session,'work',['g25']);
  await click(picker,session,'episodes',['e0','e24']);
  await click(picker,session,'episodes-next');
  assert.equal(picker.render(session).components[0].components[0].options.length,5);
  await click(picker,session,'episodes',['e29']);
  assert.equal(session.selected.size,3);
  await click(picker,session,'episodes-prev');
  assert.equal(picker.render(session).components[0].components[0].options.filter(x=>x.default).length,2);
});

test('concurrent confirmation cannot write twice',async()=>{
  let writes=0,finish;
  const picker=new UploadPicker({list:async()=>[group(2)],save:async()=>{writes++;await new Promise(resolve=>{finish=resolve;});}});
  const session=await open(picker);
  await click(picker,session,'work',['g0']);await click(picker,session,'all');await click(picker,session,'confirm');
  const first=click(picker,session,'commit');
  const second=click(picker,session,'commit');
  while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(writes,1);finish();await Promise.all([first,second]);
});

test('candidate list excludes missing/partial videos and registered episodes; optional URL persists',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tver-picker-'));
  try{
    const videos=join(dir,'videos');await mkdir(videos);
    for(let n=1;n<=3;n++){
      await writeFile(join(videos,`episode${n}.info.json`),JSON.stringify({id:`ep${n}`,series_id:'srone',season_id:'ssone',episode_number:n,series:'作品',episode:`第${n}話`}));
      await writeFile(join(videos,`episode${n}.${n===2?'mp4.part':'mp4'}`),'video');
    }
    await setExternalCopies({episodes:[episode(3)],declaredBy:'1'},dir);
    const groups=await listUploadCandidates({directory:videos,stateDirectory:dir});
    assert.deepEqual(groups[0].episodes.map(x=>x.number),[1]);
    const stored=await readExternalCopies(dir);
    assert.equal(stored[0].youtubeUrl,null);
    await assert.rejects(setExternalCopies({episodes:[episode(1),{id:'bad'}]},dir));
    assert.equal((await readExternalCopies(dir)).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
