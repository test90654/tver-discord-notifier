import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {getRanking} from './ranking.mjs';
import {CANCELLED, downloadCollection,downloadEpisodes, episodeUrl} from './download.mjs';
import {formatProgress} from './progress.mjs';

export function authorized(interaction, guildId, userIds) {
  return interaction.guildId === guildId && userIds.has(interaction.user.id);
}

export class DownloadController {
  constructor({ranking = getRanking, download = downloadCollection,directDownload=downloadEpisodes, stateDirectory = process.env.DOWNLOAD_STATE_DIR || '.download-state', automatic = process.env.AUTO_DOWNLOAD === 'true'} = {}) {
    this.ranking = ranking;
    this.download = download;
    this.directDownload=directDownload;
    this.watcher=null;
    this.lastResults=[];
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
    return `${this.progress}\n毎日21:10（日本時間）の自動保存：${this.schedule.enabled?'ON':'OFF'}\n直近の自動実行日：${this.schedule.lastDate || '未実行'}${this.watcher?'\n'+this.watcher.status():''}`;
  }
  // selected: exactly the episodes checked in a Discord list (/list), without adding past episodes.
  async start(url = null, {scheduledDate,plan=null,monitor=false,selected=null} = {}) {
    if (this.active) throw new Error('実行中です。/status で確認してください。');
    if (url !== null) url = episodeUrl(url);
    if (selected !== null) {
      selected = [...new Set(selected.map(episodeUrl))];
      if (!selected.length) throw new Error('保存する回を選択してください。');
    }
    this.active = true;
    this.aborter = new AbortController();
    this.warnings = [];
    this.lastResults=[];
    this.progress = 'ランキング取得／ダウンロード準備中';
    try {
      if (scheduledDate) {
        this.schedule.lastDate = scheduledDate;
        await this.saveSchedule();
      }
      const signal=this.aborter.signal;
      const options={stateDirectory:this.stateDirectory,signal,onProgress:event=>{if(!signal.aborted)this.progress=formatProgress(event);},onPlan:value=>this.watcher?.track(value)};
      const results=selected?await this.directDownload(selected,options):plan?await this.directDownload(plan.urls,{...options,plan,ignoreArchive:monitor}):await this.download(url?[url]:await this.ranking(),options);
      this.lastResults=results;
      const ok = results.filter(x=>x.ok).length;
      const skipped = results.filter(x=>x.skipped).length;
      this.warnings = results.warnings || [];
      this.progress = results.cancelled
        ? `中止しました：保存成功または保存済み ${ok}件、失敗 ${results.length-ok-skipped}件、未保存 ${skipped}件`
        : `完了：保存成功または保存済み ${ok}/${results.length}件、失敗 ${results.length-ok-skipped}件、未試行 ${skipped}件`;
      if (this.warnings.length) this.progress += `\n⚠ 不足・確認不能などの警告 ${this.warnings.length}件（詳細は通知チャンネル）`;
      return this.progress;
    } catch(error) {
      if (error.code === CANCELLED || this.aborter.signal.aborted) {
        this.progress = '中止しました（ダウンロード開始前）。';
        return this.progress;
      }
      this.progress = '失敗しました。ホストのログを確認して再実行してください。';
      throw error;
    } finally {this.active = false; this.aborter = null;}
  }
  // Stop the running job: kills the current yt-dlp and skips the remaining episodes.
  cancel() {
    if (!this.active || !this.aborter || this.aborter.signal.aborted) return false;
    this.aborter.abort();
    this.progress = '中止しています…（実行中のyt-dlpを停止しています）';
    return true;
  }
  async tick(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (!this.schedule.enabled || this.active || this.schedule.lastDate === date || `${parts.hour}:${parts.minute}` < '21:10') return null;
    return this.start(null, {scheduledDate:date});
  }
}
