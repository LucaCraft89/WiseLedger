// Local zod DTOs for the M3 routes, with the names and fields B is adding to core/api.ts (not merged yet: core gap).
// Swap these imports for 'core' once B's PR lands.
import { JobSchema, JobStatusSchema, LabelEntrySchema } from 'core';
import { z } from 'zod';
import { isIsoDate, MAX_LABEL_LENGTH, MAX_LABELS } from './limits.js';

// GET /api/schedule
export const ScheduleListQuery = z.object({ status: JobStatusSchema.optional() });
export const ScheduleListResponse = z.object({ jobs: z.array(JobSchema) });
export type ScheduleListResponse = z.infer<typeof ScheduleListResponse>;

// POST /api/schedule/:jobId/cancel
export const ScheduleCancelResponse = z.object({ ok: z.boolean() });
export type ScheduleCancelResponse = z.infer<typeof ScheduleCancelResponse>;

// GET /api/labels
export const LabelsListResponse = z.object({ labels: z.array(LabelEntrySchema) });
export type LabelsListResponse = z.infer<typeof LabelsListResponse>;

// PUT /api/labels/:transferId and PUT /api/labels/payee/:name → LabelEntry
export const LabelsPutRequest = z.object({
  labels: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'a label cannot be empty')
        .max(MAX_LABEL_LENGTH, `each label can be at most ${MAX_LABEL_LENGTH} characters`),
    )
    .max(MAX_LABELS, `at most ${MAX_LABELS} labels`),
  note: z.string().max(500).optional(),
});
export type LabelsPutRequest = z.infer<typeof LabelsPutRequest>;

const IsoDate = z.string().refine(isIsoDate, 'write the date as YYYY-MM-DD, e.g. 2026-10-17');

// GET /api/fiscal (alias GET /api/report)
export const FiscalQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    format: z.enum(['csv', 'json'], { message: 'format must be csv or json' }).default('csv'),
    includeFailed: z.enum(['true', 'false']).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'the start date must be on or before the end date', path: ['from'] });
export type FiscalQuery = z.infer<typeof FiscalQuery>;

/** Server routes added in M3 (not in core API_ROUTES yet: core gap). */
export const M3_ROUTES = {
  scheduleList: 'GET /api/schedule',
  scheduleCancel: 'POST /api/schedule/:jobId/cancel',
  labelsList: 'GET /api/labels',
  labelsPut: 'PUT /api/labels/:transferId',
  labelsPutPayee: 'PUT /api/labels/payee/:name',
  fiscal: 'GET /api/fiscal',
  fiscalAlias: 'GET /api/report',
} as const;
