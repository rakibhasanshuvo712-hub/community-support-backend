import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  FIREBASE_PROJECT_ID: z.string().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().default(''),
  FIREBASE_PRIVATE_KEY: z.string().default(''),
  FIREBASE_WEB_API_KEY: z.string().default(''),
  FIREBASE_STORAGE_BUCKET: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  firebasePrivateKeyNormalized: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  firebaseStorageBucketResolved:
    parsed.data.FIREBASE_STORAGE_BUCKET ||
    (parsed.data.FIREBASE_PROJECT_ID ? `${parsed.data.FIREBASE_PROJECT_ID}.firebasestorage.app` : ''),
  corsOriginsList: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

export function isFirebaseConfigured(): boolean {
  return Boolean(
    env.FIREBASE_PROJECT_ID &&
      env.FIREBASE_CLIENT_EMAIL &&
      env.FIREBASE_PRIVATE_KEY &&
      !env.FIREBASE_PROJECT_ID.includes('your-firebase')
  );
}
