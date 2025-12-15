import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AddTaskInputSchema,
  AzureDevopsImportAssignedToMeInputSchema,
  DeleteTaskInputSchema,
  ListTasksInputSchema,
  MoveTaskInputSchema,
  ReorderColumnInputSchema,
  UpdateColumnsInputSchema,
  UpdateTaskInputSchema
} from './schema.js';
import { BoardStore } from './boardStore.js';
import dotenv from 'dotenv';
import { fetchWorkItemsByIds, queryAssignedToMeWorkItemIds } from './azureDevops.js';

const WorkspacePathSchema = z.string().min(1);
const BoardRelPathSchema = z.string().min(1);

function getWorkspacePath(): string {
  const arg = process.argv.find((a: string) => a.startsWith('--workspace='));
  if (arg) return WorkspacePathSchema.parse(arg.slice('--workspace='.length));
  if (process.env.KANBANTO_WORKSPACE) return WorkspacePathSchema.parse(process.env.KANBANTO_WORKSPACE);
  return process.cwd();
}

function getBoardRelativePath(): string {
  const arg = process.argv.find((a: string) => a.startsWith('--board='));
  if (arg) return BoardRelPathSchema.parse(arg.slice('--board='.length));
  if (process.env.KANBANTO_BOARD_PATH) return BoardRelPathSchema.parse(process.env.KANBANTO_BOARD_PATH);
  return '.kanbanto/tasks.json';
}

