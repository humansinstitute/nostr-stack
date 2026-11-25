import { spawn } from 'node:child_process';
import { constants as C, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { HostingError } from './hosting-billing';
import type { RecoveryVault } from './hosting-recovery';

/** Encrypted FILESYSTEM adapter for the `RecoveryVault` port, built on the established `age` format and CLI (no homegrown cryptography).
 *  - NStack holds only a PUBLIC age recipient chosen by the trusted operator. It never sees, searches for or stores a private identity, so by
 *    itself this adapter can encrypt but cannot decrypt. `restoreIdentity` therefore needs a separate trusted, isolated decrypt port; with none
 *    configured it fails closed and a copy can never become `restore_verified`.
 *  - Its provenance is permanently `test`. A byte roundtrip, a public recipient and a readable ciphertext are not proof that a COMPLETE workspace
 *    can be restored, so this adapter can never make `accountRecoveryState().promised` or `removalGate()` allow. Promoting a copy to production
 *    needs a separate authenticated complete-snapshot + isolated-restore attestation under the gate, which does not exist yet.
 *  - It reads no live workspace data: the snapshot bytes are supplied by an authorised producer through `sealRecoveryCopy`.
 *  Layout under the operator's root: `<uuid>.age` (ciphertext) and `<uuid>.manifest.json` (immutable digests); both mode 0400, never overwritten. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/; // native X25519 recipient (bech32 data alphabet)
const REF = /^agevault:([0-9a-f-]{36})$/;
const HEADER = Buffer.from('age-encryption.org/v1\n');
const HEX64 = /^[0-9a-f]{64}$/;
export const AGE_VAULT_LIMITS = { maxPlaintextBytes: 1 << 30, maxObjects: 1000, maxTimeoutMs: 600_000, manifestMaxBytes: 4096 } as const;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fail = (code: string, status = 502) => new HostingError(status, code);

export interface IsolatedRestoreResult { plaintextSha256: string; plaintextBytes: number }
/** Trusted, isolated decrypt-and-measure port: receives verified ciphertext bytes, must never write plaintext into live tables or return it. */
export type IsolatedRestore = (ciphertext: Uint8Array) => Promise<IsolatedRestoreResult>;

export interface AgeVaultOptions {
  /** Absolute, operator-chosen directory OUTSIDE agent/runtime data: an existing real directory (no symlinks in the path) owned by this user with no group/other access. */
  rootDir: string;
  /** Operator-provided PUBLIC age recipient (`age1…`). Identities (`AGE-SECRET-KEY-…`) are refused. */
  recipient: string;
  /** Absolute path of the age executable. Never resolved through PATH. */
  ageBin: string;
  /** Directories the root must neither sit inside nor contain (agent working copy, runtime data dirs). The current working directory is always forbidden. */
  forbiddenRoots?: string[];
  isolatedRestore?: IsolatedRestore;
  maxPlaintextBytes?: number; maxObjects?: number; timeoutMs?: number;
}
interface Manifest { v: 1; format: 'age-v1-x25519'; id: string; workspace_id: string; sealed_at: string; plaintext_sha256: string; plaintext_bytes: number; ciphertext_sha256: string; ciphertext_bytes: number; key_ref: string }
const MANIFEST_KEYS = ['ciphertext_bytes', 'ciphertext_sha256', 'format', 'id', 'key_ref', 'plaintext_bytes', 'plaintext_sha256', 'sealed_at', 'v', 'workspace_id'];

function run(bin: string, args: string[], input: Uint8Array, timeoutMs: number, maxOut: number, onChunk?: (c: Buffer) => void): Promise<{ out: Buffer }> {
  return new Promise((ok, no) => {
    // Minimal environment: nothing from the parent (no AGE_* or key-path variables) reaches the child; stderr is drained and never surfaced.
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const chunks: Buffer[] = []; let size = 0, done = false;
    const end = (e: Error | null) => { if (done) return; done = true; clearTimeout(timer); if (e) { child.kill('SIGKILL'); no(e); } };
    const timer = setTimeout(() => end(fail('recovery_vault_timeout')), timeoutMs);
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size > maxOut) return end(fail('recovery_vault_output_too_large')); if (onChunk) onChunk(c); else chunks.push(c); });
    child.stderr.on('data', () => {});
    child.on('error', () => end(fail('recovery_vault_exec_failed')));
    child.on('close', code => { if (done) return; if (code !== 0) return end(fail('recovery_vault_exec_failed')); done = true; clearTimeout(timer); ok({ out: Buffer.concat(chunks) }); });
    child.stdin.on('error', () => {}); child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

function readNoFollow(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes || (process.getuid && st.uid !== process.getuid())) throw fail('recovery_object_invalid');
    const buf = Buffer.alloc(st.size); let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    if (off !== buf.length) throw fail('recovery_object_invalid');
    return buf;
  } finally { closeSync(fd); }
}
function syncDir(dir: string) { const fd = openSync(dir, C.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

/** Validates the trusted configuration and returns the vault. Throws a stable code on any unsafe input; nothing is created or searched for. */
export function openAgeRecoveryVault(o: AgeVaultOptions): RecoveryVault & { readonly provenance: 'test'; objectCount(): number } {
  if (typeof o.recipient !== 'string' || !RECIPIENT.test(o.recipient)) throw fail('recovery_vault_config_invalid', 500);
  if (typeof o.ageBin !== 'string' || !isAbsolute(o.ageBin)) throw fail('recovery_vault_config_invalid', 500);
  try { if (!statSync(o.ageBin).isFile() || (statSync(o.ageBin).mode & 0o111) === 0) throw 0; } catch { throw fail('recovery_vault_config_invalid', 500); }
  if (typeof o.rootDir !== 'string' || !isAbsolute(o.rootDir) || o.rootDir !== resolve(o.rootDir)) throw fail('recovery_vault_config_invalid', 500);
  let real: string;
  try {
    const l = lstatSync(o.rootDir);
    real = realpathSync(o.rootDir);
    if (l.isSymbolicLink() || !l.isDirectory() || real !== o.rootDir || (l.mode & 0o077) !== 0 || (process.getuid && l.uid !== process.getuid())) throw 0;
  } catch { throw fail('recovery_vault_config_invalid', 500); }
  const forbidden = [process.cwd(), ...(o.forbiddenRoots ?? [])].map(p => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } });
  if (forbidden.some(f => inside(real, f) || inside(f, real))) throw fail('recovery_vault_config_invalid', 500);

  const root = real;
  const maxPlain = Math.min(AGE_VAULT_LIMITS.maxPlaintextBytes, Math.max(1, Math.floor(o.maxPlaintextBytes ?? 256 << 20)));
  const maxObjects = Math.min(AGE_VAULT_LIMITS.maxObjects, Math.max(1, Math.floor(o.maxObjects ?? 64)));
  const timeoutMs = Math.min(AGE_VAULT_LIMITS.maxTimeoutMs, Math.max(1000, Math.floor(o.timeoutMs ?? 60_000)));
  const maxCipher = maxPlain + (1 << 20);
  const keyRef = `age-recipient:${sha256(Buffer.from(o.recipient)).slice(0, 16)}`;
  const ciphertextPath = (id: string) => join(root, `${id}.age`), manifestPath = (id: string) => join(root, `${id}.manifest.json`);
  const objects = () => readdirSync(root).filter(n => /^[0-9a-f-]{36}\.age$/.test(n)).length;
  let queue: Promise<unknown> = Promise.resolve();

  /** Loads and fully re-verifies one stored object (strict ref, no symlink following, immutable manifest, ciphertext digest). */
  function load(objectRef: string) {
    const m = typeof objectRef === 'string' ? REF.exec(objectRef) : null;
    if (!m || !UUID.test(m[1]!)) throw fail('recovery_object_invalid');
    const id = m[1]!;
    let manifest: Manifest, cipher: Buffer;
    try {
      manifest = JSON.parse(readNoFollow(manifestPath(id), AGE_VAULT_LIMITS.manifestMaxBytes).toString('utf8'));
      cipher = readNoFollow(ciphertextPath(id), maxCipher);
    } catch (e) { if (e instanceof HostingError) throw e; throw fail('recovery_object_missing'); }
    if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).sort().join() !== MANIFEST_KEYS.join() || manifest.id !== id || manifest.v !== 1 || manifest.format !== 'age-v1-x25519'
      || !HEX64.test(manifest.ciphertext_sha256) || !HEX64.test(manifest.plaintext_sha256)) throw fail('recovery_object_invalid');
    if (cipher.length !== manifest.ciphertext_bytes || sha256(cipher) !== manifest.ciphertext_sha256 || !cipher.subarray(0, HEADER.length).equals(HEADER)) throw fail('recovery_object_tampered');
    return { id, manifest, cipher };
  }

  async function sealOne(input: { workspaceId: string; plaintext: Uint8Array }) {
    const { workspaceId, plaintext } = input;
    if (!UUID.test(String(workspaceId)) || !(plaintext instanceof Uint8Array) || plaintext.byteLength < 1 || plaintext.byteLength > maxPlain) throw fail('recovery_vault_input_invalid', 400);
    if (objects() >= maxObjects) throw fail('recovery_vault_full', 507);
    const { out } = await run(o.ageBin, ['-r', o.recipient], plaintext, timeoutMs, maxCipher);
    if (!out.subarray(0, HEADER.length).equals(HEADER) || out.length <= plaintext.byteLength || (plaintext.byteLength >= 16 && out.includes(Buffer.from(plaintext)))) throw fail('recovery_vault_invalid');
    const id = randomUUID();
    const manifest: Manifest = { v: 1, format: 'age-v1-x25519', id, workspace_id: workspaceId, sealed_at: new Date().toISOString(), plaintext_sha256: sha256(plaintext), plaintext_bytes: plaintext.byteLength, ciphertext_sha256: sha256(out), ciphertext_bytes: out.length, key_ref: keyRef };
    const tmp = (n: string) => join(root, `.tmp-${randomUUID()}-${n}`);
    const staged: string[] = [], published: string[] = [];
    // Write to a temp name, fsync, then hard-link into place: link() never replaces an existing object, so nothing is ever overwritten.
    const publish = (final: string, bytes: Uint8Array) => {
      const t = tmp('x'); staged.push(t);
      const fd = openSync(t, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(t, 0o400); linkSync(t, final); published.push(final); unlinkSync(t);
    };
    try {
      publish(ciphertextPath(id), out); publish(manifestPath(id), Buffer.from(JSON.stringify(manifest)));
      syncDir(root);
      const back = load(`agevault:${id}`); // readback of what is actually on disk
      if (back.manifest.ciphertext_sha256 !== manifest.ciphertext_sha256 || !back.cipher.equals(out)) throw fail('recovery_vault_invalid');
    } catch (e) {
      for (const p of [...staged, ...published]) { try { unlinkSync(p); } catch { /* already gone */ } }
      throw e instanceof HostingError ? e : fail('recovery_vault_write_failed');
    }
    return { objectRef: `agevault:${id}`, keyRef, ciphertextSha256: manifest.ciphertext_sha256, ciphertextBytes: manifest.ciphertext_bytes };
  }

  return {
    provenance: 'test',
    objectCount: objects,
    seal(input) { const p = queue.then(() => sealOne(input)); queue = p.catch(() => {}); return p; },
    async restoreIdentity(objectRef) {
      const { cipher } = load(objectRef); // tamper or substitution fails here, before anything is decrypted
      if (!o.isolatedRestore) throw fail('recovery_restore_unconfigured', 503);
      const got = await o.isolatedRestore(new Uint8Array(cipher));
      if (!got || !HEX64.test(got.plaintextSha256) || !Number.isSafeInteger(got.plaintextBytes) || got.plaintextBytes < 0) throw fail('recovery_restore_invalid');
      return { plaintextSha256: got.plaintextSha256, plaintextBytes: got.plaintextBytes };
    },
    async destroy(objectRef) {
      const m = typeof objectRef === 'string' ? REF.exec(objectRef) : null;
      if (!m || !UUID.test(m[1]!)) throw fail('recovery_object_invalid');
      for (const p of [ciphertextPath(m[1]!), manifestPath(m[1]!)]) {
        let st; try { st = lstatSync(p); } catch { continue; } // already destroyed: idempotent
        if (!st.isFile()) throw fail('recovery_object_invalid'); // a symlink or directory under the name is never followed or removed
        unlinkSync(p);
      }
      syncDir(root);
    },
  };
}

