import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

export interface JwtKeys {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Load ES256 keys from env, else from `${dataDir}/jwt-*.pem`, generating a dev pair when missing. */
export async function ensureJwtKeys(
  dataDir: string,
  env: { JWT_PRIVATE_KEY?: string; JWT_PUBLIC_KEY?: string } = process.env,
): Promise<JwtKeys> {
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
    return {
      privateKeyPem: env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      publicKeyPem: env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
    };
  }
  await mkdir(dataDir, { recursive: true });
  const privPath = path.join(dataDir, 'jwt-private.pem');
  const pubPath = path.join(dataDir, 'jwt-public.pem');
  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      readFile(privPath, 'utf8'),
      readFile(pubPath, 'utf8'),
    ]);
    return { privateKeyPem, publicKeyPem };
  } catch {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    const publicKeyPem = await exportSPKI(publicKey);
    await writeFile(privPath, privateKeyPem);
    await writeFile(pubPath, publicKeyPem);
    return { privateKeyPem, publicKeyPem };
  }
}
