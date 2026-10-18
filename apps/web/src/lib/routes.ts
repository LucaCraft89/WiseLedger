// Navigation: seven sections, same order everywhere. Old hashes keep working (they redirect).
export const NAV = [
  { href: '#/', label: 'Desk' },
  { href: '#/pay', label: 'Pay' },
  { href: '#/get-paid', label: 'Get paid' },
  { href: '#/books', label: 'Books' },
  { href: '#/ask', label: 'Ask Wise' },
  { href: '#/me', label: 'Me' },
  { href: '#/settings', label: 'Settings' },
] as const;

/** The new hash for an old one, or null when the hash is current. Keeps any detail/query after the section. */
export function redirectFor(hash: string): string | null {
  const wallet = /^#\/wallet(?:\/(.*))?$/.exec(hash);
  if (wallet) {
    const rest = wallet[1] ?? '';
    if (rest.startsWith('get-paid')) return `#/get-paid${rest.slice('get-paid'.length)}`;
    return '#/me';
  }
  if (hash === '#/settings/money') return '#/me';
  if (hash === '#/chat') return '#/ask';
  if (hash === '#/invoices') return '#/pay/invoices';
  if (hash === '#/schedule') return '#/pay/scheduled';
  if (hash === '#/transfers') return '#/books';
  return null;
}

/** Which nav entry a hash belongs to. */
export function sectionOf(hash: string): (typeof NAV)[number]['href'] {
  if (hash === '' || hash === '#' || hash === '#/') return '#/';
  if (hash.startsWith('#/pay') || hash.startsWith('#/invoice/')) return '#/pay';
  if (hash.startsWith('#/get-paid')) return '#/get-paid';
  if (hash.startsWith('#/books')) return '#/books';
  if (hash.startsWith('#/ask')) return '#/ask';
  if (hash.startsWith('#/me')) return '#/me';
  if (hash.startsWith('#/settings')) return '#/settings';
  return '#/';
}
