import {Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder} from 'discord.js';
import {DownloadController, authorized} from './bot-control.mjs';
import {episodeUrl} from './download.mjs';
import {warningMessages} from './past-episodes.mjs';
import {PICK_PREFIX, rankingPicker, seasonPicker, selectedUrls} from './picker.mjs';

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const channelId = process.env.DISCORD_CHANNEL_ID;
const userIds = new Set((process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
if (!token || !/^\d+$/.test(guildId || '') || !/^\d+$/.test(channelId || '') || !userIds.size || [...userIds].some(x=>!/^\d+$/.test(x))) {
  throw new Error('Set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID and DISCORD_ALLOWED_USER_IDS.');
}
const controller = new DownloadController();
await controller.init();
const commands = [
  new SlashCommandBuilder().setName('download').setDescription('TVerをホストに保存する')
    .addSubcommand(x=>x.setName('ranking').setDescription('最新ドラマTOP10と同じシーズンの過去話を保存'))
    .addSubcommand(x=>x.setName('url').setDescription('指定した話と同じシーズンの過去話を保存').addStringOption(o=>o.setName('url').setDescription('https://tver.jp/episodes/ep...').setRequired(true))),
  new SlashCommandBuilder().setName('list').setDescription('タイトル一覧を表示し、チェックした回だけ保存する')
    .addSubcommand(x=>x.setName('ranking').setDescription('最新ドラマTOP10を一覧表示'))
    .addSubcommand(x=>x.setName('url').setDescription('指定した話と同じシーズンの全話を一覧表示').addStringOption(o=>o.setName('url').setDescription('https://tver.jp/episodes/ep...').setRequired(true))),
  new SlashCommandBuilder().setName('status').setDescription('ダウンロードの進行と自動保存設定を確認'),
  new SlashCommandBuilder().setName('auto').setDescription('毎日21:10にランキングの選択リストを投稿するか切り替える')
    .addBooleanOption(x=>x.setName('enabled').setDescription('ONなら毎日投稿（自動では保存しません）').setRequired(true))
].map(x=>x.toJSON());
const client = new Client({intents:[GatewayIntentBits.Guilds], allowedMentions:{parse:[]}});
let channel;
let timer;
async function report(content) {
  try {await channel.send({content,allowedMentions:{parse:[]}});}
  catch {console.error('Could not send download result to Discord.');}
}
async function completion(content) {
  const warnings = [...controller.warnings];
  await report(content);
  for (const message of warningMessages(warnings)) await report(message);
}
async function tick() {
  try {
    if (!await controller.tick()) return;
    const picker = await rankingPicker();
    await channel.send({...picker,allowedMentions:{parse:[]}});
  } catch {console.error('Daily selection list failed.'); await report('本日のランキング選択リストを投稿できませんでした。/list ranking で再表示できます。');}
}
function startSelected(interaction, urls) {
  const task = controller.start(null,{selected:urls});
  void task.then(result=>completion(`<@${interaction.user.id}> ${result}`),async()=>{
    console.error('Selected download failed; inspect downloader output.');
    await report('選択した回のダウンロードに失敗しました。ホストのログを確認してください。');
  });
}
client.once(Events.ClientReady, async ready => {
  try {
    channel = await client.channels.fetch(channelId);
    if (channel?.guildId !== guildId || !channel.isTextBased() || typeof channel.send !== 'function') throw new Error('Invalid notification channel');
    const rest = new REST({version:'10'}).setToken(token);
    // This application should be dedicated to this bot: replaces its guild commands.
    await rest.put(Routes.applicationGuildCommands(ready.user.id,guildId), {body:commands});
    console.log('TVer bot ready.');
    timer = setInterval(()=>void tick(),30000);
    await tick();
  } catch {console.error('Bot setup failed: check token, guild/channel IDs and bot permissions.'); await client.destroy(); process.exitCode=1;}
});
client.on(Events.InteractionCreate, async interaction => {
  const picking = interaction.isStringSelectMenu() && interaction.customId.startsWith(PICK_PREFIX);
  if (!interaction.isChatInputCommand() && !picking) return;
  try {
    if (!authorized(interaction,guildId,userIds)) {
      await interaction.reply({content:'このBotを操作する権限がありません。',flags:MessageFlags.Ephemeral});
      return;
    }
    if (picking) {
      if (controller.active) {
        await interaction.reply({content:'別の保存を実行中です。完了後にもう一度チェックしてください。/status で確認できます。',flags:MessageFlags.Ephemeral});
        return;
      }
      const urls = selectedUrls(interaction.values);
      const labels = interaction.component.options.filter(x=>interaction.values.includes(x.value)).map(x=>`・${x.label}${x.description?` ${x.description}`:''}`);
      startSelected(interaction,urls);
      await interaction.reply({content:`選択した${urls.length}件の保存を開始しました（他の回は保存しません）。\n${labels.join('\n')}`.slice(0,1900),flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
    } else if (interaction.commandName === 'list') {
      await interaction.deferReply();
      const picker = interaction.options.getSubcommand() === 'url'
        ? await seasonPicker(interaction.options.getString('url',true))
        : await rankingPicker();
      if (!picker.components.length) {await interaction.editReply('表示できる回がありません。'); return;}
      await interaction.editReply({...picker,allowedMentions:{parse:[]}});
    } else if (interaction.commandName === 'status') {
      await interaction.reply({content:controller.status(),flags:MessageFlags.Ephemeral});
    } else if (interaction.commandName === 'auto') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      await controller.setAutomatic(interaction.options.getBoolean('enabled',true));
      await interaction.editReply(controller.status());
    } else if (interaction.commandName === 'download') {
      if (controller.active) {
        await interaction.reply({content:'実行中です。/status で確認してください。',flags:MessageFlags.Ephemeral});
        return;
      }
      const url = interaction.options.getSubcommand() === 'url' ? episodeUrl(interaction.options.getString('url',true)) : null;
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      // Completion is posted to the configured channel, so jobs may exceed Discord's interaction lifetime.
      const task = controller.start(url);
      void task.then(result=>completion(`<@${interaction.user.id}> ${result}`),async()=>{
        console.error('Manual download failed; inspect downloader output.');
        await report('手動ダウンロードに失敗しました。ホストのログを確認してください。');
      });
      await interaction.editReply('処理を開始しました。/status で確認できます。完了結果は設定した通知チャンネルへ投稿します。');
    }
  } catch {
    const response = {content:'処理できませんでした。URL・実行状況・ホストのログを確認してください。',allowedMentions:{parse:[]}};
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({...response,flags:MessageFlags.Ephemeral});
    } catch {console.error('Could not reply to interaction.');}
  }
});
client.on(Events.Error,()=>console.error('Discord client error; check connection.'));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{clearInterval(timer); void client.destroy();});
try {await client.login(token);} catch {console.error('Discord login failed.'); process.exitCode=1;}
