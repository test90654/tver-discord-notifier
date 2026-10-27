export function validateState(state) {
  if (state?.version !== 1 || !Number.isFinite(Date.parse(state.observedAt)) || !Array.isArray(state.seenSeries) || state.seenSeries.some(id => !/^sr[a-z0-9]+$/.test(id))) {
    throw new Error('Invalid old-drama history; refusing to reset notification history.');
  }
  return state;
}

export function detectOldDramas(state, catalog, newer, now = new Date()) {
  validateState(state);
  const seen = new Set(state.seenSeries);
  const found = new Map();
  const cutoff = Date.parse(state.observedAt) / 1000 - 300;
  for (const item of newer) {
    const c = item.content;
    if (item.type !== 'episode' || !/^sr[a-z0-9]+$/.test(c?.seriesID) || !/^ep[a-z0-9]+$/.test(c?.id)) continue;
    const year = /^(\d{4})年放送/.exec(c.broadcastDateLabel || '');
    if (!year || Number(year[1]) > Number(new Intl.DateTimeFormat('en', {timeZone:'Asia/Tokyo',year:'numeric'}).format(now)) || c.isAvailable !== true || c.ribbonID === 1 || !Number.isFinite(c.endAt) || c.endAt <= now.getTime()/1000 || !c.seriesTitle || !Number.isFinite(item.startAt) || item.startAt < cutoff || item.startAt > now.getTime()/1000 || seen.has(c.seriesID)) continue;
    const previous = found.get(c.seriesID);
    if (previous) {
      previous.episodeCount++;
      previous.startAt = Math.min(previous.startAt, item.startAt);
      previous.endAt = Math.min(previous.endAt, c.endAt);
    } else {
      found.set(c.seriesID, {id:c.seriesID,title:c.seriesTitle,year:Number(year[1]),startAt:item.startAt,endAt:c.endAt,episodeCount:1});
    }
  }
  for (const item of [...catalog, ...newer]) {
    if (item.type === 'episode' && /^sr[a-z0-9]+$/.test(item.content?.seriesID) && item.content.isAvailable === true && item.content.endAt > now.getTime()/1000 && (!Number.isFinite(item.startAt) || item.startAt <= now.getTime()/1000)) seen.add(item.content.seriesID);
  }
  return {
    additions: [...found.values()].sort((a,b)=>b.startAt-a.startAt),
    nextState: {version:1,observedAt:now.toISOString(),seenSeries:[...seen].sort()}
  };
}
