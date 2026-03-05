import { z } from "zod";

export const IncidentReportSchema = z.object({
  incidentTitle: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  summary: z.string(),
  likelyCauses: z.array(z.string()).min(1),
  recommendedActions: z.array(z.string()).min(1),
  confidence: z.number(), 

  evidenceUsed: z
    .object({
      topErrors: z.array(z.string()),
      sampleIndices: z.array(z.number()),
    })
    .optional(),

  signature: z.string().optional(),
});

export type IncidentReport = z.infer<typeof IncidentReportSchema>;