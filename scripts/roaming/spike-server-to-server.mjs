#!/usr/bin/env node
// M0 spike (b): server-to-server authenticated RPC round-trip
// (.plans/21-roaming-workspace.md). Plays the role of server A's future
// PeerMirror talking to server B: exchange a one-time pairing credential for a
// bearer token at B's /oauth/token, then call authenticated endpoints on B.
//
// Usage: node scripts/roaming/spike-server-to-server.mjs <b-url> <pairing-credential>
//   e.g. node scripts/roaming/spike-server-to-server.mjs http://127.0.0.1:14802 ABCD2345EFGH

const [bUrl, credential] = process.argv.slice(2);
if (!bUrl || !credential) {
  console.error("usage: spike-server-to-server.mjs <b-url> <pairing-credential>");
  process.exit(2);
}

const fail = (step, detail) => {
  console.error(`FAIL at ${step}: ${detail}`);
  process.exit(1);
};

// 1. Unauthenticated descriptor — who is B?
const descriptorRes = await fetch(`${bUrl}/.well-known/t3/environment`);
if (!descriptorRes.ok) fail("descriptor", `${descriptorRes.status}`);
const descriptor = await descriptorRes.json();
console.log(`B descriptor: environmentId=${descriptor.environmentId ?? "?"}`);

// 2. Exchange the pairing credential for a bearer token (RFC 8693 shape,
//    same call packages/client-runtime/src/authorization/remote.ts makes).
const tokenRes = await fetch(`${bUrl}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "roaming-m0-spike",
    client_device_type: "bot",
  }),
});
if (!tokenRes.ok) fail("token exchange", `${tokenRes.status} ${await tokenRes.text()}`);
const token = await tokenRes.json();
console.log(
  `token exchange OK: token_type=${token.token_type} scope="${token.scope}" expires_in=${token.expires_in}s`,
);

const authHeaders = { authorization: `Bearer ${token.access_token}` };

// 3. Authenticated session check (optional-auth endpoint).
const sessionRes = await fetch(`${bUrl}/api/auth/session`, { headers: authHeaders });
if (!sessionRes.ok) fail("session", `${sessionRes.status}`);
const session = await sessionRes.json();
if (!session.authenticated) fail("session", `authenticated=${session.authenticated}`);
console.log(`session OK: authenticated=true method=${session.sessionMethod}`);

// 4. Auth-REQUIRED endpoint (EnvironmentAuthenticatedAuth middleware) — the
//    actual round-trip proof that the bearer token is honored.
const ticketRes = await fetch(`${bUrl}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: authHeaders,
});
if (!ticketRes.ok) fail("websocket-ticket", `${ticketRes.status} ${await ticketRes.text()}`);
const ticket = await ticketRes.json();
console.log(`websocket-ticket OK: expires ${ticket.expiresAt}`);

// 5. Negative control: same endpoint without the token must be rejected.
const unauthRes = await fetch(`${bUrl}/api/auth/websocket-ticket`, { method: "POST" });
if (unauthRes.ok) fail("negative control", "unauthenticated request was accepted");
console.log(`negative control OK: unauthenticated request rejected (${unauthRes.status})`);

console.log("SPIKE PASS: server-to-server authenticated RPC round-trip complete");
