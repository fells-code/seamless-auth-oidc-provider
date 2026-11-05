// The native app's side of a sign-in: prints the URL to open, waits for the redirect back, and
// shows the verified access token for your resource.
import { recipe, startNativeSignIn, verifyAccessToken } from './lib.mjs';

const flow = await startNativeSignIn();
console.log(`Open this in your browser:\n\n${flow.url}\n\nWaiting for the sign-in...`);
const tokens = await flow.tokens();
const claims = await verifyAccessToken(tokens.access_token, { audience: recipe().resource });
console.log('\nThe access token verifies against the JWKS. Its claims:');
console.log(JSON.stringify(claims, null, 2));
console.log(`\nAccess token:\n${tokens.access_token}`);
