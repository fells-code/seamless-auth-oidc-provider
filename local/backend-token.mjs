// The backend client's side: a client credentials token for your resource, verified.
import { backendToken, recipe, verifyAccessToken } from './lib.mjs';

const res = await backendToken();
if (res.status !== 200) throw new Error(`token endpoint: ${res.status} ${res.text}`);
const claims = await verifyAccessToken(res.json.access_token, { audience: recipe().resource });
console.log('The access token verifies against the JWKS. Its claims:');
console.log(JSON.stringify(claims, null, 2));
