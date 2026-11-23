import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { buildOpenApiDocument } from '../src/openapi';

// Compile the schemas referenced by the actual published route, including local refs.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const document = buildOpenApiDocument('http://localhost');
export function assertHostingResponse(operation: 'status' | 'usage' | 'ledger', value: unknown) {
  const schema = (document.paths as Record<string, any>)[`/api/v4/hosting-billing/workspaces/{workspaceId}/${operation}`].get.responses['200'].content['application/json'].schema;
  const validate = ajv.compile({ ...schema, components: document.components });
  if (!validate(value)) throw new Error(JSON.stringify(validate.errors));
}
