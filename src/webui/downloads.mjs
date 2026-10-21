const int = value => { if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new TypeError('Download IDs/positions must be non-negative GraphQL Ints'); return value; };
export const queueState = db => db.downloads ||= { state: 'STOPPED', queue: [] };
export function chapterIds(input, single) {
  const ids = single ? [input.id] : input.ids;
  if (!Array.isArray(ids)) throw new TypeError('Chapter IDs must be an array');
  return [...new Set(ids.map(int))];
}
export function reorderDownloads(queue, reorders) {
  if (!Array.isArray(reorders)) throw new TypeError('Download reorders must be an array');
  for (const item of reorders) {
    int(item.chapterId); int(item.to);
    if (!queue.some(row => row.chapterId === item.chapterId)) throw new Error('Chapter is not queued');
  }
  const ordered = [...queue];
  for (const item of reorders) {
    const [row] = ordered.splice(ordered.findIndex(row => row.chapterId === item.chapterId), 1);
    ordered.splice(Math.min(item.to, ordered.length), 0, row);
  }
  return ordered;
}
