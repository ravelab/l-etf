import { z } from "zod/v4";

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export const pushSmaConfigSchema = z.object({
  smaSpPeriod: z.number().int().min(5).max(500),
  smaSpUpperBuffer: z.number().min(0).max(30),
  smaSpLowerBuffer: z.number().min(0).max(30),
  smaSpEnabled: z.boolean().default(true),
  smaNqPeriod: z.number().int().min(5).max(500),
  smaNqUpperBuffer: z.number().min(0).max(30),
  smaNqLowerBuffer: z.number().min(0).max(30),
  smaNqEnabled: z.boolean().default(true),
  notifyEveryClose: z.boolean().default(false),
  useCalibratedDefaults: z.boolean().default(false),
});

export const pushInstallIdSchema = z.string().uuid();

export const pushSubscribePayloadSchema = z.object({
  subscription: pushSubscriptionSchema,
  installId: pushInstallIdSchema,
  smaConfig: pushSmaConfigSchema,
});

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
