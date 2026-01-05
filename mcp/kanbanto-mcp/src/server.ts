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
  DeleteTaskInputSchema,
  ListTasksInputSchema,
  MoveTaskInputSchema,
  ReorderColumnInputSchema,
  UpdateColumnsInputSchema,
  UpdateTaskInputSchema
} from './schema.js';
import { BoardStore } from './boardStore.js';
import dotenv from 'dotenv';

const WorkspacePathSchema = z.string().min(1);
const BoardRelPathSchema = z.string().min(1);
const BoardGetInputSchema = z.object({ full: z.boolean().optional() }).strict();

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
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function includesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function appendNotes(prev: string | undefined, addition: string): string {
  const add = addition.trim();
  const prevTrimmed = prev?.trim();
  if (!prevTrimmed) return add;
  if (!add) return prevTrimmed;
  return `${prevTrimmed}\n\n${add}`;
}

function toCompactTask(task: any) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    order: task.order,
    updatedAt: task.updatedAt
  };
}

function toCompactBoard(board: any) {
  return {
    version: board.version,
    columns: board.columns,
    tasks: Array.isArray(board.tasks) ? board.tasks.map(toCompactTask) : []
  };
}

async function main() {
  const workspacePath = getWorkspacePath();
  dotenv.config({ path: join(workspacePath, '.env') });

  const store = BoardStore.fromWorkspace(workspacePath, getBoardRelativePath());
  const queue = new SerialQueue();

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
          description: 'Get the current board (compact by default); pass {full:true} for full JSON',
          inputSchema: {
            type: 'object',
            properties: {
              full: { type: 'boolean', description: 'If true, return full board JSON (may be large)' }
            },
            additionalProperties: false
          }
        },
        {
          name: 'tasks_list',
          description: 'List tasks titles (optionally filtered by status/query)',
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
          description: 'Move a task to another column (optional index); when moving to Done, include notes (work performed)',
          inputSchema: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: { const: 'Done' },
                  notes: { type: 'string', description: 'Required when moving to Done; appended to existing notes' },
                  index: { type: 'number' }
                },
                required: ['id', 'status', 'notes'],
                additionalProperties: false
              },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  index: { type: 'number' }
                },
                required: ['id', 'status'],
                additionalProperties: false,
                not: { properties: { status: { const: 'Done' } } }
              }
            ]
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
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return queue.run(async () => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as unknown;

      const board = await store.load();

      switch (name) {
        case 'board_get': {
          const input = BoardGetInputSchema.parse(args);
          return toolResultJson(input.full ? board : toCompactBoard(board));
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

          return toolResultJson(filtered.map((t) => t.title));
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
          return toolResultJson({ task });
        }

        case 'task_update': {
          const input = UpdateTaskInputSchema.parse(args);
          const normalized = store.normalize(board);
          const prevTask = normalized.tasks.find((t) => t.id === input.id);
          if (!prevTask) throw new Error(`Task not found: ${input.id}`);

          const movingToDone = input.patch.status === 'Done' && prevTask.status !== 'Done';
          const notesAddition = input.patch.notes?.trim();
          if (movingToDone && !notesAddition) {
            throw new Error(`When moving to Done, provide notes describing work performed.`);
          }

          const patch = {
            ...input.patch,
            ...(movingToDone && notesAddition ? { notes: appendNotes(prevTask.notes, notesAddition) } : {})
          };

          const { board: next, task } = store.updateTask(normalized, input.id, patch);
          await store.save(next);
          return toolResultJson({ id: task.id, changes: patch });
        }

        case 'task_move': {
          const input = MoveTaskInputSchema.parse(args);
          const normalized = store.normalize(board);
          const prevTask = normalized.tasks.find((t) => t.id === input.id);
          if (!prevTask) throw new Error(`Task not found: ${input.id}`);

          const movingToDone = input.status === 'Done' && prevTask.status !== 'Done';
          const notesAddition = input.notes?.trim();
          if (movingToDone && !notesAddition) {
            throw new Error(`When moving to Done, provide notes describing work performed.`);
          }
          if (!movingToDone && notesAddition) {
            throw new Error(`notes is only supported when moving to Done.`);
          }

          const notesNext = movingToDone && notesAddition ? appendNotes(prevTask.notes, notesAddition) : undefined;
          let next = store.moveTask(normalized, input.id, input.status, input.index);
          if (notesNext) {
            next = store.updateTask(next, input.id, { notes: notesNext }).board;
          }

          await store.save(next);
          return toolResultJson({
            id: input.id,
            fromStatus: prevTask.status,
            toStatus: input.status,
            ...(movingToDone ? { notesAppended: true } : {})
          });
        }

        case 'task_delete': {
          const input = DeleteTaskInputSchema.parse(args);
          const normalized = store.normalize(board);
          const next = store.deleteTask(normalized, input.id);
          await store.save(next);
          return toolResultJson({ id: input.id, deleted: true });
        }

        case 'column_reorder': {
          const input = ReorderColumnInputSchema.parse(args);
          const normalized = store.normalize(board);
          const next = store.reorderWithinColumn(normalized, input.status, input.orderedIds);
          await store.save(next);
          return toolResultJson({ status: input.status, orderedIds: input.orderedIds });
        }

        case 'columns_update': {
          const input = UpdateColumnsInputSchema.parse(args);
          const normalized = store.normalize(board);
          const next = store.updateColumns(normalized, input.columns);
          await store.save(next);
          return toolResultJson({ columns: input.columns });
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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr is ok for MCP stdio servers
  console.error(err);
  process.exit(1);
});
