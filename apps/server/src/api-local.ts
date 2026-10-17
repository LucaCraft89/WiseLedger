// Server-side zod DTOs for the M3 routes. Response shapes come from core/api.ts (B); the request validators here are
// supersets of core's (payee note, includeFailed, from ≤ to, plain-language messages), so core clients stay valid.
// The onboarding DTOs are local until B copies them into core/api.ts.
import { JobStatusSchema, LabelEntrySchema } from 'core';
import { z } from 'zod';
import { isIsoDate, MAX_LABEL_LENGTH, MAX_LABELS } from './limits.js';

// GET /api/schedule
export const ScheduleListQuery = z.object({ status: JobStatusSchema.optional() });

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

/** Server routes added in M3 (core API_ROUTES has all but labelsList, labelsPutPayee and fiscalAlias). */
export const M3_ROUTES = {
  scheduleList: 'GET /api/schedule',
  scheduleCancel: 'POST /api/schedule/:jobId/cancel',
  labelsList: 'GET /api/labels',
  labelsPut: 'PUT /api/labels/:transferId',
  labelsPutPayee: 'PUT /api/labels/payee/:name',
  fiscal: 'GET /api/fiscal',
  fiscalAlias: 'GET /api/report',
} as const;

// Onboarding (first run of the real wallet). Copy into core/api.ts with the other M3 DTOs.
export const OnboardingStateSchema = z.enum(['needs_setup', 'locked', 'ready']);
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
export const OnboardingNetworkSchema = z.enum(['mutinynet', 'regtest', 'mock']);
export type OnboardingNetwork = z.infer<typeof OnboardingNetworkSchema>;

// GET /api/onboarding
export const OnboardingStatusResponse = z.object({
  state: OnboardingStateSchema,
  /** True once the recovery words were shown (or confirmed, or the wallet was restored from them). */
  seedShown: z.boolean(),
  network: OnboardingNetworkSchema,
  walletBackend: z.enum(['mock', 'wdk-rgb']),
  /** Shortest accepted wallet passphrase. */
  minPassphrase: z.number().int(),
});
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponse>;

// POST /api/onboarding/create → 201. Only in needs_setup (else 409 ALREADY_SET_UP); short passphrase → 400
// PASSPHRASE_TOO_SHORT; wallet failed to start → 503 SETUP_FAILED (nothing kept).
export const OnboardingCreateRequest = z.object({ passphrase: z.string().max(1000).optional() });
export type OnboardingCreateRequest = z.infer<typeof OnboardingCreateRequest>;
/** The 12 recovery words, returned once (Cache-Control: no-store). */
export const OnboardingCreateResponse = z.object({ mnemonic: z.string(), words: z.array(z.string()) });
export type OnboardingCreateResponse = z.infer<typeof OnboardingCreateResponse>;

// POST /api/onboarding/seed-confirmed (idempotent; 409 WALLET_NOT_READY before the wallet exists)
export const OnboardingSeedConfirmedRequest = z.object({ confirmed: z.literal(true) });
export type OnboardingSeedConfirmedRequest = z.infer<typeof OnboardingSeedConfirmedRequest>;
export const OnboardingSeedConfirmedResponse = z.object({ ok: z.literal(true) });
export type OnboardingSeedConfirmedResponse = z.infer<typeof OnboardingSeedConfirmedResponse>;

// POST /api/onboarding/restore. Only in needs_setup; bad words → 400 INVALID_MNEMONIC.
export const OnboardingRestoreRequest = z.object({
  mnemonic: z.string().trim().min(1).max(1000),
  passphrase: z.string().max(1000).optional(),
});
export type OnboardingRestoreRequest = z.infer<typeof OnboardingRestoreRequest>;
export const OnboardingRestoreResponse = z.object({ ok: z.literal(true), note: z.string() });
export type OnboardingRestoreResponse = z.infer<typeof OnboardingRestoreResponse>;

// POST /api/onboarding/unlock. Only in locked (else 409); wrong → 401 WalletLocked; after 5 wrong → 429
// TOO_MANY_ATTEMPTS for 30 s.
export const OnboardingUnlockRequest = z.object({ passphrase: z.string().min(1).max(1000) });
export type OnboardingUnlockRequest = z.infer<typeof OnboardingUnlockRequest>;
export const OnboardingUnlockResponse = z.object({ ok: z.literal(true) });
export type OnboardingUnlockResponse = z.infer<typeof OnboardingUnlockResponse>;

/** /api/health additions on top of core HealthResponse. */
export const HealthOnboardingFields = z.object({
  onboarding: OnboardingStateSchema,
  network: OnboardingNetworkSchema,
  /** Plain network / faucet hints, e.g. where to get test bitcoin. */
  hints: z.array(z.string()),
});
export type HealthOnboardingFields = z.infer<typeof HealthOnboardingFields>;

/** Onboarding routes (not in core API_ROUTES yet: core gap). */
export const M3_ONBOARDING_ROUTES = {
  status: 'GET /api/onboarding',
  create: 'POST /api/onboarding/create',
  seedConfirmed: 'POST /api/onboarding/seed-confirmed',
  restore: 'POST /api/onboarding/restore',
  unlock: 'POST /api/onboarding/unlock',
} as const;
