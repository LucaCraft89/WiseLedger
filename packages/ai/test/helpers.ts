import type { HistoryMatch, HistoryPort, HistoryQuery, PayeeBookEntry } from 'core';
import { MOCK_ASSET_ID } from 'core/mocks';
import type { RuleConfig } from '../src/rules/types.js';

export const CONFIG: RuleConfig = {
  assetAllowlist: [MOCK_ASSET_ID],
  paymentCap: '100000000',
  networks: ['mock'],
  assets: { [MOCK_ASSET_ID]: { ticker: 'TUSDT', precision: 6 } },
};

/** History that "remembers" issuer+number pairs and a payee book. */
export function historyOf(
  seen: { issuer: string; number: string; invoiceId: string }[] = [],
  payees: PayeeBookEntry[] = [],
): HistoryPort {
  return {
    async seen(by: HistoryQuery): Promise<HistoryMatch[]> {
      return seen
        .filter((s) => s.issuer.toUpperCase() === by.issuer?.toUpperCase() && s.number === by.number)
        .map((s) => ({ invoiceId: s.invoiceId, matchedOn: 'issuer+number' as const }));
    },
    async payeeBook() {
      return payees;
    },
  };
}
