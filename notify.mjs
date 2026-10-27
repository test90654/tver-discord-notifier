import { chromium } from 'playwright';

const source = 'https://tver.jp/rankings/episode/drama';
const dryRun = process.argv.includes('--dry-run');
const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!dryRun && (!webhook || !/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook))) {
  throw new Error('Set a valid DISCORD_WEBHOOK_URL repository secret.');
}
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? {channel: process.env.BROWSER_CHANNEL} : {}) });
let ranking;
try {
  const page = await browser.newPage();
  await page.goto(source, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('a[href^="/episodes/"]').first().waitFor({ timeout: 60000 });
  ranking = await page.evaluate(() => window.TVerApp.callEpisodeRankingDetail('drama'));
} finally {
  await browser.close();
}
if (ranking?.contents?.content?.id !== 'drama') throw new Error('Unexpected ranking category.');
const rows = ranking.contents.contents.filter(x => x.type === 'episode').sort((a,b) => a.rank-b.rank).slice(0,10);
if (rows.length !== 10 || rows.some((x,i) => x.rank !== i+1 || !/^ep[a-z0-9]+$/.test(x.content?.id) || !x.content?.seriesTitle) || new Set(rows.map(x=>x.content.id)).size !== 10) {
  throw new Error('Could not validate the top 10; no notification sent.');
}
const escape = s => String(s).replace(/[\\*_~`|\[\]<>]/g, '\\$&');
const date = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'short'}).format(new Date());
const embeds = [{
  title: 'TVer ドラマランキング TOP10', url: source, color: 0x00aa99,
  description: `${date}（日本時間）取得\nエピソード単位のランキングです。`,
  fields: rows.map(x => ({name: `${x.rank}位　${x.content.seriesTitle}`.slice(0,256),value: `[${escape(x.content.title || '視聴する').slice(0,700)}](https://tver.jp/episodes/${x.content.id})`,inline:false})),
  footer: {text:'出典：TVer公式ドラマランキング'}
}];
if (dryRun) console.log(JSON.stringify({embeds}, null, 2));
else {
  // Do not retry ambiguous failures: a retry could post the same message twice.
  let response;
  try { response = await fetch(`${webhook}?wait=true`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embeds,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(30000)}); }
  catch { throw new Error('Discord request failed; check the channel before retrying.'); }
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);
  console.log('Posted the top 10 to Discord.');
}
