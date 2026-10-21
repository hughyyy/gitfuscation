// identity-map.ts — persistent config mapping machine-local git identities
// (e.g. "bernie <bernie@localhost>") to a real GitHub identity, applied per
// repo. Loaded/written as JSON; validated with explicit errors.

import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type IdentityMatchMode = 'email' | 'name' | 'full';

export interface IdentityRow {
  from: { match: string; mode: IdentityMatchMode };
  to: { name: string; email: string };
}

export interface IdentityMap {
  rows: IdentityRow[];
  fallback: { name: string; email: string } | null;
}

export const DEFAULT_IDENTITY_MAP_PATH = path.join(process.cwd(), 'identity-map.json');

export function defaultIdentityMap(): IdentityMap {
  return { rows: [], fallback: null };
}

const MODES = ['email', 'name', 'full'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a raw identity-map object. Returns the parsed map plus an error
 * list; callers must treat non-empty errors as invalid.
 */
export function parseIdentityMap(raw: unknown): { map: IdentityMap; errors: string[] } {
  const errors: string[] = [];
  const map: IdentityMap = defaultIdentityMap();
  if (raw === undefined || raw === null) return { map, errors };
  if (!isRecord(raw)) {
    return { map, errors: ['identity-map: expected an object'] };
  }
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows)) {
      errors.push('identity-map.rows: expected an array');
    } else {
      raw.rows.forEach((row, i) => {
        const base = `identity-map.rows[${i}]`;
        if (!isRecord(row)) {
          errors.push(`${base}: expected an object`);
          return;
        }
        const from = row.from;
        const to = row.to;
        if (!isRecord(from) || !isRecord(to)) {
          errors.push(`${base}: expected from/to objects`);
          return;
        }
        const rowErrors: string[] = [];
        const match = from.match;
        if (typeof match !== 'string' || match === '') {
          rowErrors.push(`${base}.from.match: expected a non-empty string`);
        }
        const mode = from.mode;
        if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
          rowErrors.push(`${base}.from.mode: must be email | name | full`);
        }
        const name = to.name;
        const email = to.email;
        const nameOk = typeof name === 'string' && name !== '';
        const emailOk = typeof email === 'string' && email !== '';
        if (!nameOk) rowErrors.push(`${base}.to.name: expected a non-empty string`);
        if (!emailOk) rowErrors.push(`${base}.to.email: expected a non-empty string`);
        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          return;
        }
        map.rows.push({
          from: { match: match as string, mode: mode as IdentityMatchMode },
          to: { name: name as string, email: email as string },
        });
      });
    }
  }
  if (raw.fallback !== undefined && raw.fallback !== null) {
    if (!isRecord(raw.fallback)) {
      errors.push('identity-map.fallback: expected an object or null');
    } else {
      const name = raw.fallback.name;
      const email = raw.fallback.email;
      if (typeof name === 'string' && typeof email === 'string' && name !== '' && email !== '') {
        map.fallback = { name, email };
      } else {
        errors.push('identity-map.fallback: requires non-empty name and email');
      }
    }
  }
  return { map, errors };
}

export function loadIdentityMap(file: string = DEFAULT_IDENTITY_MAP_PATH): { map: IdentityMap; errors: string[] } {
  if (!existsSync(file)) return { map: defaultIdentityMap(), errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { map: defaultIdentityMap(), errors: [`cannot parse ${file}: ${(e as Error).message}`] };
  }
  return parseIdentityMap(raw);
}

export function saveIdentityMap(map: IdentityMap, file: string = DEFAULT_IDENTITY_MAP_PATH): void {
  writeFileSync(file, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

/**
 * Resolve an author identity to its replacement. First matching row wins;
 * then the fallback; otherwise unchanged (null).
 */
export function mapIdentity(
  map: IdentityMap,
  name: string,
  email: string,
): { name: string; email: string } | null {
  for (const row of map.rows) {
    const m = row.from;
    if (m.mode === 'email' && email === m.match) return row.to;
    if (m.mode === 'name' && name === m.match) return row.to;
    if (m.mode === 'full' && `${name} <${email}>` === m.match) return row.to;
  }
  return map.fallback ?? null;
}
