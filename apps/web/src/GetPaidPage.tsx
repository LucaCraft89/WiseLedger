import { useCallback } from 'react';
import type { ApiClient } from './api/client.js';
import { ErrorBox, errorText, Loading, useLoad } from './ui.js';
import { GetPaid } from './WalletPage.js';

/** `#/get-paid`: payment requests (make one, see the list, open one, cancel, archive). */
export function GetPaidPage({ api, hash }: { api: ApiClient; hash: string }) {
  const load = useCallback(() => api.wallet(), [api]);
  const { data, error, reload } = useLoad(load);
  return (
    <section>
      <h2>Get paid</h2>
      {error ? (
        <ErrorBox error={errorText(error, 'I could not open your wallet. Try again in a moment.')} retry={reload} />
      ) : null}
      {!data && !error ? <Loading text="Opening your wallet… (a few seconds)" /> : null}
      {data && <GetPaid api={api} wallet={data} hash={hash} />}
    </section>
  );
}
