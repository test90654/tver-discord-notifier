import {authorized} from './bot-control.mjs';
import {episodeUrl} from './download.mjs';
import {resolveUploadEpisode,setExternalCopy,youtubeVideoUrl} from './external-copies.mjs';
import {UploadPicker} from './upload-picker.mjs';

const ephemeral = 64;
export function statusPanel(controller, notice = '') {
  return {
    content:[notice,controller.status(),'下のボタンで今すぐ保存・自動保存の切り替えができます。'].filter(Boolean).join('\n'),
    allowedMentions:{parse:[]},
    components:[{type:1,components:[
      {type:2,custom_id:'tver:download-now',label:controller.active?'保存処理中':'今すぐランキングと過去話を保存',style:1,disabled:controller.active},
      {type:2,custom_id:'tver:refresh',label:'状態を更新',style:2}
    ]},{type:1,components:[
      {type:2,custom_id:'tver:auto:on',label:'毎日の自動保存をON',style:3,disabled:controller.schedule.enabled},
      {type:2,custom_id:'tver:auto:off',label:'毎日の自動保存をOFF',style:2,disabled:!controller.schedule.enabled}
    ]},{type:1,components:[{type:2,custom_id:'tver:uploads:open',label:'YouTube保存済みにする',style:2}]}]
  };
}

export function createInteractionHandler({controller,guildId,userIds,completion,report,onStateChange=async()=>{},uploadPicker=new UploadPicker({stateDirectory:controller.stateDirectory})}) {
  return async interaction => {
    const button = interaction.isButton();
    const select=interaction.isStringSelectMenu?.()===true;
    if (!interaction.isChatInputCommand() && !((button || select) && interaction.customId.startsWith('tver:'))) return;
    try {
      if (!authorized(interaction,guildId,userIds)) {
        await interaction.reply({content:'このBotを操作する権限がありません。',flags:ephemeral});
        return;
      }
      if((button || select) && interaction.customId.startsWith('tver:uploads:')){await uploadPicker.handle(interaction);return;}
      const respond = async notice => interaction.editReply(statusPanel(controller,notice));
      const begin = async url => {
        // Recheck after acknowledgement: another click or the daily timer may have started a job.
        if (controller.active) {
          await respond('保存処理が実行中です。「状態を更新」で確認してください。');
          return;
        }
        const task = controller.start(url);
        void onStateChange();
        void task.then(result=>completion(`<@${interaction.user.id}> ${result}`),async()=>{
          console.error('Manual download failed; inspect downloader output.');
          await report('手動ダウンロードに失敗しました。ホストのログを確認してください。');
        }).catch(()=>console.error('Could not report manual download result.'));
        await respond('今すぐ保存を開始しました。完了結果は設定した通知チャンネルへ投稿します。');
      };
      if (button) {
        await interaction.deferUpdate();
        if (interaction.customId === 'tver:download-now') await begin(null);
        else if (interaction.customId === 'tver:refresh') await respond();
        else if (['tver:auto:on','tver:auto:off'].includes(interaction.customId)) {
          const enabled = interaction.customId === 'tver:auto:on';
          await controller.setAutomatic(enabled);
          await onStateChange();
          await respond(`毎日の自動保存を${enabled?'ON':'OFF'}にしました。`);
        } else await respond('この操作は利用できません。');
      } else if (interaction.commandName === 'status') {
        await onStateChange();
        await interaction.reply(statusPanel(controller));
      } else if (interaction.commandName === 'auto') {
        await interaction.deferReply({flags:ephemeral});
        await controller.setAutomatic(interaction.options.getBoolean('enabled',true));
        await onStateChange();
        await respond();
      } else if (['uploaded','unuploaded'].includes(interaction.commandName)) {
        if(interaction.commandName==='uploaded' && !interaction.options.getString('episode')){
          await uploadPicker.open(interaction,{youtubeUrl:interaction.options.getString('youtube')});return;
        }
        await interaction.deferReply({flags:ephemeral});
        const remove=interaction.commandName==='unuploaded';
        const suppliedYoutube=interaction.options.getString('youtube');
        const youtubeUrl=remove || !suppliedYoutube?null:youtubeVideoUrl(suppliedYoutube);
        const episode=await resolveUploadEpisode(interaction.options.getString('episode',true),{stateDirectory:controller.stateDirectory});
        await setExternalCopy({episode,youtubeUrl,declaredBy:interaction.user.id,remove},controller.stateDirectory);
        await interaction.editReply({content:remove?`${episode.title} 第${episode.number}話のYouTube保存済み登録を解除しました。未保存なら再取得の対象になります。`:`${episode.title} 第${episode.number}話を「YouTubeへ保存済み」と登録しました。PCから動画を削除しても、この話は再ダウンロードしません。\nYouTubeでの保存は利用者の申告として記録しました。再生確認後に元動画を削除してください。`,allowedMentions:{parse:[]}});
        await onStateChange();
      } else if (interaction.commandName === 'download') {
        const url = interaction.options.getSubcommand() === 'url' ? episodeUrl(interaction.options.getString('url',true)) : null;
        await interaction.deferReply({flags:ephemeral});
        await begin(url);
      }
    } catch {
      const response={content:'処理できませんでした。URL・実行状況・ホストのログを確認してください。',allowedMentions:{parse:[]}};
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({...response,flags:ephemeral});
      } catch {console.error('Could not reply to interaction.');}
    }
  };
}
