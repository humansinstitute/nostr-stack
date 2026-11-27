const base = '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/native-v1/{workspaceId}';
const actions = ['deployment','policy','batch','query','read','fence','authority','status'];
export const appDbNativePaths = Object.fromEntries(actions.map(action => [`${base}/${action}`, {post:{
  tags:['App database'],summary:`Registered native relational v1: ${action}`,
  description:'Actor NIP-98 authorization; exact owner/app/workspace binding. See docs/contract/app-db-native-v1.md. No app signing key in native clients.',
  security:[{nip98:[]}],parameters:['workspaceOwnerNpub','appNpub','workspaceId'].map(name=>({name,in:'path',required:true,schema:{type:'string'}})),
  requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:true}}}},
  responses:{'200':{description:'Versioned native result'},'400':{description:'Invalid bounded request'},'403':{description:'Permission or scope denied'},'409':{description:'CAS, receipt, authority, source fence or snapshot conflict'}}
}}]));