/** Decrypt-and-measure port for a trusted ISOLATED restore host: runs `age -d` with an operator-held identity file (path supplied by the operator,
 * read by age only) and returns just the plaintext identity, streaming so plaintext is never retained or written. NStack must not run this next to the
 * live database with a production identity; tests use a synthetic identity. */
export function ageIdentityRestore(o: { ageBin: string; identityPath: string; maxPlaintextBytes?: number; timeoutMs?: number }): IsolatedRestore {
  if (!isAbsolute(o.ageBin) || !isAbsolute(o.identityPath)) throw fail('recovery_vault_config_invalid', 500);
  const maxPlain = Math.min(AGE_VAULT_LIMITS.maxPlaintextBytes, Math.max(1, Math.floor(o.maxPlaintextBytes ?? 256 << 20)));
  const timeoutMs = Math.min(AGE_VAULT_LIMITS.maxTimeoutMs, Math.max(1000, Math.floor(o.timeoutMs ?? 60_000)));
  return async ciphertext => {
    const h = createHash('sha256'); let bytes = 0;
    await run(o.ageBin, ['-d', '-i', o.identityPath], ciphertext, timeoutMs, maxPlain, c => { bytes += c.length; h.update(c); });
    return { plaintextSha256: h.digest('hex'), plaintextBytes: bytes };
  };
}
