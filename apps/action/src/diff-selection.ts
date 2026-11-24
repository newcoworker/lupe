/**
 * Which diff the action reviewed, for the run log. The action reviews either
 * the incremental diff since the last reviewed SHA, or the full PR diff (a
 * first review, or the incremental compare fell back to it).
 */
export type DiffSelection =
  | { readonly kind: 'incremental'; readonly sinceSha: string; readonly fileCount: number }
  | { readonly kind: 'full'; readonly reason: string | undefined; readonly fileCount: number };

/**
 * Log line describing which diff was reviewed. The "incremental review since"
 * line is produced only when the incremental diff was really used; a fallback
 * to the full diff names its reason (a non-fast-forward compare status, or the
 * 300-file compare limit) instead. Returns undefined for a first review, which
 * stays silent as before.
 */
export function formatDiffSelectionLog(selection: DiffSelection): string | undefined {
  if (selection.kind === 'incremental') {
    return `lupe: incremental review since ${selection.sinceSha.slice(0, 7)} (${selection.fileCount} files).`;
  }
  return selection.reason === undefined
    ? undefined
    : `lupe: full diff review (${selection.fileCount} files): ${selection.reason}.`;
}
