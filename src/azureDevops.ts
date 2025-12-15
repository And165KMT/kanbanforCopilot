import * as https from 'node:https';

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function normalizeOrgUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error('AZDO_ORG_URL must start with https:// (e.g. https://dev.azure.com/YourOrg)');
  }
  return trimmed;
}

function authHeaderFromPat(pat: string): string {
  // Azure DevOps PAT uses Basic auth with username empty and PAT as password.
  return `Basic ${base64(`:${pat}`)}`;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : m;
    });
}

function htmlToText(maybeHtml: unknown): string | undefined {
  if (maybeHtml === null || maybeHtml === undefined) return undefined;
  const raw = String(maybeHtml).trim();
  if (!raw) return undefined;

  const withNewlines = raw
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<\s*\/li\s*>/gi, '\n');

  const withoutTags = withNewlines.replace(/<[^>]+>/g, '');
  const decoded = decodeHtmlEntities(withoutTags);
  const normalized = decoded
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

  return normalized.length > 0 ? normalized : undefined;
}

function splitAcceptanceCriteria(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ''))
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines : undefined;
}

function buildDefaultWiql(params: {
  project: string;
  workItemTypes?: string[];
  excludeStates?: string[];
}): string {
  const safeProject = params.project.replace(/'/g, "''");

  const typeClause = (params.workItemTypes && params.workItemTypes.length > 0)
    ? ` AND [System.WorkItemType] IN (${params.workItemTypes.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ')})`
    : '';

  const excludeStates = (params.excludeStates ?? [])
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);
  const stateClause = (excludeStates.length > 0)
    ? ` AND [System.State] NOT IN (${excludeStates.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')})`
    : '';

  return [
    'SELECT [System.Id], [System.Title], [System.State]',
    'FROM WorkItems',
    `WHERE [System.TeamProject] = '${safeProject}'`,
    '  AND [System.AssignedTo] = @Me',
    typeClause,
    stateClause,
    'ORDER BY [System.ChangedDate] DESC'
  ].filter((s) => s.trim().length > 0).join('\n');
}

async function requestJson(params: {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: any }>{
  const u = new URL(params.url);

  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: `${u.pathname}${u.search}`,
        method: params.method,
        headers: params.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = undefined;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (params.body) req.write(params.body);
    req.end();
  });
}

export type AzureDevopsImportConfig = {
  orgUrl: string;
  project: string;
  pat: string;
  top?: number;
  workItemTypes?: string[];
  excludeStates?: string[];
};

export type AzureWorkItem = {
  id: number;
  title: string;
  state?: string;
  type?: string;
  url: string;
  description?: string;
  acceptanceCriteria?: string[];
};

export async function fetchAssignedToMeWorkItems(config: AzureDevopsImportConfig): Promise<AzureWorkItem[]> {
  const orgUrl = normalizeOrgUrl(config.orgUrl);
  const project = config.project.trim();
  if (!project) throw new Error('AZDO_PROJECT is required');
  const pat = config.pat.trim();
  if (!pat) throw new Error('AZDO_PAT is required');

  const top = config.top ?? 200;
  const query = buildDefaultWiql({
    project,
    workItemTypes: config.workItemTypes,
    excludeStates: config.excludeStates
  });

  const wiqlUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1`;
  const wiqlRes = await requestJson({
    url: wiqlUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeaderFromPat(pat)
    },
    body: JSON.stringify({ query })
  });

  if (wiqlRes.status < 200 || wiqlRes.status >= 300) {
    const msg = typeof wiqlRes.body === 'string' ? wiqlRes.body : JSON.stringify(wiqlRes.body);
    throw new Error(`Azure DevOps WIQL failed (${wiqlRes.status}): ${msg}`);
  }

  const ids = (wiqlRes.body?.workItems ?? [])
    .map((w: any) => Number(w?.id))
    .filter((n: number) => Number.isFinite(n))
    .slice(0, Math.min(Math.max(top, 1), 500));

  if (ids.length === 0) return [];

  const fields = [
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.Description',
    'Microsoft.VSTS.Common.AcceptanceCriteria'
  ];

  const workItemsUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(fields.join(','))}&api-version=7.1`;
  const itemsRes = await requestJson({
    url: workItemsUrl,
    method: 'GET',
    headers: {
      Authorization: authHeaderFromPat(pat)
    }
  });

  if (itemsRes.status < 200 || itemsRes.status >= 300) {
    const msg = typeof itemsRes.body === 'string' ? itemsRes.body : JSON.stringify(itemsRes.body);
    throw new Error(`Azure DevOps workitems failed (${itemsRes.status}): ${msg}`);
  }

  const items = (itemsRes.body?.value ?? []) as Array<{ id: number; fields?: Record<string, unknown> }>;

  return items
    .map((wi) => {
      const title = String(wi.fields?.['System.Title'] ?? '').trim();
      const state = wi.fields?.['System.State'] ? String(wi.fields?.['System.State']) : undefined;
      const type = wi.fields?.['System.WorkItemType'] ? String(wi.fields?.['System.WorkItemType']) : undefined;
      const description = htmlToText(wi.fields?.['System.Description']);
      const acceptanceCriteriaText = htmlToText(wi.fields?.['Microsoft.VSTS.Common.AcceptanceCriteria']);
      const acceptanceCriteria = splitAcceptanceCriteria(acceptanceCriteriaText);
      const id = wi.id;
      return {
        id,
        title: title || `Work Item ${id}`,
        state,
        type,
        url: `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
        description,
        acceptanceCriteria
      };
    })
    .filter((x) => Number.isFinite(x.id));
}
