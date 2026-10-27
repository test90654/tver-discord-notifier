import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

for (const mode of ['success','failure','preview']) {
  test(`notification history is transactional: ${mode}`, async () => {
    const dir=await mkdtemp(join(tmpdir(),'tver-notify-test-'));
    try {
      await mkdir(join(dir,'.state'));
      for (const file of ['notify.mjs','old-dramas.mjs']) await copyFile(new URL(file,import.meta.url),join(dir,file));
      const initial={version:1,observedAt:new Date(Date.now()-86400000).toISOString(),seenSeries:['srknown']};
      const stateFile=join(dir,'.state','old-dramas.json');
      await writeFile(stateFile,JSON.stringify(initial));
      const script=`
        const sent=[];
        const now=Math.floor(Date.now()/1000);
        const episode={type:'episode',startAt:now-3600,content:{id:'epnew',seriesID:'srnew',seriesTitle:'旧作テスト',title:'第1話',broadcastDateLabel:'2014年放送',isAvailable:true,endAt:now+86400}};
        globalThis.fetch=async (url,options)=>{
          url=new URL(url);
          let result;
          if(url.hostname==='discord.com') {
            sent.push(JSON.parse(options.body));
            if(${JSON.stringify(mode)}==='failure' && sent.length===2) return {ok:false,status:500};
            return {ok:true,status:200};
          }
          if(url.pathname.endsWith('/browser/create')) result={platform_uid:'test',platform_token:'test'};
          else if(url.pathname.includes('/callEpisodeRankingDetail/')) result={contents:{content:{id:'drama'},contents:Array.from({length:10},(_,i)=>({type:'episode',rank:i+1,content:{id:'ep'+i,seriesTitle:'ランキング'+i,title:'本編'}}))}};
          else if(url.pathname.includes('/callTagSearch/')) result={contents:[episode]};
          else if(url.pathname.includes('/callNewerDetail/')) result={contents:{content:{id:'drama'},contents:[episode]}};
          else throw new Error('Unexpected request');
          return {ok:true,status:200,json:async()=>({result})};
        };
        ${mode==='preview' ? "process.argv.push('--dry-run');" : ''}
        try {await import(${JSON.stringify(pathToFileURL(join(dir,'notify.mjs')).href)});} catch(e) {console.error(e.message);process.exitCode=1;}
        console.log('POSTS='+JSON.stringify(sent));
      `;
      const run=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/1/test'}});
      const final=JSON.parse(await readFile(stateFile,'utf8'));
      const posts=JSON.parse(run.stdout.match(/POSTS=(.*)/)[1]);
      if (mode==='success') {
        assert.equal(run.status,0,run.stderr);
        assert.equal(posts.length,2);
        assert.equal(posts[1].embeds[0].fields[0].name,'旧作テスト');
        assert.ok(final.seenSeries.includes('srnew'));
      } else {
        assert.deepEqual(final,initial);
        assert.equal(run.status,mode==='failure'?1:0,run.stderr);
        assert.equal(posts.length,mode==='preview'?0:2);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  });
}
