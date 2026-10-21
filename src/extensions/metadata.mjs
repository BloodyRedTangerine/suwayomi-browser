/** Suwayomi maps legacy nsfw=1 to MIXED; v1.6 also distinguishes NSFW=2. */
export function contentWarningFromMetadata(metadata) {
  const number = value => {
    const typed = /^\{(?:16|17):(-?\d+)\}$/.exec(value || '');
    const result = Number(typed ? typed[1] : value);
    return Number.isInteger(result) ? result : 0;
  };
  const value = number(metadata['tachiyomix.contentWarning']) || number(metadata['tachiyomi.extension.nsfw']);
  return ['SAFE', 'MIXED', 'NSFW'][value] || 'MIXED';
}
