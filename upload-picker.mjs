import {randomBytes} from 'node:crypto';
import {listUploadCandidates,setExternalCopies,youtubeVideoUrl} from './external-copies.mjs';

const row=components=>({type:1,components});
const button=(id,label,style=2,disabled=false)=>({type:2,custom_id:id,label,style,disabled});
const text=value=>String(value).slice(0,100);
export class UploadPicker {
  constructor({stateDirectory,list=listUploadCandidates,save=setExternalCopies,now=()=>Date.now()}={}){Object.assign(this,{stateDirectory,list,save,now});this.sessions=new Map();}
  id(session,action){return `tver:uploads:${session.id}:${action}`;}
  async open(interaction,{youtubeUrl=null}={}){
    await interaction.deferReply({flags:64});
    const destination=youtubeUrl?youtubeVideoUrl(youtubeUrl):null;
    const groups=await this.list({stateDirectory:this.stateDirectory});
    if(!groups.length){await interaction.editReply({content:'登録できる未登録の保存済み動画がありません。PC内の動画と .info.json がそろっているか確認してください。',components:[]});return;}
    for(const [key,session] of this.sessions)if(this.now()-session.createdAt>1800000 || session.userId===interaction.user.id)this.sessions.delete(key);
    if(this.sessions.size>=100)this.sessions.delete(this.sessions.keys().next().value);
    const session={id:randomBytes(8).toString('hex'),userId:interaction.user.id,guildId:interaction.guildId,createdAt:this.now(),groups,workPage:0,episodePage:0,groupIndex:null,selected:new Set(),youtubeUrl:destination,stage:'works'};
    this.sessions.set(session.id,session);
    await interaction.editReply(this.render(session));
  }
  render(session){
    const base={allowedMentions:{parse:[]}};
    const group=session.groups[session.groupIndex];
    if(session.stage==='confirm'){
      const selected=group.episodes.filter(x=>session.selected.has(x.id));
      const labels=selected.slice(0,50).map(x=>`第${x.number}話`).join('・')+(selected.length>50?` ほか${selected.length-50}話`:'');
      return {...base,content:`YouTube保存済みとして登録しますか？\n${group.title}\n選択：${labels}（${selected.length}話）\nYouTube URL：${session.youtubeUrl || '省略（任意）'}\nYouTubeでの処理完了・再生を確認した話だけ登録してください。PCの動画は自動削除しません。`,components:[row([
        button(this.id(session,'commit'),`この${selected.length}話を保存済みに登録`,3),button(this.id(session,'back'),'話数を選び直す'),button(this.id(session,'cancel'),'キャンセル')
      ])]};
    }
    if(session.stage==='works'){
      const start=session.workPage*25;
      const options=session.groups.slice(start,start+25).map((item,index)=>({label:text(item.title),value:`g${start+index}`,description:text(`${item.episodes.length}話：${item.episodes[0].episodeTitle || '第'+item.episodes[0].number+'話'}`)}));
      return {...base,content:`YouTubeへ保存済みにする作品を選んでください。（${session.workPage+1}/${Math.ceil(session.groups.length/25)}ページ）\nURLの入力は不要です。`,components:[row([{type:3,custom_id:this.id(session,'work'),placeholder:'作品を選択',min_values:1,max_values:1,options}]),row([
        button(this.id(session,'works-prev'),'前の作品ページ',2,session.workPage===0),button(this.id(session,'works-next'),'次の作品ページ',2,start+25>=session.groups.length),button(this.id(session,'cancel'),'キャンセル')
      ])]};
    }
    const start=session.episodePage*25;
    const options=group.episodes.slice(start,start+25).map((item,index)=>({label:`第${item.number}話`,value:`e${start+index}`,description:text(item.episodeTitle || group.title),default:session.selected.has(item.id)}));
    return {...base,content:`${group.title}\nYouTubeへ保存した話を選んでください。複数選択できます。\n選択済み：${session.selected.size}話／${session.episodePage+1} of ${Math.ceil(group.episodes.length/25)}ページ`,components:[
      row([{type:3,custom_id:this.id(session,'episodes'),placeholder:'保存済みにする話を選択（複数可）',min_values:0,max_values:options.length,options}]),
      row([button(this.id(session,'episodes-prev'),'前の話数ページ',2,session.episodePage===0),button(this.id(session,'episodes-next'),'次の話数ページ',2,start+25>=group.episodes.length)]),
      row([button(this.id(session,'all'),'この作品の全話を選択'),button(this.id(session,'clear'),'選択解除')]),
      row([button(this.id(session,'confirm'),'選択した話を確認',1,session.selected.size===0),button(this.id(session,'works'),'作品を選び直す'),button(this.id(session,'cancel'),'キャンセル')])
    ]};
  }
  async handle(interaction){
    if(interaction.customId==='tver:uploads:open'){await this.open(interaction);return;}
    const match=interaction.customId.match(/^tver:uploads:([a-f0-9]{16}):([a-z-]+)$/);
    const session=match && this.sessions.get(match[1]);
    if(!session || this.now()-session.createdAt>1800000 || session.userId!==interaction.user.id || session.guildId!==interaction.guildId){
      await interaction.reply({content:'選択画面が期限切れ、または別の利用者の画面です。「YouTube保存済みにする」から開き直してください。',flags:64});return;
    }
    if(session.busy){await interaction.reply({content:'登録処理中です。少しお待ちください。',flags:64});return;}
    const action=match[2];
    await interaction.deferUpdate();
    if(session.busy || !this.sessions.has(session.id)){
      await interaction.editReply({content:'登録処理中、または登録済みです。',components:[]});return;
    }
    const group=session.groups[session.groupIndex];
    if(action==='cancel'){
      this.sessions.delete(session.id);await interaction.editReply({content:'登録をキャンセルしました。',components:[]});return;
    }else if(action==='works-prev')session.workPage=Math.max(0,session.workPage-1);
    else if(action==='works-next')session.workPage=Math.min(Math.ceil(session.groups.length/25)-1,session.workPage+1);
    else if(action==='work'){
      const index=Number(String(interaction.values?.[0]).replace(/^g/,''));
      if(!Number.isInteger(index) || index<session.workPage*25 || index>=Math.min(session.groups.length,(session.workPage+1)*25))throw new Error('Invalid work selection');
      session.groupIndex=index;session.selected.clear();session.episodePage=0;session.stage='episodes';
    }else if(action==='works'){session.stage='works';session.selected.clear();}
    else if(group){
      if(action==='episodes'){
        const start=session.episodePage*25;
        for(const item of group.episodes.slice(start,start+25))session.selected.delete(item.id);
        for(const value of interaction.values || []){
          const index=Number(value.replace(/^e/,''));
          if(!Number.isInteger(index) || index<start || index>=Math.min(group.episodes.length,start+25))throw new Error('Invalid episode selection');
          session.selected.add(group.episodes[index].id);
        }
      }else if(action==='episodes-prev')session.episodePage=Math.max(0,session.episodePage-1);
      else if(action==='episodes-next')session.episodePage=Math.min(Math.ceil(group.episodes.length/25)-1,session.episodePage+1);
      else if(action==='all')session.selected=new Set(group.episodes.map(x=>x.id));
      else if(action==='clear')session.selected.clear();
      else if(action==='back')session.stage='episodes';
      else if(action==='confirm'){
        if(!session.selected.size)throw new Error('No episodes selected');
        session.stage='confirm';
      }else if(action==='commit'){
        if(session.stage!=='confirm' || !session.selected.size)throw new Error('Confirm selection first');
        session.busy=true;
        try{
          const episodes=group.episodes.filter(x=>session.selected.has(x.id));
          await this.save({episodes,youtubeUrl:session.youtubeUrl,declaredBy:interaction.user.id},this.stateDirectory);
          this.sessions.delete(session.id);
          await interaction.editReply({content:`${group.title}：${episodes.length}話をYouTube保存済みとして登録しました。PCから動画を削除しても再取得しません。\n動画の再生確認後に削除してください。.info.json と .download-state は残してください。`,components:[],allowedMentions:{parse:[]}});
          return;
        }finally{session.busy=false;}
      }
    }
    await interaction.editReply(this.render(session));
  }
}