function toolResultText(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolResultJson(obj: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function includesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

async function main() {
  const workspacePath = getWorkspacePath();
  dotenv.config({ path: join(workspacePath, '.env') });

  const store = BoardStore.fromWorkspace(workspacePath, getBoardRelativePath());

  const server = new Server(
    {
      name: 'kanbanto-mcp',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'board_get',
          description: 'Get the current board (columns/tasks)',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
          name: 'tasks_list',
          description: 'List tasks (optionally filtered by status/query)',
          inputSchema: {
            type: 'object',
            properties: {
              status: { type: 'string', description: 'Filter by column/status name' },
              query: { type: 'string', description: 'Substring match in title/goal/notes' },
              limit: { type: 'number', description: 'Max items (1..500)' }
            },
            additionalProperties: false
          }
        },
        {
          name: 'task_add',
          description: 'Add a task (optionally specify order)',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string' },
              priority: { type: 'number' },
              difficulty: { type: 'number', description: 'Difficulty (0..5)' },
              branchType: { type: 'string', description: 'Branch type (e.g. feature/fix/chore)' },
              goal: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
              order: { type: 'number', description: 'Order within the column (optional)' }
            },
            required: ['title', 'status'],
            additionalProperties: false
          }
        },
        {
          name: 'task_update',
          description: 'Update a task (partial patch)',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              patch: { type: 'object', additionalProperties: false }
            },
            required: ['id', 'patch'],
            additionalProperties: false
          }
        },
        {
          name: 'task_move',
          description: 'Move a task to another column (optional index)',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              index: { type: 'number' }
            },
            required: ['id', 'status'],
            additionalProperties: false
          }
        },
        {
          name: 'task_delete',
          description: 'Delete a task',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
          }
        },
        {
          name: 'column_reorder',
          description: 'Reorder tasks within a column by orderedIds',
          inputSchema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              orderedIds: { type: 'array', items: { type: 'string' } }
            },
            required: ['status', 'orderedIds'],
            additionalProperties: false
          }
        },
        {
          name: 'columns_update',
          description: 'Update columns (add/rename/reorder)',
          inputSchema: {
            type: 'object',
            properties: {
              columns: { type: 'array', items: { type: 'string' } }
            },
            required: ['columns'],
            additionalProperties: false
          }
        },
        {
          name: 'board_normalize',
          description: 'Normalize board consistency (status/priority/order, renumber order, etc.)',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
          name: 'azure_devops_import_assigned_to_me',
          description: 'Import Azure DevOps work items assigned to the PAT owner (@Me) into the board',
          inputSchema: {
            type: 'object',
            properties: {
              orgUrl: { type: 'string', description: 'Org URL e.g. https://dev.azure.com/YourOrg (defaults to AZDO_ORG_URL)' },
              project: { type: 'string', description: 'Project name (defaults to AZDO_PROJECT)' },
              wiql: { type: 'string', description: 'Optional WIQL query override' },
              workItemTypes: { type: 'array', items: { type: 'string' }, description: 'Optional filter (used only when wiql is not provided)' },
              top: { type: 'number', description: 'Max work items to import (1..500). Default 200.' },
              targetStatus: { type: 'string', description: 'Target Kanbanto column (default Backlog or first column)' },
              prefixWithId: { type: 'boolean', description: 'Prefix title with [ADO#123]. Default true.' },
              skipExisting: { type: 'boolean', description: 'Skip if already imported. Default true.' },
              includeDone: { type: 'boolean', description: 'Include completed items (Done/Closed etc.). Default false.' },
              excludeStates: { type: 'array', items: { type: 'string' }, description: 'Optional explicit Azure State names to exclude (used only when wiql is not provided). Example: ["Done","Closed"]' },
              stateToStatus: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional mapping: Azure State -> Kanbanto status' }
            },
            additionalProperties: false
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as unknown;

    const board = await store.load();

    switch (name) {
      case 'board_get': {
        return toolResultJson(board);
      }

      case 'tasks_list': {
        const input = ListTasksInputSchema.parse(args);
        const query = input.query?.trim();
        const status = input.status;
        const limit = input.limit ?? 200;

        const filtered = board.tasks
          .filter((t) => (status ? t.status === status : true))
          .filter((t) => {
            if (!query) return true;
            const hay = [t.title, t.goal ?? '', t.notes ?? ''].join('\n');
            return includesQuery(hay, query);
          })
          .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
          .slice(0, limit);

        return toolResultJson(filtered);
      }

      case 'task_add': {
        const input = AddTaskInputSchema.parse(args);
        const normalized = store.normalize(board);
        const { board: next, task } = store.addTask(normalized, {
          title: input.title,
          status: input.status,
          priority: input.priority,
          difficulty: input.difficulty,
          branchType: input.branchType,
          goal: input.goal,
          acceptanceCriteria: input.acceptanceCriteria,
          notes: input.notes,
          ...(typeof input.order === 'number' ? { order: input.order } : {})
        });
        await store.save(next);
        return toolResultJson({ task, board: next });
      }

      case 'task_update': {
        const input = UpdateTaskInputSchema.parse(args);
        const normalized = store.normalize(board);
        const { board: next, task } = store.updateTask(normalized, input.id, input.patch);
        await store.save(next);
        return toolResultJson({ task, board: next });
      }

      case 'task_move': {
        const input = MoveTaskInputSchema.parse(args);
        const normalized = store.normalize(board);
        const next = store.moveTask(normalized, input.id, input.status, input.index);
        await store.save(next);
        return toolResultJson(next);
      }

      case 'task_delete': {
        const input = DeleteTaskInputSchema.parse(args);
        const normalized = store.normalize(board);
        const next = store.deleteTask(normalized, input.id);
        await store.save(next);
        return toolResultJson(next);
      }

      case 'column_reorder': {
        const input = ReorderColumnInputSchema.parse(args);
        const normalized = store.normalize(board);
        const next = store.reorderWithinColumn(normalized, input.status, input.orderedIds);
        await store.save(next);
        return toolResultJson(next);
      }

      case 'columns_update': {
        const input = UpdateColumnsInputSchema.parse(args);
        const normalized = store.normalize(board);
        const next = store.updateColumns(normalized, input.columns);
        await store.save(next);
        return toolResultJson(next);
      }

      case 'azure_devops_import_assigned_to_me': {
        const input = AzureDevopsImportAssignedToMeInputSchema.parse(args);

        const orgUrl = (input.orgUrl ?? process.env.AZDO_ORG_URL ?? '').trim();
        const project = (input.project ?? process.env.AZDO_PROJECT ?? '').trim();
        const pat = (process.env.AZDO_PAT ?? '').trim();
        if (!orgUrl) return toolResultText('orgUrl is required (set AZDO_ORG_URL in .env or pass orgUrl)');
        if (!project) return toolResultText('project is required (set AZDO_PROJECT in .env or pass project)');
        if (!pat) return toolResultText('PAT is required (set AZDO_PAT in .env)');

        const includeDone = input.includeDone ?? false;
        const defaultExcluded = ['Done', 'Closed'];
        const excludeStates = includeDone ? [] : ((input.excludeStates && input.excludeStates.length > 0) ? input.excludeStates : defaultExcluded);

        const ids = await queryAssignedToMeWorkItemIds({
          orgUrl,
          project,
          pat,
          wiql: input.wiql,
          workItemTypes: input.workItemTypes,
          excludeStates: input.wiql ? undefined : excludeStates,
          top: input.top
        });

        const items = await fetchWorkItemsByIds({ orgUrl, project, pat, ids });
        const normalized = store.normalize(board);

        const targetFallback = (input.targetStatus && normalized.columns.includes(input.targetStatus))
          ? input.targetStatus
          : (normalized.columns.includes('Backlog') ? 'Backlog' : normalized.columns[0]);

        let nextBoard = normalized;
        let imported = 0;
        let skippedExisting = 0;
        let skippedByState = 0;

        const excludeSet = new Set(excludeStates.map((s) => s.toLowerCase()));

        for (const wi of items) {
          const marker = `ADO#${wi.id}`;
          const already = nextBoard.tasks.some((t) => (t.notes ?? '').includes(marker));
          if (input.skipExisting && already) {
            skippedExisting++;
            continue;
          }

          if (!includeDone && wi.state && excludeSet.has(wi.state.toLowerCase())) {
            skippedByState++;
            continue;
          }

          const mappedStatusRaw = (wi.state && input.stateToStatus) ? input.stateToStatus[wi.state] : undefined;
          const mappedStatus = (mappedStatusRaw && nextBoard.columns.includes(mappedStatusRaw)) ? mappedStatusRaw : undefined;
          const status = mappedStatus ?? targetFallback;

          const title = input.prefixWithId ? `[ADO#${wi.id}] ${wi.title}` : wi.title;
          const notesLines = [
            marker,
            `URL: ${wi.url}`,
            wi.type ? `Type: ${wi.type}` : undefined,
            wi.state ? `State: ${wi.state}` : undefined
          ].filter((s): s is string => typeof s === 'string' && s.length > 0);

          const { board: afterAdd } = store.addTask(nextBoard, {
            title,
            status,
            priority: 0,
            goal: wi.description,
            acceptanceCriteria: wi.acceptanceCriteria,
            notes: notesLines.join('\n')
          });

          nextBoard = afterAdd;
          imported++;
        }

        await store.save(nextBoard);
        const skipped = skippedExisting + skippedByState;
        return toolResultJson({ imported, skipped, skippedExisting, skippedByState, totalFetched: items.length, board: nextBoard });
      }

      case 'board_normalize': {
        const next = store.normalize(board);
        await store.save(next);
        return toolResultText('ok');
      }

      default:
        return toolResultText(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr is ok for MCP stdio servers
  console.error(err);
  process.exit(1);
});
