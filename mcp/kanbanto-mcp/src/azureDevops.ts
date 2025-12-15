function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function normalizeOrgUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error('orgUrl must start with https:// (e.g. https://dev.azure.com/YourOrg)');
  }
  return trimmed;
}

function authHeaderFromPat(pat: string): string {
  // Azure DevOps PAT uses Basic auth with username empty and PAT as password.
  return `Basic ${base64(`:${pat}`)}`;
}

export type AzureDevopsImportOptions = {
  orgUrl: string;
  project: string;
  pat: string;
  wiql?: string;
  workItemTypes?: string[];
  top?: number;
  excludeStates?: string[];
};

type WiqlResponse = {
  workItems?: Array<{ id: number }>;
};

type WorkItem = {
  id: number;
  fields?: Record<string, unknown>;
};

type WorkItemsResponse = {
  value?: WorkItem[];
};

export function buildDefaultWiql(project: string, workItemTypes?: string[]): string {
  const safeProject = project.replace(/'/g, "''");
  const typeClause = (workItemTypes && workItemTypes.length > 0)
    ? ` AND [System.WorkItemType] IN (${workItemTypes.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ')})`
    : '';

  return buildDefaultWiqlWithStateFilter({
    project,
    workItemTypes,
    excludeStates: undefined
  });
}

function buildDefaultWiqlWithStateFilter(params: {
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

export async function queryAssignedToMeWorkItemIds(options: AzureDevopsImportOptions): Promise<number[]> {
  const orgUrl = normalizeOrgUrl(options.orgUrl);
  const project = options.project.trim();
  if (!project) throw new Error('project is required');
  if (!options.pat?.trim()) throw new Error('PAT is required (set AZDO_PAT or pass it explicitly)');

  const query = (options.wiql && options.wiql.trim().length > 0)
    ? options.wiql
    : buildDefaultWiqlWithStateFilter({
      project,
      workItemTypes: options.workItemTypes,
      excludeStates: options.excludeStates
    });

  const url = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeaderFromPat(options.pat)
    },
    body: JSON.stringify({ query })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Azure DevOps WIQL failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as WiqlResponse;
  const ids = (json.workItems ?? []).map((w) => w.id).filter((n) => Number.isFinite(n));
  const top = options.top ?? 200;
  return ids.slice(0, Math.min(Math.max(top, 1), 500));
}

export async function fetchWorkItemsByIds(params: {
  orgUrl: string;
  project: string;
  pat: string;
  ids: number[];
}): Promise<Array<{ id: number; title: string; state?: string; type?: string; url: string; description?: string; acceptanceCriteria?: string[] }>> {
  const orgUrl = normalizeOrgUrl(params.orgUrl);
  const project = params.project.trim();
  if (!project) throw new Error('project is required');

  const ids = Array.from(new Set(params.ids)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return [];

  const fields = [
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.Description',
    'Microsoft.VSTS.Common.AcceptanceCriteria'
  ];

  const url = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(fields.join(','))}&api-version=7.1`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeaderFromPat(params.pat)
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Azure DevOps workitems failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as WorkItemsResponse;
  const items = json.value ?? [];

  function decodeHtmlEntities(input: string): string {
    return input
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => {
        const n = Number(code);
        return Number.isFinite(n) ? String.fromCharCode(n) : _;
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
