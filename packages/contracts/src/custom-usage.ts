import { z } from "zod";
import { ModelQuotaWindowSchema } from "./model-quota.js";

export const CustomUsageConfigSchema = z.object({
  endpoint: z.string().url(),
  token: z.string().nullable(),
});
export const CustomUsagePayloadSchema = z.object({
  windows: z
    .array(
      z.object({
        id: ModelQuotaWindowSchema.shape.id,
        usedPercent: ModelQuotaWindowSchema.shape.usedPercent,
        resetsAt: ModelQuotaWindowSchema.shape.resetsAt.optional(),
      }),
    )
    .min(1)
    .max(32),
});
