import { z } from 'zod';

export const AdapterEnvSchema = z.object({
  CONFLUO_MODE: z.enum(['local', 'cloud']).default('local'),
  DATA_DIR: z.string().default('.data'),
  API_URL: z.string().default('http://localhost:4000'),
  SERVICE_TOKEN: z.string().min(8).default('change-me-service-token'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(true),
});
export type AdapterEnv = z.infer<typeof AdapterEnvSchema>;
