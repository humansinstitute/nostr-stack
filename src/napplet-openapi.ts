/** Shared API v1 envelopes carry the separately versioned portable manifest v3. */
export function nappletOpenApiPaths() {
  const root = '/api/v4/flightdeck-pg/workspaces/{workspaceId}/apps/{appNpub}/napplets';
  const paths: Record<string, any> = {};
  const str = { type: 'string' }, revision = { type: 'integer', minimum: 0, maximum: 2147483646 };
  const bundle = { type: 'object', additionalProperties: false, required: ['file_id', 'file_version_id', 'sha256_hex'], properties: { file_id: { type: 'string', format: 'uuid' }, file_version_id: { type: 'string', format: 'uuid' }, sha256_hex: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
  const npubs = { type: 'array', maxItems: 200, uniqueItems: true, items: str };
  const declaration = { type: 'object', additionalProperties: false, required: ['scope','schema_version','operations'], properties: {
    scope: { enum: ['personal','team'] }, schema_version: { type:'integer', minimum:1 }, operations: { type:'array', minItems:1, uniqueItems:true, items:{enum:['list','get','create','update','delete']} },
  } };
  const manifest = { type:'object', additionalProperties:false, required:['version','napplet_id','bundle_version','title','icon','runtime','collections','capabilities'], properties:{
    version:{const:3}, napplet_id:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'}, bundle_version:{type:'string',minLength:1,maxLength:64},title:{type:'string',minLength:1,maxLength:80},icon:{type:'string',minLength:1,maxLength:8},
    runtime:{type:'object',additionalProperties:false,required:['protocol','min_host'],properties:{protocol:{const:3},min_host:{type:'integer',minimum:1}}},
    collections:{type:'object',maxProperties:32,additionalProperties:declaration}, capabilities:{type:'object',maxProperties:32,additionalProperties:{type:'object',additionalProperties:false,required:['version','resources','operations'],properties:{version:{type:'integer',minimum:1},resources:{type:'array',maxItems:64,uniqueItems:true,items:{type:'string',minLength:1,maxLength:2048}},operations:{type:'array',minItems:1,maxItems:64,uniqueItems:true,items:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'}}}}},
  } };
  function add(method:string, suffix:string, summary:string, envelope:string, properties?:Record<string,any>, required:string[]=[], paginated=false) {
    const path=root+suffix;
    const params=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:str}));
    if(paginated) params.push(...([{name:'limit',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:200,default:50}},{name:'after',in:'query',required:false,schema:str}] as any));
    const response = envelope === 'bytes' ? {
      description: 'Verified immutable HTML download; attachment, nosniff, no-store',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    } : {
      description: envelope,
      content: { 'application/json': { schema: {
        type: 'object', required: [envelope, ...(paginated ? ['next_cursor'] : [])],
        properties: {
          [envelope]: paginated ? { type: 'array', items: { type: 'object' } } : { type: 'object' },
          ...(paginated ? { next_cursor: { type: ['string', 'null'] } } : {}),
        },
      } } },
    };
    const operation:any={tags:['Napplets'],summary,description:'Canonical wire details and exact response fixtures: docs/contract/napplet-runtime-v1.md and tests/fixtures/napplet-api-v1.json. NIP-98 required; server rechecks current membership, audience and independent data grants. Online only. No signer or DM capability is provided.',security:[{nip98:[]}],parameters:params,responses:{'200':response,'400':{description:'Invalid exact JSON contract'},'403':{description:'Authority denied'},'404':{description:'Unavailable to this identity'},'409':{description:'Revision, schema, integrity or identity conflict'},'413':{description:'Request or record exceeds bounded JSON budget'}}};
    if(method==='post' && suffix==='/{nappletId}/collections') { operation.responses['201']=operation.responses['200']; delete operation.responses['200']; }
    if(properties) operation.requestBody={required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required,properties}}}};
    (paths[path]??={})[method]=operation;
  }
  add('get','','Discover audience-visible installations','installations',undefined,[],true);
  add('put','/{nappletId}','Install once, or reconnect retained data after removal','installation',{expected_revision:revision,requester_npub:str,publisher_npub:str,display_name:str,bundle,manifest,delegation_id:str},['expected_revision','requester_npub','publisher_npub','display_name','bundle','manifest']);
  add('get','/{nappletId}','Read installation and active/pending release declarations','installation');
  add('patch','/{nappletId}','Change audience independently of data grants','installation',{expected_revision:revision,display_name:str,audience_npubs:npubs,delegation_id:str},['expected_revision']);
  add('delete','/{nappletId}','Remove and explicitly keep or delete owned collection data','installation',{expected_revision:revision,data:{enum:['keep','delete']},confirm_napplet_id:str,delegation_id:str},['expected_revision','data']);
  add('get','/{nappletId}/bundle','Download only the active audience-authorized bundle','bytes');
  add('get','/{nappletId}/releases','List retained immutable releases','releases',undefined,[],true);
  add('post','/{nappletId}/releases','Publisher update; expanded access remains pending','installation',{expected_revision:revision,bundle,manifest},['expected_revision','bundle','manifest']);
  add('post','/{nappletId}/releases/approve','Human manager approves pending declarations, never personal capabilities','installation',{expected_revision:revision,delegation_id:str},['expected_revision']);
  add('get','/{nappletId}/collections','List independently authorized collections','collections',undefined,[],true);
  add('post','/{nappletId}/collections','Create a named personal or explicitly shared team collection','collection',{name:str,scope:{enum:['personal','team']},schema_version:{type:'integer',minimum:1},read_npubs:npubs,write_npubs:npubs},['name','scope','schema_version']);
  add('patch','/{nappletId}/collections/{collectionId}','Owner replaces explicit read/write grants; supports revocation','collection',{expected_revision:revision,read_npubs:npubs,write_npubs:npubs},['expected_revision']);
  const records='/{nappletId}/collections/{collectionId}/records';
  add('get',records,'Bounded record-ID keyset query','records',undefined,[],true);
  add('get',records+'/{recordId}','Read current record or tombstone','record');
  add('put',records+'/{recordId}','Create at revision zero or update exact current revision','record',{expected_revision:revision,schema_version:{type:'integer',minimum:1},data:{type:'object',description:'Safe JSON object, max 256 KiB'}},['expected_revision','schema_version','data']);
  add('delete',records+'/{recordId}','Revision-checked tombstone with retained history','record',{expected_revision:revision},['expected_revision']);
  add('get',records+'/{recordId}/history','Read authorized retained record revisions','versions',undefined,[],true);
  add('post','/{nappletId}/collections/{collectionId}/migrations','Atomic compatible create-only File import, preserving source history','collection',{expected_revision:revision,from_schema_version:{type:'integer',minimum:1},to_schema_version:{type:'integer',minimum:1},compatible:{const:true},source:bundle,records:{type:'array',minItems:1,maxItems:200,items:{type:'object',additionalProperties:false,required:['id','data'],properties:{id:str,data:{type:'object'}}}}},['expected_revision','from_schema_version','to_schema_version','compatible','source','records']);
  return paths;
}
