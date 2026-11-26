import test from 'node:test';
import assert from 'node:assert/strict';
import {optionFor, pickerComponents, selectedUrls, rankingPicker, seasonPicker, MAX_OPTIONS} from './picker.mjs';

test('ranking list shows titles as checkable multi-select options',async()=>{
  const ranking=async()=>Array.from({length:10},(_,i)=>({id:`ep${i}`,rank:i+1,seriesTitle:`ドラマ${i}`,title:`第${i+1}話 サブタイトル`}));
  const picker=await rankingPicker({ranking});
  assert.equal(picker.components.length,1);
  const menu=picker.components[0].components[0];
  assert.equal(menu.type,3);
  assert.equal(menu.min_values,1);
  assert.equal(menu.max_values,10);
  assert.deepEqual(menu.options[0],{label:'1位 ドラマ0',value:'ep0',description:'第1話 サブタイトル'});
  assert.deepEqual(Object.keys(picker).sort(),['components','content']);
});

test('long seasons are split into menus of 25 and capped at 5 menus; labels fit Discord limits',()=>{
  const entries=Array.from({length:130},(_,i)=>({id:`ep${i}`,seriesTitle:'あ'.repeat(200),title:'い'.repeat(200)}));
  const {components,omitted}=pickerComponents(entries);
  assert.equal(components.length,5);
  assert.equal(omitted,5);
  assert.ok(components.every(row=>row.components[0].options.length<=MAX_OPTIONS));
  assert.equal(new Set(components.map(row=>row.components[0].custom_id)).size,5);
  const option=optionFor(entries[0]);
  assert.ok(option.label.length<=100 && option.description.length<=100);
});

test('season list pre-checks the shared episode only',async()=>{
  const catalog={
    episode:async id=>({id,seasonId:'ssone',title:'作品名'}),
    seasonContents:async()=>[{id:'epa',seriesTitle:'作品名',title:'第1話'},{id:'epzf0th88w',seriesTitle:'作品名',title:'第2話'}]
  };
  const picker=await seasonPicker('https://tver.jp/episodes/epzf0th88w?utm_medium=share',{catalog});
  const options=picker.components[0].components[0].options;
  assert.deepEqual(options.filter(x=>x.default).map(x=>x.value),['epzf0th88w']);
  assert.equal(options.length,2);
});

test('selected values must be TVer episode IDs',()=>{
  assert.deepEqual(selectedUrls(['epa','epa','epb']),['https://tver.jp/episodes/epa','https://tver.jp/episodes/epb']);
  for (const bad of ['../x','ep a','--exec','srabc']) assert.throws(()=>selectedUrls([bad]));
});

test('old-drama list keeps only archive dramas that started streaming recently, grouped by work',async()=>{
  const now=new Date('2026-11-27T00:00:00Z');const t=now.getTime()/1000;
  const ep=(id,series,title,start,extra={})=>({type:'episode',startAt:start,content:{id,seriesID:series,seriesTitle:`作品${series}`,title,broadcastDateLabel:'2014年放送',isAvailable:true,endAt:t+86400*7,...extra}});
  const rows=[
    ep('epa2','sra','第2話',t-3600),
    ep('epa1','sra','第1話',t-7200),
    ep('epb1','srb','第1話',t-60),
    ep('epold','src','第1話',t-86400*10),                 // started too long ago
    ep('epnew','srd','第1話',t-60,{broadcastDateLabel:'11月26日(水)放送分'}), // current drama
    ep('epend','sre','第1話',t-60,{endAt:t-1}),            // already expired
    ep('epfut','srf','第1話',t+600),                       // not started yet
    ep('epna','srg','第1話',t-60,{isAvailable:false}),
    {type:'series',content:{id:'srx'}}
  ];
  const entries=(await import('./picker.mjs')).oldDramaEntries(rows,{now,days:7});
  assert.deepEqual(entries.map(x=>x.id),['epb1','epa1','epa2']);
  assert.equal(entries[1].seriesTitle,'作品sra（2014年）');
  assert.match(entries[1].date,/まで$/);
});

test('old-drama picker reports counts and builds a checklist',async()=>{
  const now=new Date('2026-11-27T00:00:00Z');const t=now.getTime()/1000;
  const catalog={newer:async category=>{assert.equal(category,'drama');return [{type:'episode',startAt:t-60,content:{id:'epa1',seriesID:'sra',seriesTitle:'昔のドラマ',title:'第1話',broadcastDateLabel:'2009年放送',isAvailable:true,endAt:t+86400}}];}};
  const picker=await (await import('./picker.mjs')).oldDramaPicker({catalog,now,days:3});
  assert.match(picker.content,/直近3日・1作品1話/);
  assert.equal(picker.components[0].components[0].options[0].label,'昔のドラマ（2009年）');
  const empty=await (await import('./picker.mjs')).oldDramaPicker({catalog:{newer:async()=>[]},now});
  assert.equal(empty.components.length,0);
});
