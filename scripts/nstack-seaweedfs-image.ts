#!/usr/bin/env bun
// Build, verify, save and load the NStack SeaweedFS image (deploy/seaweedfs): the pinned
// upstream 4.55 image with a patched /usr/bin/weed. Installations reference the image by its
// image ID (sha256:…): unlike a local RepoDigest or tag it survives docker save/load on both
// containerd and classic image stores, and Compose runs it with pull_policy never. Stock
// upstream images are never substituted.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export const SEAWEEDFS_IMAGE_TAG = 'nstack-seaweedfs:4.55-nstack.1';
export const SEAWEEDFS_EXPECTED_LABELS: Record<string, string> = {
  'org.opencontainers.image.title': 'nstack-seaweedfs',
  'org.opencontainers.image.version': '4.55-nstack.1',
  'org.opencontainers.image.revision': 'a98c9e27185cf1003eca095761a39973c60734db',
  'io.nstack.seaweedfs.patches': '0001-s3-serve-octet-stream-for-empty-mime',
};
const REPO_ROOT = resolve(import.meta.dir, '..');
const RECIPE_DIR = join(REPO_ROOT, 'deploy/seaweedfs');

export class SeaweedfsImageError extends Error {}

function docker(args: string[], opts: { stdin?: Blob | 'inherit'; stdout?: 'inherit' } = {}) {
  const r = Bun.spawnSync(['docker', ...args], { stdout: opts.stdout ?? 'pipe', stderr: 'pipe', stdin: opts.stdin ?? 'ignore' });
  return { code: r.exitCode ?? 1, out: r.stdout ? r.stdout.toString() : '', err: r.stderr.toString() };
}

/** Immutable identity of a local image: its image ID. */
export function immutableRef(image: string): string {
  const r = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const id = r.out.trim();
  if (r.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new SeaweedfsImageError(`SeaweedFS image ${image} is not present locally.`);
  return id;
}

/** Identity and provenance of a referenced image; throws unless it is the NStack build. */
export function verifyImage(ref: string) {
  if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
    throw new SeaweedfsImageError(`SEAWEEDFS_IMAGE must be the NStack SeaweedFS image ID (sha256:…), got ${ref || 'nothing'}.`);
  }
  const r = docker(['image', 'inspect', '--format', '{{.Id}} {{json .Config.Labels}}', ref]);
  if (r.code !== 0) throw new SeaweedfsImageError(`SeaweedFS image ${ref} is not present locally; load the saved artifact or rebuild and re-qualify (scripts/nstack-seaweedfs-image.ts).`);
  const space = r.out.indexOf(' ');
  const id = r.out.slice(0, space).trim();
  const labels = JSON.parse(r.out.slice(space + 1)) as Record<string, string>;
  for (const [k, v] of Object.entries(SEAWEEDFS_EXPECTED_LABELS)) {
    if (labels[k] !== v) throw new SeaweedfsImageError(`SeaweedFS image ${ref} label ${k} is ${labels[k] ?? 'missing'}, expected ${v}.`);
  }
  return { ref, id, labels };
}

export function buildImage() {
  const r = docker(['build', '-t', SEAWEEDFS_IMAGE_TAG, RECIPE_DIR], { stdout: 'inherit' });
  if (r.code !== 0) throw new SeaweedfsImageError(`SeaweedFS image build failed: ${r.err.trim().split('\n').slice(-5).join(' | ')}`);
  return verifyImage(immutableRef(SEAWEEDFS_IMAGE_TAG));
}

/** Streamed sha256 (no whole-archive buffering). */
async function sha256File(path: string) {
  const h = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest('hex');
}

/** A complete artifact's manifest, or a SeaweedfsImageError. Never accepts a directory on existence alone. */
export async function validateArtifact(dir: string, expected: { ref: string; id: string }) {
  const manifestPath = join(dir, 'seaweedfs-image.json');
  const tar = join(dir, 'seaweedfs-image.tar');
  if (!existsSync(manifestPath) || !existsSync(tar)) throw new SeaweedfsImageError(`SeaweedFS image artifact ${dir} is incomplete.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'nstack-seaweedfs-image-v1' || manifest.ref !== expected.ref || manifest.id !== expected.id) {
    throw new SeaweedfsImageError(`SeaweedFS image artifact ${dir} is for ${manifest.ref ?? 'unknown'} / ${manifest.id ?? 'unknown'}, not ${expected.ref} / ${expected.id}.`);
  }
  if ((await sha256File(tar)) !== manifest.tar_sha256) throw new SeaweedfsImageError(`SeaweedFS image artifact ${dir} checksum mismatch.`);
  return manifest;
}

/**
 * Save the exact image with a checksum and provenance manifest (restore without rebuild). Written to a
 * temporary sibling and renamed only when complete; an existing directory must validate for this image.
 */
export async function saveImage(ref: string, dir: string) {
  const v = verifyImage(ref);
  if (existsSync(dir)) return validateArtifact(dir, v);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(dir), `.${basename(dir)}.partial-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const tar = join(tmp, 'seaweedfs-image.tar');
    const r = docker(['image', 'save', '--output', tar, ref]);
    if (r.code !== 0) throw new SeaweedfsImageError(`docker image save failed: ${r.err.trim()}`);
    const manifest = {
      format: 'nstack-seaweedfs-image-v1', ref: v.ref, id: v.id, labels: v.labels, tar_sha256: await sha256File(tar),
      recipe: Object.fromEntries(await Promise.all(['Dockerfile', 'patches/0001-s3-serve-octet-stream-for-empty-mime.patch'].map(async (f) => [f, await sha256File(join(RECIPE_DIR, f))]))),
      saved_at: new Date().toISOString(),
    };
    writeFileSync(join(tmp, 'seaweedfs-image.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, dir);
    return manifest;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Load a saved artifact after checking its checksum; the loaded image must be exactly the recorded one. */
export async function loadImage(dir: string) {
  const manifest = JSON.parse(readFileSync(join(dir, 'seaweedfs-image.json'), 'utf8'));
  const tar = join(dir, 'seaweedfs-image.tar');
  if ((await sha256File(tar)) !== manifest.tar_sha256) throw new SeaweedfsImageError('Saved SeaweedFS image checksum mismatch; refusing to load.');
  const r = docker(['image', 'load', '--input', tar]);
  if (r.code !== 0) throw new SeaweedfsImageError(`docker image load failed: ${r.err.trim()}`);
  const v = verifyImage(manifest.id);
  if (v.id !== manifest.id || manifest.ref !== manifest.id) throw new SeaweedfsImageError(`Loaded image ${v.id} is not the recorded ${manifest.ref}.`);
  return v;
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    let out: unknown;
    if (cmd === 'build') out = buildImage();
    else if (cmd === 'ref') out = { ref: immutableRef(a || SEAWEEDFS_IMAGE_TAG) };
    else if (cmd === 'verify') out = verifyImage(a || '');
    else if (cmd === 'save') out = await saveImage(a || '', b || '');
    else if (cmd === 'load') out = await loadImage(a || '');
    else {
      console.error('Usage: bun scripts/nstack-seaweedfs-image.ts build | ref [image] | verify <ref> | save <ref> <dir> | load <dir>');
      process.exit(2);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(err instanceof SeaweedfsImageError ? 10 : 1);
  }
}
