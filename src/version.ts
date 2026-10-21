// version.ts — program version tracking. Bump on every change:
// letters first (0.1a -> 0.1b -> ... -> 0.1z -> 0.2a), i.e. bumpVersion().

export const PROGRAM_VERSION = '0.1d';

/** Bump a semver-ish label: '0.1a' -> '0.1b'; '0.1z' -> '0.2a'. */
export function bumpVersion(v: string): string {
  const m = /^(\d+)\.(\d+)([a-z])$/.exec(v);
  if (m === null) throw new Error(`unrecognized version label: ${v}`);
  const minor = m[2] as string;
  const letter = m[3] as string;
  if (letter !== 'z') {
    return `${m[1]}.${minor}${String.fromCharCode(letter.charCodeAt(0) + 1)}`;
  }
  return `${m[1]}.${Number(minor) + 1}a`;
}
