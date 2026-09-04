import { Timestamp } from 'firebase-admin/firestore';
import { ACCESS_MS, REFRESH_MS, CODE_MS, hash, secret, equal, requireThat } from './domain.js';

export function makeOAuth(db, config, now = Date.now) {
  const tokenRef = token => db.collection('oauth').doc(hash(token));
  const userRef = uid => db.collection('users').doc(uid);
  const validUser = (user, version) => user?.enabled === true && user.linkVersion === version;
  function validateRequest(input) {
    requireThat(input && input.client_id === config.clientId, 400, 'invalid_client');
    requireThat(input.response_type === 'code', 400, 'unsupported_response_type');
    const allowed = [
      `https://oauth-redirect.googleusercontent.com/r/${config.projectId}`,
      `https://oauth-redirect-sandbox.googleusercontent.com/r/${config.projectId}`,
    ];
    requireThat(allowed.includes(input.redirect_uri), 400, 'invalid_redirect_uri');
    requireThat(typeof input.state === 'string' && input.state.length > 0 && input.state.length <= 2048, 400, 'invalid_state');
    requireThat(input.scope === undefined || input.scope === '' || input.scope === 'devices', 400, 'invalid_scope');
    return { clientId: input.client_id, redirectUri: input.redirect_uri, state: input.state };
  }
  async function authorize(uid, input) {
    const request = validateRequest(input);
    const user = (await userRef(uid).get()).data();
    requireThat(user?.enabled === true, 403, 'account_not_provisioned');
    const code = secret();
    await tokenRef(code).create({
      type: 'code', uid, version: user.linkVersion, clientId: config.clientId,
      redirectUri: request.redirectUri, expiresAt: Timestamp.fromMillis(now() + CODE_MS),
    });
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', request.state);
    return redirect.toString();
  }
  async function exchange(input, basic) {
    let clientId = input.client_id;
    let clientSecret = input.client_secret;
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      const at = decoded.indexOf(':');
      requireThat(at >= 0, 401, 'invalid_client');
      clientId = decodeURIComponent(decoded.slice(0, at));
      clientSecret = decodeURIComponent(decoded.slice(at + 1));
    }
    requireThat(clientId === config.clientId && equal(clientSecret, config.clientSecret), 401, 'invalid_client');
    const codeGrant = input.grant_type === 'authorization_code';
    requireThat(codeGrant || input.grant_type === 'refresh_token', 400, 'unsupported_grant_type');
    const credential = codeGrant ? input.code : input.refresh_token;
    requireThat(typeof credential === 'string' && credential.length >= 32 && credential.length <= 256, 400, 'invalid_grant');
    const access = secret();
    const refresh = codeGrant ? secret() : undefined;
    await db.runTransaction(async tx => {
      const ref = tokenRef(credential);
      const grant = (await tx.get(ref)).data();
      requireThat(grant && grant.type === (codeGrant ? 'code' : 'refresh') && grant.clientId === config.clientId && grant.expiresAt.toMillis() > now(), 400, 'invalid_grant');
      if (codeGrant) requireThat(input.redirect_uri === grant.redirectUri, 400, 'invalid_grant');
      const refUser = userRef(grant.uid);
      const user = (await tx.get(refUser)).data();
      requireThat(validUser(user, grant.version) && (codeGrant || user.googleLinked), 400, 'invalid_grant');
      const shared = { uid: grant.uid, version: grant.version, clientId: config.clientId };
      tx.create(tokenRef(access), { ...shared, type: 'access', expiresAt: Timestamp.fromMillis(now() + ACCESS_MS) });
      if (codeGrant) {
        tx.delete(ref);
        tx.create(tokenRef(refresh), { ...shared, type: 'refresh', expiresAt: Timestamp.fromMillis(now() + REFRESH_MS) });
        tx.update(refUser, { googleLinked: true });
      }
    });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, ...(refresh ? { refresh_token: refresh } : {}) };
  }
  async function authenticate(token) {
    requireThat(typeof token === 'string' && token.length >= 32 && token.length <= 256, 401, 'invalid_token');
    const grant = (await tokenRef(token).get()).data();
    requireThat(grant?.type === 'access' && grant.clientId === config.clientId && grant.expiresAt.toMillis() > now(), 401, 'invalid_token');
    const user = (await userRef(grant.uid).get()).data();
    requireThat(validUser(user, grant.version) && user.googleLinked, 401, 'invalid_token');
    return grant.uid;
  }
  async function disconnect(uid) {
    await userRef(uid).update({ googleLinked: false, googleSynced: false, linkVersion: secret() });
  }
  return { validateRequest, authorize, exchange, authenticate, disconnect };
}
