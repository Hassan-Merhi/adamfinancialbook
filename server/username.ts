/**
 * The canonical login key for usernames.
 *
 * Formatting differences are ignored: letter case and whitespace do not matter.
 * The actual letters still do, so a missing or different character is a
 * different username.
 */
export function usernameKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('en-US');
}
