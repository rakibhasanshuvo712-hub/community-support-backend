import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const boolFlag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default(''),
  JWT_SECRET: z.string().default('dev-insecure-jwt-secret-change-in-production'),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Applink (backend-only)
  APPLINK_FEATURES_ENABLED: boolFlag,
  APPLINK_OTP_ENABLED: boolFlag,
  APPLINK_DELIVERY_REPORTS_ENABLED: boolFlag,
  APPLINK_APP_ID: z.string().trim().default(''),
  APPLINK_PASSWORD: z.string().trim().default(''),
  APPLINK_SMS_SEND_URL: z.string().trim().default(''),
  APPLINK_OTP_REQUEST_URL: z.string().trim().default(''),
  APPLINK_OTP_VERIFY_URL: z.string().trim().default(''),
  APPLINK_SUBSCRIPTION_SEND_URL: z.string().trim().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOriginsList: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

export function isDatabaseConfigured(): boolean {
  return Boolean(
    env.DATABASE_URL &&
      !env.DATABASE_URL.includes('ep-example') &&
      env.DATABASE_URL.startsWith('postgres')
  );
}
