// Local to the native relational protocol: preserve unknown JSON numeric lexemes
// through NIP-98 payload parsing, JSONB storage, reads and idempotency receipts.
export function parseNativeJson(text: string): any {
  return (JSON.parse as any)(text, (_key: string,value: unknown,context?: {source?:string}) =>
    typeof value==='number' && context?.source && JSON.stringify(value)!==context.source
      ? (JSON as any).rawJSON(context.source) : value);
}
export function isNativeRawJson(value: unknown): boolean { return (JSON as any).isRawJSON(value); }
