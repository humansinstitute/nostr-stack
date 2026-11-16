import { mkdir, readFile, writeFile, link, unlink, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

/** Write once without exposing a partial destination to concurrent starters. */
export async function writeOnce(path: string, contents: string): Promise<boolean> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { await unlink(temporary); }
}

export async function initializeInstallation(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory,0o700);
  const secret = generateSecretKey();
  const state = {
    version: 1,
    database_password: randomBytes(32).toString('hex'),
    storage_access_key: randomBytes(16).toString('hex'),
    storage_secret_key: randomBytes(32).toString('hex'),
    service_nsec: nip19.nsecEncode(secret),
    service_npub: nip19.npubEncode(getPublicKey(secret)),
    // A distinct namespace identity; does not register or consent to an app.
    console_app_npub: nip19.npubEncode(getPublicKey(generateSecretKey())),
    claim_code: randomBytes(24).toString('hex'),
  };
  await writeOnce(join(directory, 'bootstrap.json'), JSON.stringify(state));
  const saved = JSON.parse(await readFile(join(directory, 'bootstrap.json'), 'utf8')) as typeof state;
  if (saved.version !== 1) throw new Error('Unsupported installation state');
  if(!/^[a-f0-9]{64}$/.test(saved.database_password)||!/^[a-f0-9]{32}$/.test(saved.storage_access_key)||!/^[a-f0-9]{64}$/.test(saved.storage_secret_key)||!/^[a-f0-9]{48}$/.test(saved.claim_code))throw Error('Invalid protected bootstrap state; refusing regeneration');
  const decoded=nip19.decode(saved.service_nsec);
  if(decoded.type!=='nsec'||nip19.npubEncode(getPublicKey(decoded.data))!==saved.service_npub)throw Error('Invalid protected service identity');
  const app=nip19.decode(saved.console_app_npub);if(app.type!=='npub')throw Error('Invalid console namespace');
  // Values are generated hex/bech32, never arbitrary user shell input.
  const assignments = {
    NSTACK_SETUP_DIRECTORY: '/run/nstack',
    DB_HOST: 'postgres', DB_NAME: 'nstack', DB_USER: 'nstack', DB_PASSWORD: saved.database_password,
    STORAGE_S3_ENDPOINT: 'http://minio:9000', STORAGE_S3_ENDPOINT_PUBLIC: '',
    STORAGE_S3_ACCESS_KEY: saved.storage_access_key, STORAGE_S3_SECRET_KEY: saved.storage_secret_key,
    STORAGE_S3_BUCKET: 'nstack',
    SUPERBASED_SERVICE_NSEC: saved.service_nsec, SUPERBASED_SERVICE_NPUB: saved.service_npub,
    FLIGHT_DECK_PG_APP_NPUB: saved.console_app_npub,
  };
  const runtime=join(directory,`runtime.${randomBytes(12).toString('hex')}.tmp`);
  await writeFile(runtime,Object.entries(assignments).map(([k,v]) => `${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
  await rename(runtime,join(directory,'runtime.env'));
  return { service_npub: saved.service_npub };

}

if (import.meta.main) {
  if(process.env.NSTACK_UNSUPPORTED_OVERRIDES)throw Error('Generated-install credentials cannot be overridden. Use the existing env deployment or a reviewed explicit adoption; bootstrap unchanged.');
  const directory=process.env.NSTACK_SETUP_DIRECTORY || '/run/nstack';
  await initializeInstallation(directory);
  const state=JSON.parse(await readFile(join(directory,'bootstrap.json'),'utf8'));
  for(const [dir, values] of [
    ['/run/nstack-db',{DB_USER:'nstack',DB_NAME:'nstack',DB_PASSWORD:state.database_password}],
    ['/run/nstack-storage',{STORAGE_S3_ACCESS_KEY:state.storage_access_key,STORAGE_S3_SECRET_KEY:state.storage_secret_key,STORAGE_S3_BUCKET:'nstack'}],
  ] as const){
    await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
    await writeOnce(join(dir,'runtime.env'),Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  }
  console.log('NStack bootstrap ready. Retrieve the one-time claim code locally with the documented setup command.');
}
