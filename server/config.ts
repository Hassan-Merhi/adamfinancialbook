import { z } from 'zod';

const blankAsUndefined = (value: unknown) => value === '' ? undefined : value;

const schema = z.object({
  NODE_ENV: z.preprocess(blankAsUndefined, z.enum(['development', 'test', 'production']).default('development')),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters.'),
  PORT: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().max(65535).default(5000)),
  PGSSL: z.preprocess(blankAsUndefined, z.enum(['verify', 'no-verify', 'off']).default('verify')),
  PGPOOL_MAX: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().max(50).default(8)),
});

export type AppConfig = z.infer<typeof schema>;

export function validateEnvironment(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  return parsed.data;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = validateEnvironment(process.env);
  return cached;
}
