import {Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder} from 'discord.js';
import {DownloadController} from './bot-control.mjs';
import {createInteractionHandler} from './bot-actions.mjs';
import {warningMessages} from './past-episodes.mjs';

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
  new SlashCommandBuilder().setName('status').setDescription('ダウンロードの進行と自動保存設定を確認'),
  new SlashCommandBuilder().setName('auto').setDescription('このBotの毎日21:10の自動保存を切り替える')
    .addBooleanOption(x=>x.setName('enabled').setDescription('ONなら自動保存').setRequired(true))
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
    const result = await controller.tick();
    if (result) await completion(`自動ダウンロード：${result}`);
  } catch {console.error('Automatic download failed; inspect downloader output.'); await report('自動ダウンロードに失敗しました。ホストのログを確認してください。');}
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
client.on(Events.InteractionCreate,createInteractionHandler({controller,guildId,userIds,completion,report}));
client.on(Events.Error,()=>console.error('Discord client error; check connection.'));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{clearInterval(timer); void client.destroy();});
try {await client.login(token);} catch {console.error('Discord login failed.'); process.exitCode=1;}
