import test from 'node:test';
import assert from 'node:assert/strict';
import {detectOldDramas} from './old-dramas.mjs';

const now = new Date('2026-10-28T12:00:00Z');
const state = {version:1,observedAt:'2026-10-27T12:00:00Z',seenSeries:['srknown']};
const episode = (seriesID, id, label='2014年放送', startAt=now.getTime()/1000-3600) => ({type:'episode',startAt,content:{seriesID,id,seriesTitle:seriesID,broadcastDateLabel:label,isAvailable:true,endAt:now.getTime()/1000+86400}});

test('groups newly available episodes by work and ignores extra episodes of a known work',()=>{
  const result = detectOldDramas(state,[],[episode('srnew','epone'),episode('srnew','eptwo'),episode('srknown','epthree')],now);
  assert.equal(result.additions.length,1);
  assert.equal(result.additions[0].episodeCount,2);
  assert.deepEqual(result.nextState.seenSeries,['srknown','srnew']);
  assert.deepEqual(state.seenSeries,['srknown']);
  assert.equal(detectOldDramas(result.nextState,[],[episode('srnew','epfour')],new Date(now.getTime()+86400000)).additions.length,0);
});
test('excludes current date labels, old feed entries, future releases, previews and expired episodes',()=>{
  const items=[episode('srcurrent','epone','10月28日(水)放送分'),episode('srstale','eptwo','2014年放送',now.getTime()/1000-172800),episode('srfuture','epthree','2014年放送',now.getTime()/1000+3600),episode('srpreview','epfour',''),episode('srexpired','epfive')];
  items[4].content.endAt=now.getTime()/1000-1;
  assert.equal(detectOldDramas(state,[],items,now).additions.length,0);
});
test('remembers catalog works even when outside the limited newer feed',()=>{
  const first=detectOldDramas(state,[episode('srarchive','epone')],[],now);
  assert.equal(first.additions.length,0);
  assert.equal(detectOldDramas(first.nextState,[],[episode('srarchive','eptwo')],now).additions.length,0);
});
test('rejects missing or corrupt history rather than notifying all existing works',()=>{
  assert.throws(()=>detectOldDramas(undefined,[],[],now));
  assert.throws(()=>detectOldDramas({...state,observedAt:'invalid'},[],[],now));
});
