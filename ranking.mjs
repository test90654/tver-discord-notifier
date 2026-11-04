export async function getRanking(fetchImpl = fetch) {
  const headers = {Origin: 'https://tver.jp', Referer: 'https://tver.jp/', 'x-tver-platform-type': 'web'};
  async function json(url, options = {}) {
    const response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`TVer API: HTTP ${response.status}`);
    return (await response.json()).result;
  }
  const identity = await json('https://platform-api.tver.jp/v2/api/platform_users/browser/create', {
    method: 'POST', headers: {...headers, 'Content-Type': 'application/x-www-form-urlencoded'}, body: 'device_type=pc'
  });
  if (!identity?.platform_uid || !identity?.platform_token) throw new Error('TVer credentials unavailable');
  const url = new URL('https://platform-api.tver.jp/service/api/v1/callEpisodeRankingDetail/drama');
  url.search = new URLSearchParams({platform_uid: identity.platform_uid, platform_token: identity.platform_token});
  const result = await json(url, {headers});
  const rows = result?.contents?.contents;
  if (result?.contents?.content?.id !== 'drama' || !Array.isArray(rows)) throw new Error('Invalid ranking');
  const top = rows.filter(x => x.type === 'episode').sort((a,b) => a.rank-b.rank).slice(0,10);
  if (top.length !== 10 || top.some((x,i) => x.rank !== i+1 || !/^ep[a-z0-9]+$/.test(x.content?.id)) || new Set(top.map(x => x.content.id)).size !== 10) {
    throw new Error('Invalid ranking top 10');
  }
  return top.map(x => `https://tver.jp/episodes/${x.content.id}`);
}
