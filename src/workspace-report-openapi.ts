const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: 'string', format: 'uuid' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const counts = (...keys: string[]) => object(Object.fromEntries(keys.map(key => [key,count])));
const storage = object({
  format:{type:'string',enum:['workspace-storage-v1']},workspace_id:uuid,scope:{type:'string',enum:['current-workspace']},
  as_of:{type:'string',format:'date-time'},activity_range_applies:{type:'boolean',enum:[false]},
  groups:{type:'array',maxItems:8,items:object({id:{type:'string',maxLength:64},metrics:{type:'array',maxItems:32,
    items:object({id:{type:'string',maxLength:64},value:{...count,nullable:true},unit:{type:'string',enum:['bytes','count']},
      method:{type:'string',maxLength:64},status:{type:'string',enum:['estimated','actual','unavailable']}})}})},
  provider_measured_at:{type:'string',format:'date-time',nullable:true},last_object_completed_at:{type:'string',format:'date-time',nullable:true},
  caveats:{type:'array',maxItems:16,items:{type:'string',maxLength:1024}},
});
const baseSchema = object({
  identity: object({tower_service_npub:{type:'string'},workspace_service_npub:{type:'string'},workspace_owner_npub:{type:'string'},workspace_id:uuid,app_npub:{type:'string'}}),
  format: {type:'string',enum:['workspace-report-v1']}, workspace_id:uuid,
  range:{type:'string',enum:['7d','30d','90d','all']}, from:{type:'string',format:'date-time',nullable:true},
  to:{type:'string',format:'date-time'}, as_of:{type:'string',format:'date-time'}, timezone:{type:'string',enum:['UTC']},
  complete:{type:'boolean',enum:[true]}, channel_policy:{type:'string',enum:['active-project-channels']},
  activity:counts('messages','conversations'),
  inventory:object({channels:count,conversations:count,tasks:object({total:count,open:count,completed:count,archived:count,
    by_state:counts('new','ready','in_progress','review','done','archive','backlog','blocked','archived')}),documents:count,files:count}),
  channels:{type:'array',maxItems:50,items:object({channel_id:uuid,scope_id:uuid,name:{type:'string',maxLength:300},scope_name:{type:'string',maxLength:300},messages:count,conversations:count})},
  ranking:object({total_channels:count,returned_channels:count,has_more:{type:'boolean'},other_messages:count,other_conversations:count}),
  coverage:counts('tasks_channels','documents_channels','files_channels'),
});

export const workspaceReportSchema = { ...baseSchema, properties: { ...baseSchema.properties, storage } };
