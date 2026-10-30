const parameters = [
  {name:'workspaceId',in:'path',required:true,schema:{type:'string',format:'uuid'}},
  {name:'actorId',in:'path',required:true,schema:{type:'string',format:'uuid'}},
];
const responses = {
  '200':{description:'Canonical exact actor identity and administration result; audit returned for mutations'},
  '400':{description:'Malformed UUID/JSON or exact npub confirmation missing'},
  '403':{description:'Current membership/authority required; role and removal require canonical workspace owner; self/owner removal forbidden'},
  '404':{description:'Target is not a current member of this workspace'},
  '409':{description:'Preview expired, consumed, stale or bound to another requester/target/workspace'},
};
const confirmedNpub = {type:'string',description:'Full canonical npub of the selected actor; never inferred from display name'};
const body = (properties: Record<string,unknown>,required: string[])=>({required:true,content:{'application/json':{schema:{type:'object',properties,required}}}});
const base='/api/v4/flightdeck-pg/workspaces/{workspaceId}/members/{actorId}';
export const workspaceMembershipAdminPaths = {
  [`${base}/access`]:{get:{tags:['Flight Deck PG'],summary:'Inspect exact member effective permission coverage',description:'Requires workspace.manage, including self inspection. Returns actor, membership, agent_manager, can_administer and coverage.workspace/scopes/channels with each permission and allowed boolean. Includes all active scopes/channels, including private channels, so ordinary members cannot use it to discover private names. can_administer means canonical owner, not existing workspace.manage. An agent-manager receives existing/future scope and channel permissions plus workspace.read/manage/invite, event_subscription.manage and scope.create; no org-data, napplet, personal daily-note, global or cross-workspace rights.',parameters,responses}},
  [`${base}/removal-preview`]:{post:{tags:['Flight Deck PG'],summary:'Preview workspace retirement without changing membership',description:'Canonical workspace owner only. Returns preview.actor, membership, direct groups/grants, inherited grants, role, subscriptions, consequences, blocked_reason and a requester/identity/access-state-bound ten-minute confirmation_token. Self and all owner identities are protected. No identity/key deletion or automatic permission transfer.',parameters,requestBody:body({},[]),responses}},
  [`${base}/remove`]:{post:{tags:['Flight Deck PG'],summary:'Confirm workspace member removal',description:'Canonical owner only. Transactionally validates preview/npub, records retirement tombstone and audit snapshot, revokes workspace publication authority, then removes membership with direct grants, groups, role and subscription access. Historical actors/authorship/content/audits and other workspaces survive. Explicit re-enrollment never revives old grants. Old presigned object-store URLs issued before this release must expire; previously downloaded bytes cannot be recalled.',parameters,requestBody:body({confirmation_token:{type:'string',format:'uuid'},confirm_npub:confirmedNpub},['confirmation_token','confirm_npub']),responses}},
  [`${base}/agent-manager`]:{put:{tags:['Flight Deck PG'],summary:'Explicitly assign or revoke workspace agent-manager',description:'Canonical workspace owner and existing human/agent identity required (legacy bot identities may be human-kind; global kind is unchanged). Exact npub and enabled boolean required. Creates tagged grants for current/future scopes/channels without broadening existing workspace.manage grants. Revocation revokes role-created grants, preserving independently assigned grants. Feature deployment assigns no roles automatically.',parameters,requestBody:body({enabled:{type:'boolean'},confirm_npub:confirmedNpub},['enabled','confirm_npub']),responses}},
};
