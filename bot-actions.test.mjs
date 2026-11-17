import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractionHandler, statusPanel} from './bot-actions.mjs';

function setup() {
  const starts=[];
  const controller={active:false,schedule:{enabled:true},status:()=> '待機中',setAutomatic:async enabled=>{controller.schedule.enabled=enabled;},start:url=>{
    starts.push(url);controller.active=true;return new Promise(()=>{});
  }};
  const handler=createInteractionHandler({controller,guildId:'1',userIds:new Set(['2']),completion:async()=>{},report:async()=>{}});
  return {controller,starts,handler};
}
function interaction({button=false,id='tver:download-now',command='status',guildId='1',userId='2'}={}) {
  const calls=[];
  const event={guildId,user:{id:userId},commandName:command,customId:id,calls,
    isButton:()=>button,isChatInputCommand:()=>!button,
    reply:async body=>{event.replied=true;calls.push({method:'reply',body});},
    deferUpdate:async()=>{event.deferred=true;calls.push({method:'deferUpdate'});},
    deferReply:async body=>{event.deferred=true;calls.push({method:'deferReply',body});},
    editReply:async body=>calls.push({method:'editReply',body})};
  return event;
}

test('/status presents actions without starting downloads',async()=>{
  const {controller,starts,handler}=setup();
  const event=interaction();await handler(event);
  assert.equal(starts.length,0);
  const payload=event.calls[0].body;
  assert.equal(payload.flags,undefined);
  assert.deepEqual(payload.components.flatMap(x=>x.components.map(b=>b.custom_id)),['tver:download-now','tver:refresh','tver:auto:on','tver:auto:off','tver:uploads:open']);
  assert.equal(payload.components[1].components[0].disabled,true);
  controller.active=true;
  assert.equal(statusPanel(controller).components[0].components[0].disabled,true);
});

test('click starts once and stale repeated clicks cannot start another job',async()=>{
  const {starts,handler}=setup();
  const first=interaction({button:true});await handler(first);
  assert.deepEqual(starts,[null]);
  assert.equal(first.calls[0].method,'deferUpdate');
  assert.match(first.calls.at(-1).body.content,/今すぐ保存を開始/);
  const again=interaction({button:true});await handler(again);
  assert.equal(starts.length,1);
  assert.match(again.calls.at(-1).body.content,/実行中/);
});

test('buttons enforce both user and guild authorization',async()=>{
  const {starts,handler}=setup();
  for(const settings of [{userId:'3'},{guildId:'3'}]){
    const event=interaction({button:true,...settings});await handler(event);
    assert.equal(event.calls[0].method,'reply');
    assert.match(event.calls[0].body.content,/権限がありません/);
  }
  assert.equal(starts.length,0);
});

test('automatic buttons set explicit state and refresh does not start a job',async()=>{
  const {controller,starts,handler}=setup();
  await handler(interaction({button:true,id:'tver:auto:off'}));
  assert.equal(controller.schedule.enabled,false);
  await handler(interaction({button:true,id:'tver:auto:on'}));
  assert.equal(controller.schedule.enabled,true);
  await handler(interaction({button:true,id:'tver:refresh'}));
  assert.equal(starts.length,0);
});

test('rechecks busy state after acknowledgement to avoid a timer/click race',async()=>{
  const {controller,starts,handler}=setup();
  const event=interaction({button:true});
  event.deferUpdate=async()=>{event.deferred=true;controller.active=true;};
  await handler(event);
  assert.equal(starts.length,0);
  assert.match(event.calls.at(-1).body.content,/実行中/);
});
