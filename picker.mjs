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
