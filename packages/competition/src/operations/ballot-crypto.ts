import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

/**
 * E-20: RSA blind signatures (full-domain hash, MGF1-SHA-256) for unlinkable ballot credentials.
 * The issuer learns who received a credential but cannot link the unblinded credential to the voter.
 * Not RFC 9474 wire-compatible; the construction is RSA-FDH blind signing with 2048-bit keys.
 */
export type BallotPublicKey = Readonly<{ n: string; e: string }>;
type PrivateKey = Readonly<{ n: bigint; e: bigint; d: bigint }>;

const big = (b64: string) => BigInt(`0x${Buffer.from(b64, 'base64url').toString('hex') || '0'}`);
const b64 = (value: bigint) => { let hex = value.toString(16); if (hex.length % 2) hex = `0${hex}`; return Buffer.from(hex, 'hex').toString('base64url'); };
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n; let b = base % modulus; let e = exponent;
  while (e > 0n) { if (e & 1n) result = (result * b) % modulus; e >>= 1n; b = (b * b) % modulus; }
  return result;
}
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m]; let [oldS, s] = [1n, 0n];
  while (r !== 0n) { const q = oldR / r; [oldR, r] = [r, oldR - q * r]; [oldS, s] = [s, oldS - q * s]; }
  if (oldR !== 1n) throw new Error('Not invertible');
  return ((oldS % m) + m) % m;
}
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
function byteLength(n: bigint): number { return Math.ceil(n.toString(16).length / 2); }
/** Full-domain hash: MGF1-SHA-256 expansion to the modulus size, reduced modulo n. */
export function fullDomainHash(message: string, n: bigint): bigint {
  const length = byteLength(n); const parts: Buffer[] = [];
  for (let counter = 0; Buffer.concat(parts).length < length; counter++) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    parts.push(createHash('sha256').update('lde-ballot-fdh-v1').update(Buffer.from(message, 'utf8')).update(c).digest());
  }
  return BigInt(`0x${Buffer.concat(parts).subarray(0, length).toString('hex')}`) % n;
}

export function generateBallotKey(): { publicKey: BallotPublicKey; privateJwk: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.n || !jwk.e || !jwk.d) throw new Error('Key export failed');
  return { publicKey: Object.freeze({ n: jwk.n, e: jwk.e }), privateJwk: JSON.stringify({ n: jwk.n, e: jwk.e, d: jwk.d }) };
}
function parsePrivate(json: string): PrivateKey { const k = JSON.parse(json) as { n: string; e: string; d: string }; return { n: big(k.n), e: big(k.e), d: big(k.d) }; }

/** Voter side: blind the credential token. Keep `r` secret until unblinding. */
export function blind(token: string, key: BallotPublicKey): { blinded: string; r: string } {
  const n = big(key.n); const e = big(key.e); let r: bigint;
  do { r = BigInt(`0x${randomBytes(byteLength(n)).toString('hex')}`) % n; } while (r < 2n || gcd(r, n) !== 1n);
  return { blinded: b64((fullDomainHash(token, n) * modPow(r, e, n)) % n), r: b64(r) };
}
/** Issuer side: sign a blinded value without learning the token. */
export function signBlinded(blinded: string, privateJwk: string): string {
  const key = parsePrivate(privateJwk); const m = big(blinded);
  if (m <= 1n || m >= key.n) throw new Error('Invalid blinded value');
  return b64(modPow(m, key.d, key.n));
}
export function unblind(blindSignature: string, r: string, key: BallotPublicKey): string {
  const n = big(key.n); return b64((big(blindSignature) * modInverse(big(r), n)) % n);
}
export function verifyCredential(token: string, signature: string, key: BallotPublicKey): boolean {
  if (!/^[A-Za-z0-9_-]{43,64}$/.test(token) || !/^[A-Za-z0-9_-]{1,400}$/.test(signature)) return false;
  const n = big(key.n); const s = big(signature);
  return s > 0n && s < n && modPow(s, big(key.e), n) === fullDomainHash(token, n);
}
/** Pseudonym that links a voter's pre and post ballots to each other, never to the voter. */
export function pseudonymOf(token: string): string { return createHash('sha256').update(`lde-ballot-pseudonym-v1|${token}`).digest('hex'); }
export function receiptOf(pseudonym: string, round: string, choice: string): string { return createHash('sha256').update(`lde-ballot-receipt-v1|${pseudonym}|${round}|${choice}`).digest('hex'); }

/** Seal the issuer key at rest with a key derived from the server secret (AES-256-GCM). */
function sealKey(secret: string): Buffer { return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('lde-ballot-seal-v1'), 32)); }
export function sealPrivateKey(privateJwk: string, secret: string, context: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv); cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(privateJwk, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}
export function openPrivateKey(sealed: string, secret: string, context: string): string {
  const [version, iv, body, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('Invalid sealed key');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), Buffer.from(iv, 'base64url')); decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
