// One picture for an identity, from the accounts linked to it. A password
// account has none, so a person who signs in with a password still shows the
// photo of their Telegram or Google account, when one is linked.

type AccountItem = Readonly<Record<string, unknown>>;

function photoOf(account: AccountItem): string | null {
  const url = account.photo_url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/** The signed-in account's photo, else the Telegram account's, else any linked account's; null when none has one. */
export function identityPhoto(accounts: readonly AccountItem[], signedIn?: Readonly<{ provider: string; subject: string }>): string | null {
  const own = signedIn === undefined ? undefined
    : accounts.find((account) => account.platform === signedIn.provider && account.platform_user_id === signedIn.subject);
  const ordered = [
    ...(own === undefined ? [] : [own]),
    ...accounts.filter((account) => account.platform === "telegram"),
    ...accounts,
  ];
  for (const account of ordered) {
    const photo = photoOf(account);
    if (photo !== null) return photo;
  }
  return null;
}
