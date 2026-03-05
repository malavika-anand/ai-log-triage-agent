import type { Context, ScheduledEvent } from "aws-lambda";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import OpenAI from "openai";
import crypto from "crypto";
import { IncidentReportSchema, type IncidentReport } from "./incidentSchema";

type TopError = { message: string; count: number };

type Evidence = {
  service: string;
  logGroup: string;
  windowMinutes: number;
  startTimeIso: string;
  endTimeIso: string;
  errorCount: number;
  topErrors: TopError[];
  sampleLines: string[];
};

function normalizeErrorLine(msg: string): string {
  const s = msg.replace(/\s+/g, " ").trim();
  return s.length > 180 ? s.slice(0, 180) + "…" : s;
}

function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0.3;
  return Math.max(0, Math.min(1, x));
}

function generateIncidentSignature(service: string, topError: string) {
  const hash = crypto
    .createHash("sha256")
    .update(service + ":" + topError)
    .digest("hex");
  return hash.slice(0, 16);
}

function normalizeReport(
  raw: any,
  signature: string,
  evidence: Evidence
): IncidentReport {
  const topErrs = evidence.topErrors.map((e) => e.message);

  const normalized = {
    incidentTitle: raw?.incidentTitle ?? "Log Errors Detected",
    severity: raw?.severity ?? "MEDIUM",
    summary: raw?.summary ?? "Errors detected in logs. Manual review recommended.",
    likelyCauses:
      Array.isArray(raw?.likelyCauses) && raw.likelyCauses.length > 0
        ? raw.likelyCauses
        : ["Unknown"],
    recommendedActions:
      Array.isArray(raw?.recommendedActions) && raw.recommendedActions.length > 0
        ? raw.recommendedActions
        : ["Inspect CloudWatch logs for details"],
    confidence: clamp01(raw?.confidence),
    evidenceUsed: raw?.evidenceUsed ?? {
      topErrors: topErrs,
      sampleIndices: topErrs.length ? [0] : [],
    },
    signature: raw?.signature ?? signature,
  };

  return IncidentReportSchema.parse(normalized);
}

export const handler = async (event: ScheduledEvent, context: Context) => {
  const logGroup = process.env.TARGET_LOG_GROUP;
  const windowMinutes = Number(process.env.WINDOW_MINUTES ?? "10");
  const maxSamples = Number(process.env.MAX_SAMPLES ?? "40");

  if (!logGroup) throw new Error("Missing env var TARGET_LOG_GROUP");

  const endTime = Date.now();
  const startTime = endTime - windowMinutes * 60 * 1000;

  const logsClient = new CloudWatchLogsClient({});
  const filterPattern = '?"ERROR" ?"Error" ?"Exception" ?"failed" ?"timeout"';

  const resp = await logsClient.send(
    new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime,
      endTime,
      filterPattern,
      limit: 50,
      interleaved: true,
    })
  );

  const messages =
    resp.events
      ?.map((e) => e.message ?? "")
      .map(normalizeErrorLine)
      .filter(Boolean) ?? [];

  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);

  const topErrors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count }));

  const sampleLines = messages.slice(0, maxSamples);

  const evidence: Evidence = {
    service: "lambda",
    logGroup,
    windowMinutes,
    startTimeIso: new Date(startTime).toISOString(),
    endTimeIso: new Date(endTime).toISOString(),
    errorCount: messages.length,
    topErrors,
    sampleLines,
  };

  console.log("Evidence JSON:");
  console.log(JSON.stringify(evidence, null, 2));

  const minErrorsForAi = Number(process.env.MIN_ERRORS_FOR_AI ?? "1");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (evidence.errorCount < minErrorsForAi) {
    console.log("Skipping AI: not enough errors");
    return { ok: true, errorCount: evidence.errorCount, aiUsed: false };
  }

  const remainingMs = context.getRemainingTimeInMillis();
  if (remainingMs < 8000) {
    console.log("Skipping AI: low time budget");
    return { ok: true, errorCount: evidence.errorCount, aiUsed: false };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing env var OPENAI_API_KEY");

  const signature = generateIncidentSignature(
    evidence.service,
    evidence.topErrors[0]?.message ?? "unknown"
  );

  const evidenceForAi = {
    service: evidence.service,
    logGroup: evidence.logGroup,
    windowMinutes: evidence.windowMinutes,
    startTimeIso: evidence.startTimeIso,
    endTimeIso: evidence.endTimeIso,
    errorCount: evidence.errorCount,
    topErrors: evidence.topErrors,
    sampleLines: evidence.sampleLines.slice(0, 10),
  };

  const aiClient = new OpenAI({ apiKey });

  const instructions =
    "You are an incident response assistant. Produce a concise incident report " +
    "based strictly on the provided evidence. Do not invent details. " +
    "Return ONLY valid JSON (no markdown).";

  const response = await aiClient.responses.create({
    model,
    instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Return ONLY valid JSON.\n" +
              "Rules:\n" +
              "- confidence must be between 0 and 1.\n" +
              "- evidenceUsed must be present.\n" +
              `- signature must equal: ${signature}\n` +
              "Schema:\n" +
              '{"incidentTitle":string,"severity":"LOW|MEDIUM|HIGH|CRITICAL","summary":string,"likelyCauses":string[],"recommendedActions":string[],"confidence":number,"evidenceUsed":{"topErrors":string[],"sampleIndices":number[]},"signature":string}\n' +
              "Evidence:\n" +
              JSON.stringify(evidenceForAi),
          },
        ],
      },
    ],
  });

  const text = response.output_text?.trim();
  let report: IncidentReport;

  if (!text) {
    console.log("AI returned empty output. Using fallback report.");
    report = normalizeReport(null, signature, evidence);
  } else {
    const parsed = safeJsonParse(text);
    if (!parsed) {
      console.log("AI returned invalid JSON. Using fallback report.");
      report = normalizeReport(null, signature, evidence);
    } else {
      try {
        report = normalizeReport(parsed as any, signature, evidence);
      } catch {
        console.log("AI JSON failed validation. Using fallback report.");
        report = normalizeReport(null, signature, evidence);
      }
    }
  }

  console.log("Incident Report JSON:");
  console.log(JSON.stringify(report, null, 2));

  return {
    ok: true,
    errorCount: evidence.errorCount,
    aiUsed: true,
    severity: report.severity,
    signature: report.signature,
  };
};