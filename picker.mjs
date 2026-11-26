import {createCatalog} from './past-episodes.mjs';
import {getRankingEntries} from './ranking.mjs';
import {episodeUrl} from './download.mjs';

// Discord limits: 25 options per select menu, 5 component rows per message.
export const MAX_OPTIONS = 25;
export const MAX_MENUS = 5;
export const PICK_PREFIX = 'pick:';

const clip = (text, length) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > length ? value.slice(0, length - 1) + '…' : value;
};

// One select option per episode: the series name as the label, the episode name as the description.
export function optionFor(entry) {
  const label = clip(`${entry.rank ? `${entry.rank}位 ` : ''}${entry.seriesTitle || entry.title || entry.id}`, 100) || entry.id;
  const description = clip([entry.title, entry.date].filter(Boolean).join('　'), 100);
  return {label, value: entry.id, ...(description ? {description} : {}), ...(entry.selected ? {default: true} : {})};
}

// Build raw Discord component rows (multi-select menus), up to 125 episodes.
export function pickerComponents(entries, placeholder = '保存する回にチェック（複数可）') {
  const unique = [...new Map(entries.filter(x => /^ep[a-z0-9]+$/.test(x.id)).map(x => [x.id, x])).values()];
  const shown = unique.slice(0, MAX_OPTIONS * MAX_MENUS);
  const rows = [];
  for (let i = 0; i < shown.length; i += MAX_OPTIONS) {
    const chunk = shown.slice(i, i + MAX_OPTIONS);
    const page = rows.length + 1;
    const pages = Math.ceil(shown.length / MAX_OPTIONS);
    rows.push({type: 1, components: [{
      type: 3,
      custom_id: `${PICK_PREFIX}${page}`,
      placeholder: clip(pages > 1 ? `${placeholder}（${page}/${pages}）` : placeholder, 150),
      min_values: 1,
      max_values: chunk.length,
      options: chunk.map(optionFor)
    }]});
  }
  return {components: rows, omitted: unique.length - shown.length};
}

// Selected values come back from Discord; accept only well-formed episode IDs.
export function selectedUrls(values) {
  return [...new Set(values.map(id => episodeUrl(`https://tver.jp/episodes/${id}`)))];
}

export async function rankingPicker({ranking = getRankingEntries} = {}) {
  const entries = await ranking();
  return {content: '📺 TVer ドラマランキング TOP10\n保存したい回にチェックを入れて、メニューの外をクリックすると保存を開始します。', components: pickerComponents(entries).components};
}

// List every episode in the same season as the given URL; the given episode is pre-checked.
export async function seasonPicker(url, {catalog = createCatalog()} = {}) {
  const id = new URL(episodeUrl(url)).pathname.split('/').at(-1);
  const episode = await catalog.episode(id);
  let entries = await catalog.seasonContents(episode.seasonId);
  if (!entries.some(x => x.id === id)) entries = [{id, seriesTitle: episode.title, title: ''}, ...entries];
  entries = entries.map(x => ({...x, selected: x.id === id}));
  const picker = pickerComponents(entries);
  const note = picker.omitted ? `\n※ ${picker.omitted}件は表示上限のため省略しています。` : '';
  return {content: `📺 ${episode.title}\n指定した回にチェック済みです。必要な回だけチェックして、メニューの外をクリックすると保存を開始します。${note}`, components: picker.components};
}

const OLD_LABEL = /^(\d{4})年放送/;
const shortDate = seconds => new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', month:'numeric', day:'numeric'}).format(new Date(seconds * 1000));

// Archive dramas (labelled "YYYY年放送") whose episodes started streaming within the last `days` days.
// Same criteria as the daily old-drama notification, without its seen-series history.
export function oldDramaEntries(rows, {now = new Date(), days = 7} = {}) {
  const current = now.getTime() / 1000;
  const since = current - days * 86400;
  const thisYear = Number(new Intl.DateTimeFormat('en', {timeZone:'Asia/Tokyo', year:'numeric'}).format(now));
  const series = new Map();
  for (const item of rows) {
    const c = item?.content;
    if (item?.type !== 'episode' || !/^ep[a-z0-9]+$/.test(c?.id) || !/^sr[a-z0-9]+$/.test(c?.seriesID)) continue;
    const year = OLD_LABEL.exec(c.broadcastDateLabel || '');
    if (!year || Number(year[1]) > thisYear || c.isAvailable !== true || c.ribbonID === 1 || !c.seriesTitle) continue;
    if (!Number.isFinite(c.endAt) || c.endAt <= current || !Number.isFinite(item.startAt) || item.startAt < since || item.startAt > current) continue;
    if (!series.has(c.seriesID)) series.set(c.seriesID, {startAt:item.startAt, episodes:new Map()});
    const group = series.get(c.seriesID);
    group.startAt = Math.max(group.startAt, item.startAt);
    group.episodes.set(c.id, {id:c.id, seriesTitle:`${c.seriesTitle}（${year[1]}年）`, title:String(c.title || ''), date:`${shortDate(c.endAt)}まで`, startAt:item.startAt});
  }
  // Newest works first; episodes of one work stay together in streaming order.
  return [...series.values()].sort((a,b)=>b.startAt-a.startAt)
    .flatMap(group => [...group.episodes.values()].sort((a,b)=>a.startAt-b.startAt || a.title.localeCompare(b.title, 'ja', {numeric:true})))
    .map(({startAt, ...entry}) => entry);
}

export async function oldDramaPicker({catalog = createCatalog(), days = 7, now = new Date()} = {}) {
  const entries = oldDramaEntries(await catalog.newer('drama'), {now, days});
  const picker = pickerComponents(entries);
  const works = new Set(entries.map(x => x.seriesTitle)).size;
  const note = picker.omitted ? `\n※ ${picker.omitted}件は表示上限のため省略しています。` : '';
  return {content: `📼 新しく配信が始まった旧作ドラマ（直近${days}日・${works}作品${entries.length}話）\n保存したい回にチェックを入れて、メニューの外をクリックすると保存を開始します。${note}`, components: picker.components};
}
