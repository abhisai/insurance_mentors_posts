// Verifies the OAuth 1.0a signer against the official Twitter documentation
// test vector, then prints a sample header for the real posting endpoint.
import { oauthHeader } from '../src/x.mjs';

// https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
const expectedSignature = 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=';

const header = oauthHeader({
  method: 'POST',
  url: 'https://api.x.com/1.1/statuses/update.json?include_entities=true',
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: 1318622958,
  // Form-encoded body parameters count towards the signature; a JSON body does not.
  params: {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
  },
});

const actualSignature = decodeURIComponent(header.match(/oauth_signature="([^"]+)"/)[1]);
console.log('expected:', expectedSignature);
console.log('actual  :', actualSignature);
console.log(actualSignature === expectedSignature ? '\nPASS - signature matches the X spec' : '\nFAIL - signature mismatch');

console.log('\nSample header for the posting endpoint:');
console.log(
  oauthHeader({
    method: 'POST',
    url: 'https://api.x.com/2/tweets',
    consumerKey: 'EXAMPLEKEY',
    consumerSecret: 'EXAMPLESECRET',
    token: 'EXAMPLE-TOKEN',
    tokenSecret: 'EXAMPLE-TOKENSECRET',
    nonce: 'fixednonce',
    timestamp: 1760000000,
  })
);
