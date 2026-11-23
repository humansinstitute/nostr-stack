// Shared protocol v3, aligned with Ambulando runtime-protocol.js. Fixture parity is tested.
// Portable v2 contract. v1 adapters deliberately do not use these parsers.
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw Error('Invalid generic napplet contract.'); };
const scalar = s => typeof s === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const controls = s => Array.from(s).some(c => c.codePointAt(0)<32 || c.codePointAt(0)>=127 && c.codePointAt(0)<=159);
const utf8 = s => new TextEncoder().encode(s).length;
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function canonical(value) {
  const compare = (a,b) => {const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)-y[i].codePointAt(0);if(d)return d;}return x.length-y.length;};
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort(compare).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export async function sha256(value) { const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
export function validateJson(value) {
  let nodes=0;
  const visit=(v,depth)=>{
    if(++nodes>50000||depth>32)fail();
    if(v===null||typeof v==='boolean')return;
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0)||Math.abs(v)>Number.MAX_SAFE_INTEGER)fail();return;}
    if(typeof v==='string'){if(!scalar(v)||utf8(v)>65536)fail();return;}
    if(!v||typeof v!=='object'||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))fail();
    if(Array.isArray(v)){
      // Structured-clone can carry sparse/extended arrays that JSON cannot.
      // Bound length before key enumeration or canonical serialization.
      if(v.length>50000)fail();
      const keys=Object.keys(v);
      if(keys.length!==v.length||keys.some((key,index)=>key!==String(index)))fail();
    }
    for(const k of Object.keys(v)){if(unsafe.has(k)||!scalar(k)||utf8(k)>65536)fail();visit(v[k],depth+1);}
  };
  if(!value||typeof value!=='object'||Array.isArray(value))fail();visit(value,1);
  if(utf8(canonical(value))>1048576)fail();return value;
}
// Token scan rejects duplicate keys before JSON.parse loses that information.
export function decodeJson(source) {
  if(typeof source!=='string'||utf8(source)>1048576||source.charCodeAt(0)===0xfeff)fail();
  let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(source[i]||'!'))i++;};
  const str=()=>{const start=i++;while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source[i++]==='"')return JSON.parse(source.slice(start,i));}fail();};
  let count=0;
  const scan=(depth)=>{if(depth>32||++count>50000)fail();ws();const c=source[i];
    if(c==='{'||c==='['){i++;ws();const end=c==='{'?'}':']',keys=new Set();if(source[i]===end){i++;return;}while(i<source.length){if(c==='{'){if(source[i]!=='"')fail();const key=str();if(keys.has(key))fail();keys.add(key);ws();if(source[i++]!==':')fail();}scan(depth+1);ws();if(source[i]===end){i++;return;}if(source[i++]!==',')fail();ws();}fail();}
    if(c==='"'){str();return;}const m=source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);if(!m)fail();i+=m[0].length;
  };scan(1);ws();if(i!==source.length)fail();return validateJson(JSON.parse(source));
}

export const RUNTIME_VERSION = 3;
export const COLLECTION_OPERATIONS = Object.freeze(['list', 'get', 'create', 'update', 'delete']);
export const PERSONAL_CAPABILITIES = Object.freeze({
  'nostr-dm': Object.freeze(['read', 'decrypt', 'send', 'persist', 'agent']),
});
const name = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(s);
const recordId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);
const positive = n => Number.isSafeInteger(n) && n > 0;
const safeText = (s, max) => typeof s === 'string' && [...s].length > 0 && [...s].length <= max && !/[\p{Cc}\p{Cs}]/u.test(s);
const unique = a => Array.isArray(a) && a.length <= 64 && new Set(a).size === a.length;
const manifestFail = () => { throw Error('Invalid napplet runtime contract.'); };
export function validateRuntimeManifest(value) {
  validateJson(value);
  if (!exact(value, ['version','napplet_id','bundle_version','title','icon','runtime','collections','capabilities']) || value.version !== 3 || !name(value.napplet_id) || !safeText(value.bundle_version,64) || !safeText(value.title,80) || !safeText(value.icon,8) || /[<>:/\\]/u.test(value.icon)) manifestFail();
  if (!exact(value.runtime,['protocol','min_host']) || value.runtime.protocol !== 3 || !positive(value.runtime.min_host)) manifestFail();
  for (const entries of [value.collections,value.capabilities]) if (!entries || Array.isArray(entries) || typeof entries !== 'object' || Object.keys(entries).length > 32) manifestFail();
  for (const [key,c] of Object.entries(value.collections)) {
    if (!name(key) || !exact(c,['scope','schema_version','operations']) || !['personal','team'].includes(c.scope) || !positive(c.schema_version) || !unique(c.operations) || !c.operations.length || c.operations.some(op => !COLLECTION_OPERATIONS.includes(op))) manifestFail();
  }
  for (const [key,c] of Object.entries(value.capabilities)) {
    if (!name(key) || !exact(c,['version','resources','operations']) || !positive(c.version) || !unique(c.resources) || c.resources.some(r=>!safeText(r,2048)) || !unique(c.operations) || !c.operations.length || c.operations.some(op=>!name(op))) manifestFail();
  }
  return JSON.parse(canonical(value));
}
export function parseRuntimeManifest(html) {
  const matches = [...String(html).matchAll(/<script\b[^>]*[\t\n\f\r ]id\s*=\s*["']wingman-napplet-manifest["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (matches.length !== 1) manifestFail();
  return validateRuntimeManifest(decodeJson(matches[0][1]));
}
// Schema changes need compatibility review even without a new read/write grant.
export function runtimeAccess(manifest) {
  const m = validateRuntimeManifest(manifest);
  return {collections:m.collections,capabilities:m.capabilities};
}
export function accessExpansion(approved, requested) {
  const changes = [];
  for (const [key,c] of Object.entries(requested.collections)) {
    const old = approved?.collections?.[key];
    if (!old || old.scope !== c.scope || old.schema_version !== c.schema_version || c.operations.some(op=>!old.operations.includes(op))) changes.push(`collection:${key}`);
  }
  for (const [key,c] of Object.entries(requested.capabilities)) {
    const old = approved?.capabilities?.[key];
    if (!old || old.version !== c.version || c.operations.some(op=>!old.operations.includes(op)) || c.resources.some(r=>!old.resources.includes(r))) changes.push(`capability:${key}`);
  }
  return changes;
}
