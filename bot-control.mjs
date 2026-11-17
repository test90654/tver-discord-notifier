import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {getRanking} from './ranking.mjs';
import {downloadCollection, downloadEpisodes, episodeUrl} from './download.mjs';

export function authorized(interaction, guildId, userIds) {
  return interaction.guildId === guildId && userIds.has(interaction.user.id);
}

export class DownloadController {
  constructor({ranking = getRanking, download = downloadCollection, downloadExact = downloadEpisodes, stateDirectory = process.env.DOWNLOAD_STATE_DIR || '.download-state', automatic = (process.env.DAILY_LIST ?? process.env.AUTO_DOWNLOAD) === 'true'} = {}) {
    this.ranking = ranking;
    this.download = download;
    this.downloadExact = downloadExact;
    this.stateDirectory = stateDirectory;
    this.schedule = {enabled:automatic, lastDate:null};
    this.active = false;
    this.progress = '待機中';
    this.warnings = [];
  }
  async init() {
    await mkdir(this.stateDirectory, {recursive:true});
    try {
      const saved = JSON.parse(await readFile(join(this.stateDirectory,'schedule.json'),'utf8'));
      if (typeof saved.enabled !== 'boolean' || (saved.lastDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(saved.lastDate))) throw new Error('Invalid schedule state');
      this.schedule = saved;
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  async saveSchedule() {
    const path = join(this.stateDirectory,'schedule.json');
    await writeFile(path+'.tmp',JSON.stringify(this.schedule,null,2)+'\n');
    await rename(path+'.tmp',path);
  }
  async setAutomatic(enabled) {
    const previous = this.schedule.enabled;
    this.schedule.enabled = enabled;
    try {await this.saveSchedule();}
    catch(error) {this.schedule.enabled = previous; throw error;}
  }
  status() {
    return `${this.progress}\n毎日21:10（日本時間）のランキング選択リスト投稿：${this.schedule.enabled?'ON':'OFF'}\n直近の自動実行日：${this.schedule.lastDate || '未実行'}`;
  }
  // url: one episode plus earlier episodes of its season (legacy /download).
  // selected: exactly the episodes checked in a Discord list, nothing else.
  async start(url = null, {selected = null} = {}) {
    if (this.active) throw new Error('実行中です。/status で確認してください。');
    if (url !== null) url = episodeUrl(url);
    if (selected !== null) {
      selected = [...new Set(selected.map(episodeUrl))];
      if (!selected.length) throw new Error('保存する回を選択してください。');
    }
    this.active = true;
    this.warnings = [];
    this.progress = 'ランキング取得／ダウンロード準備中';
    try {
      const onProgress = ({index,total})=>{this.progress=`ダウンロード処理中：${index}/${total}`;};
      const results = selected
        ? await this.downloadExact(selected, {stateDirectory:this.stateDirectory, onProgress})
        : await this.download(url ? [url] : await this.ranking(), {stateDirectory:this.stateDirectory, onProgress});
      const ok = results.filter(x=>x.ok).length;
      this.warnings = results.warnings || [];
      this.progress = `完了：保存成功または保存済み ${ok}/${results.length}件、失敗 ${results.length-ok}件`;
      if (this.warnings.length) this.progress += `\n⚠ 不足・確認不能などの警告 ${this.warnings.length}件（詳細は通知チャンネル）`;
      return this.progress;
    } catch(error) {
      this.progress = '失敗しました。ホストのログを確認して再実行してください。';
      throw error;
    } finally {this.active = false;}
  }
  // Returns the JST date when today's selection list is due (once per day after 21:10), otherwise null.
  async tick(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (!this.schedule.enabled || this.schedule.lastDate === date || `${parts.hour}:${parts.minute}` < '21:10') return null;
    // Record the attempt first so a failing post is not repeated every 30 seconds.
    this.schedule.lastDate = date;
    await this.saveSchedule();
    return date;
  }
}
