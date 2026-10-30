import type { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { resolveFlightDeckPgWorkspace } from '../services/flightdeck-pg-authorization';
import { diagnosticUuid, PermissionDiagnosticError, readPermissionDiagnostics } from '../services/permission-diagnostics';

export function registerPermissionDiagnosticRoutes(router: Hono) {
  router.get('/workspaces/:workspaceId/channels/:channelId/permission-diagnostics', async c => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await requireNip98AuthResolved(c);
    if (auth instanceof Response) return auth;
    try {
      const query = new URL(c.req.url).searchParams;
      const allowed = ['target_npub','case_id','limit','offset'];
      if ([...query.keys()].some(k=>!allowed.includes(k) || query.getAll(k).length!==1)) throw new PermissionDiagnosticError(400,'invalid_diagnostic_request');
      const workspaceId = c.req.param('workspaceId');
      if (!diagnosticUuid.test(workspaceId)) throw new PermissionDiagnosticError(400,'invalid_diagnostic_request');
      const workspace = await resolveFlightDeckPgWorkspace(workspaceId);
      const requestedApp = c.req.header('x-flightdeck-pg-app-npub');
      if (!workspace || (requestedApp && requestedApp !== workspace.app_npub)) throw new PermissionDiagnosticError(403,'diagnostic_access_denied');
      const integer = (name:string, fallback:number) => {
        const value=query.get(name); return value===null?fallback:/^(0|[1-9][0-9]*)$/.test(value)?Number(value):NaN;
      };
      return c.json(await readPermissionDiagnostics({workspaceId,channelId:c.req.param('channelId'),signerNpub:auth.signerNpub,userNpub:auth.userNpub,appNpub:workspace.app_npub,
        targetNpub:query.get('target_npub')??'',caseId:query.get('case_id')??'',limit:integer('limit',100),offset:integer('offset',0)}));
    } catch(e) {
      if (e instanceof PermissionDiagnosticError) return c.json({error:e.code,code:e.code,status:e.status},e.status);
      throw e;
    }
  });
}
