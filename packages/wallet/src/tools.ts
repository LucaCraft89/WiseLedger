// Wallet tools for the Treasurer. Arguments are short IDs, enums and numbers only; handlers resolve everything else.
// execute_plan moves money, so it requires a confirmed plan and runs through the guard.
import type { ToolDef, WalletPort } from 'core';
import { z } from 'zod';
import { executeGuarded, type WalletGuard } from './guard.js';

const AssetIdArg = z.string().min(4).max(100).startsWith('rgb:');

export const ExecutePlanParams = z.object({ planId: z.string().regex(/^[0-9a-f]{64}$/) });
export const GetBalanceParams = z.object({ assetId: AssetIdArg.optional() });
export const CreateReceiveParams = z.object({
  assetId: AssetIdArg.optional(),
  /** base units */
  amount: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .optional(),
  expiryMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .optional(),
});

export function walletTools(deps: {
  wallet: Pick<WalletPort, 'pay' | 'listAssets' | 'assetBalance' | 'createReceiveInvoice'>;
  guard: WalletGuard;
}): [
  ToolDef<z.infer<typeof ExecutePlanParams>>,
  ToolDef<z.infer<typeof GetBalanceParams>>,
  ToolDef<z.infer<typeof CreateReceiveParams>>,
] {
  return [
    {
      name: 'execute_plan',
      description: 'Pay a payment plan the user has confirmed. Argument: planId (64 hex characters).',
      params: ExecutePlanParams,
      requiresConfirmation: true,
      handler: ({ planId }) => executeGuarded(planId, deps),
    },
    {
      name: 'get_balance',
      description: 'Balances of the wallet assets (base units). Optional assetId to get one asset.',
      params: GetBalanceParams,
      requiresConfirmation: false,
      handler: async ({ assetId }) => {
        const assets = await deps.wallet.listAssets();
        const pick = assetId ? assets.filter((a) => a.assetId === assetId) : assets;
        return pick.map((a) => ({ assetId: a.assetId, ticker: a.ticker, precision: a.precision, ...a.balance }));
      },
    },
    {
      name: 'create_receive_invoice',
      description: 'Create an RGB invoice to receive a payment. Optional assetId, amount (base units), expiryMinutes.',
      params: CreateReceiveParams,
      requiresConfirmation: false,
      handler: ({ assetId, amount, expiryMinutes }) =>
        deps.wallet.createReceiveInvoice({
          ...(assetId ? { assetId } : {}),
          ...(amount ? { amount } : {}),
          expirySec: (expiryMinutes ?? 24 * 60) * 60,
        }),
    },
  ];
}
