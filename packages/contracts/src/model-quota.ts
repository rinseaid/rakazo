import { z } from "zod";

export const ModelQuotaWindowSchema = z.object({
  id: z.string().min(1).max(128),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(),
  modelIds: z.array(z.string()).nullable(),
});
export type ModelQuotaWindow = z.infer<typeof ModelQuotaWindowSchema>;

export const ModelQuotaSchema = z.object({
  credentialId: z.string(),
  status: z.enum(["fresh", "stale", "unavailable", "unsupported"]),
  observedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime(),
  identityVerified: z.boolean(),
  windows: z.array(ModelQuotaWindowSchema),
});
export type ModelQuota = z.infer<typeof ModelQuotaSchema>;

export const ModelQuotaPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    reservePercent: z.number().min(0).max(99).default(10),
    requestPercent: z.number().positive().max(100).nullable().default(null),
    uncertaintyPercent: z.number().positive().max(100).default(1),
  })
  .refine((policy) => !policy.enabled || policy.requestPercent !== null, {
    message: "Set a request estimate before enabling quota routing",
  });
export type ModelQuotaPolicy = z.infer<typeof ModelQuotaPolicySchema>;
