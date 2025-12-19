import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  notes: z.string().optional(),
  status: z.string().min(1),
  priority: z.number().int().min(0),
  difficulty: z.number().int().min(0).max(5).optional(),
  branchType: z.string().min(1).optional(),
  order: z.number().int().min(0),
  updatedAt: z.string().min(1),
  createdAt: z.string().optional()
});

export const BoardFileSchema = z.object({
  version: z.literal(1),
  columns: z.array(z.string().min(1)).min(1),
  tasks: z.array(TaskSchema)
});

export const AddTaskInputSchema = z.object({
  title: z.string().min(1),
  status: z.string().min(1),
  priority: z.number().int().min(0).default(0),
  difficulty: z.number().int().min(0).max(5).optional(),
  branchType: z.string().min(1).optional(),
  goal: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  notes: z.string().optional(),
  order: z.number().int().min(0).optional()
});

export const UpdateTaskInputSchema = z.object({
  id: z.string().min(1),
  patch: z
    .object({
      title: z.string().min(1).optional(),
      goal: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      notes: z.string().optional(),
      status: z.string().min(1).optional(),
      priority: z.number().int().min(0).optional(),
      difficulty: z.number().int().min(0).max(5).optional(),
      branchType: z.string().min(1).optional(),
      order: z.number().int().min(0).optional()
    })
    .strict()
});

export const MoveTaskInputSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  index: z.number().int().min(0).optional()
});

export const DeleteTaskInputSchema = z.object({
  id: z.string().min(1)
});

export const ReorderColumnInputSchema = z.object({
  status: z.string().min(1),
  orderedIds: z.array(z.string().min(1)).min(1)
});

export const UpdateColumnsInputSchema = z.object({
  columns: z.array(z.string().min(1)).min(1)
});

export const ListTasksInputSchema = z.object({
  status: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional()
});
