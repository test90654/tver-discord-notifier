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
