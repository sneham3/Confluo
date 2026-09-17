import { hash, verify } from '@node-rs/argon2';
import { and, count, eq, isNull } from 'drizzle-orm';
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { AppError, pickColor } from '@confluo/shared';
import { refreshTokens, users } from '@confluo/shared/db';
import type { ApiDeps, AuthUser } from '../types.js';
import { randomToken, sha256 } from '../lib/crypto.js';

// algorithm 2 = Argon2id (const enum in @node-rs/argon2; numeric literal avoids the ambient enum import)
const ARGON_OPTS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 };
type PrivateKey = Awaited<ReturnType<typeof importPKCS8>>;
type PublicKey = Awaited<ReturnType<typeof importSPKI>>;
const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_COOKIE = 'confluo_refresh';

export class AuthService {
  private privateKey!: PrivateKey;
  private publicKey!: PublicKey;
  private dummyHash = '';

  constructor(private readonly deps: ApiDeps) {}

  async init() {
    this.privateKey = await importPKCS8(this.deps.config.jwtPrivateKeyPem, 'ES256');
    this.publicKey = await importSPKI(this.deps.config.jwtPublicKeyPem, 'ES256');
    this.dummyHash = await hash('dummy-password-for-constant-time', ARGON_OPTS);
  }

  hashPassword(pw: string) {
    return hash(pw, ARGON_OPTS);
  }

  async signAccessToken(user: AuthUser): Promise<string> {
    return new SignJWT({ name: user.name })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(user.id)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AuthUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { algorithms: ['ES256'] });
      if (!payload.sub) return null;
      return { id: payload.sub, name: typeof payload.name === 'string' ? payload.name : '' };
    } catch {
      return null;
    }
  }

  async register(input: { email: string; password: string; displayName: string }) {
    const db = this.deps.adapters.db;
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new AppError('CONFLICT', 409, 'An account with this email already exists');
    const countRows = await db.select({ value: count() }).from(users);
    const userCount = countRows[0]?.value ?? 0;
    const passwordHash = await this.hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash, displayName: input.displayName, color: pickColor(Number(userCount)) })
      .returning();
    return row!;
  }

  async login(input: { email: string; password: string }) {
    const db = this.deps.adapters.db;
    const email = input.email.trim().toLowerCase();
    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!row) {
      await verify(this.dummyHash, input.password).catch(() => false);
      throw new AppError('UNAUTHENTICATED', 401, 'Invalid email or password');
    }
    const ok = await verify(row.passwordHash, input.password).catch(() => false);
    if (!ok) throw new AppError('UNAUTHENTICATED', 401, 'Invalid email or password');
    return row;
  }

  /** Create a fresh refresh family and return the raw token. */
  async issueRefresh(userId: string, userAgent?: string | null, familyId: string = randomUUID()) {
    const raw = randomToken(32);
    await this.deps.adapters.db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(raw),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: userAgent ?? null,
    });
    return raw;
  }

  /** Rotate: returns {userId, raw} or throws 401. Reuse of a revoked token revokes the family. */
  async rotateRefresh(raw: string, userAgent?: string | null) {
    const db = this.deps.adapters.db;
    const [tok] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(raw))).limit(1);
    if (!tok) throw new AppError('UNAUTHENTICATED', 401, 'Invalid session');
    if (tok.revokedAt) {
      // Two tabs (or a dev double-mount) can legitimately race a refresh with the same cookie.
      // Within a short grace window we treat that as benign and issue another token in the family;
      // beyond it, presenting a rotated token is reuse and the whole family is revoked.
      const graceMs = Number(process.env.REFRESH_REUSE_GRACE_MS ?? 10_000);
      const sinceRotation = Date.now() - tok.revokedAt.getTime();
      if (sinceRotation > graceMs) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.familyId, tok.familyId), isNull(refreshTokens.revokedAt)));
        throw new AppError('UNAUTHENTICATED', 401, 'Session reuse detected; please log in again');
      }
    }
    if (tok.expiresAt.getTime() < Date.now()) throw new AppError('UNAUTHENTICATED', 401, 'Session expired');
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, tok.id));
    const next = await this.issueRefresh(tok.userId, userAgent, tok.familyId);
    const [user] = await db.select().from(users).where(eq(users.id, tok.userId)).limit(1);
    if (!user) throw new AppError('UNAUTHENTICATED', 401, 'Invalid session');
    return { user, raw: next };
  }

  async revokeFamilyByRaw(raw: string) {
    const db = this.deps.adapters.db;
    const [tok] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(raw))).limit(1);
    if (!tok) return;
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, tok.familyId), isNull(refreshTokens.revokedAt)));
  }
}
