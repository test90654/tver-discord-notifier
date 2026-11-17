import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const clean = value => {const text=String(value || '').trim();return text && text!=='NA' && text!=='N/A'?text.slice(0,40):null;};
export function parseProgress(line,duration=null) {
  line=String(line).replace(/\u001b\[[0-9;]*m/g,'').trim();
  if(line.startsWith('TV_PROGRESS|')){
    const [,status,percent,speed,eta]=line.split('|');
    const match=percent?.match(/([\d.]+)%/);
    return {stage:'transfer',percent:match?Math.min(100,Math.max(0,Number(match[1]))):null,speed:clean(speed),eta:clean(eta),streamFinished:status==='finished'};
  }
  if(line.startsWith('[Merger]'))return {stage:'merge'};
  const match=line.match(/\btime=(\d+):(\d+):([\d.]+)/);
  if(match){
    const elapsed=Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
    const speed=Number(line.match(/\bspeed=\s*([\d.]+)x/)?.[1]);
    const remaining=duration>elapsed && speed>0?Math.ceil((duration-elapsed)/speed):null;
    return {stage:'transfer',percent:duration>0?Math.min(100,100*elapsed/duration):null,speed:speed>0?`${speed}x`:null,eta:remaining!==null?`${remaining}秒`:null,elapsed:match[0].slice(5)};
  }
  return null;
}

export function localDuration(directory,url){
  try{
    const id=new URL(url).pathname.split('/').at(-1);
    for(const name of readdirSync(directory)){
      if(!name.endsWith('.info.json'))continue;
      const data=JSON.parse(readFileSync(join(directory,name),'utf8'));
      if((data.id===id || data.webpage_url===url || data.original_url===url) && Number(data.duration)>0)return Number(data.duration);
    }
  }catch { /* Progress without a known duration must not invent a percentage. */ }
  return null;
}

export function formatProgress(event){
  if(event.stage==='catalog')return `過去話一覧を確認中${event.title?`：${event.title}`:''}${event.groupTotal?`（${event.groupIndex}/${event.groupTotal}作品）`:''}`;
  if(event.stage==='verify')return '保存結果と不足話数を確認中';
  const name=event.title?`${event.title}${event.number?` 第${event.number}話`:''}`:event.url || '';
  const completed=event.completed || 0;
  const filled=event.total?Math.min(10,Math.floor(completed/event.total*10)):0;
  const bar='█'.repeat(filled)+'░'.repeat(10-filled);
  const lines=[`保存処理：${event.index}/${event.total}件目`,name,`${bar} 処理済み ${completed}/${event.total}件（成功・保存済み ${event.ok || 0}／失敗 ${event.failed || 0}）`];
  if(event.stage==='transfer'){
    lines.push(`現在の動画・音声ストリーム：${Number.isFinite(event.percent)?`${event.percent.toFixed(1)}%`:'取得中'}`);
    if(event.speed)lines.push(`速度：${event.speed}`);
    if(event.eta)lines.push(`このストリームの残り目安：${event.eta}`);
    else if(event.elapsed)lines.push(`取得済み再生時間：${event.elapsed}`);
  }else if(event.stage==='merge')lines.push('動画と音声を結合中');
  else if(event.stage==='episodeDone')lines.push('この話の処理が完了しました');
  else lines.push('再生情報の取得・保存準備中');
  return lines.filter(Boolean).join('\n');
}
