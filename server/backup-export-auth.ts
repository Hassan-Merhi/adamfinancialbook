const MAX_AUTHORIZATION_BYTES = 20 * 1024;
const MAX_BEARER_BYTES = 16 * 1024;

/** Pure parser so authorization-boundary tests never initialize the database. */
export function bearerTokenFromAuthorization(authorization: string | undefined): string {
  const value = authorization ?? '';
  if (
    value.length < 8
    || Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_BYTES
    || value.slice(0, 7).toLowerCase() !== 'bearer '
  ) {
    throw Object.assign(new Error('GitHub Actions OIDC bearer token is required.'), { status: 401 });
  }
  const token = value.slice(7);
  if (
    !token
    || Buffer.byteLength(token, 'utf8') > MAX_BEARER_BYTES
    || token.includes(' ')
    || token.includes('\t')
    || token.includes('\r')
    || token.includes('\n')
  ) {
    throw Object.assign(new Error('GitHub Actions OIDC bearer token is invalid.'), { status: 401 });
  }
  return token;
}
