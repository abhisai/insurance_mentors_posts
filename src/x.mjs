import crypto from 'node:crypto';
import { config } from './config.mjs';

/**
 * RFC 3986 percent encoding, as required by the OAuth 1.0a spec.
 * encodeURIComponent leaves !'()* unescaped, so we escape those too.
 */
const percentEncode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

/**
 * Builds an OAuth 1.0a Authorization header.
 *
 * For an application/json body, the body is NOT part of the signature base
 * string. Only the oauth_* parameters and any query-string parameters are.
 * Query parameters are pulled out of `url` automatically.
 */
export function oauthHeader({
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  params = {},
  nonce,
  timestamp,
}) {
  const parsed = new URL(url);
  const baseUrl = `${parsed.origin}${parsed.pathname}`;

  const signatureParams = { ...params };
  for (const [key, value] of parsed.searchParams.entries()) {
    if (signatureParams[key] === undefined) signatureParams[key] = value;
  }

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? crypto.randomBytes(24).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    // Omitted entirely for two-legged (app-only) requests such as
    // POST /oauth/request_token, where no user token exists yet. X rejects the
    // request if oauth_token is present but empty.
    ...(token ? { oauth_token: token } : {}),
  };

  const all = { ...signatureParams, ...oauthParams };
  const parameterString = Object.keys(all)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(all[key])}`)
    .join('&');

  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(parameterString)].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;

  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const header = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ');

  return `OAuth ${header}`;
}

/**
 * Publishes one post to X.
 * @returns {Promise<{id: string, url: string, text: string}>}
 */
export async function postToX(text) {
  const { endpoint, consumerKey, consumerSecret, accessToken, accessTokenSecret, userAccessToken } = config.x;

  // OAuth 2.0 user context is simpler but the token expires and must be refreshed.
  const authorization = userAccessToken
    ? `Bearer ${userAccessToken}`
    : oauthHeader({
        method: 'POST',
        url: endpoint,
        consumerKey,
        consumerSecret,
        token: accessToken,
        tokenSecret: accessTokenSecret,
      });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'User-Agent': 'insurancementors-x-automation',
    },
    body: JSON.stringify({ text }),
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    /* non-JSON error body */
  }

  if (!response.ok) {
    const detail = payload?.detail || payload?.title || raw.slice(0, 400);
    const hint =
      response.status === 401 || response.status === 403
        ? '\nCheck that your X app permissions are "Read and Write" and that the access token was generated AFTER saving that setting.'
        : response.status === 429
          ? '\nRate limited by X. A once-a-day schedule sits far below the normal limits, so this usually means another app is using the same quota.'
          : response.status === 402
            ? '\nX says the account has no remaining posting credits for this billing cycle.'
            : '';
    throw new Error(`X API ${response.status}: ${detail}${hint}`);
  }

  const id = payload?.data?.id;
  if (!id) throw new Error(`X API returned no post id. Response: ${raw.slice(0, 400)}`);

  return {
    id,
    url: `https://x.com/i/web/status/${id}`,
    text: payload?.data?.text ?? text,
  };
}
