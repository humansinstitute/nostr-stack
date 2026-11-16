import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { writeOnce } from './bootstrap';

export function installedAdmin(directory = process.env.NSTACK_SETUP_DIRECTORY): string {
  if (!directory) return '';
  try { return JSON.parse(readFileSync(join(directory, 'claim.json'), 'utf8')).admin_npub; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error('Cannot read installation ownership; refusing to reset');
  }
}

export async function claimInstallation(directory: string, code: string, signer: string): Promise<boolean> {
  if (!/^[a-f0-9]{48}$/.test(code)) return false;
  const bootstrap = JSON.parse(await readFile(join(directory, 'bootstrap.json'), 'utf8'));
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(code), digest(bootstrap.claim_code))) return false;
  return writeOnce(join(directory, 'claim.json'), JSON.stringify({version:1, admin_npub:signer, claimed_at:new Date().toISOString()}));
}
