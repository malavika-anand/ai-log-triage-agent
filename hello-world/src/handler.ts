import type { Context, ScheduledEvent } from "aws-lambda";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

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
  // Keep it simple: trim + collapse spaces + cap length
  const s = msg.replace(/\s+/g, " ").trim();
  return s.length > 180 ? s.slice(0, 180) + "…" : s;
}

export const handler = async (event: ScheduledEvent, context: Context) => {
  
  console.log("ERROR demo error line for testing");
  
  const logGroup = process.env.TARGET_LOG_GROUP;
  const windowMinutes = Number(process.env.WINDOW_MINUTES ?? "10");
  const maxSamples = Number(process.env.MAX_SAMPLES ?? "40");

  if (!logGroup) {
    throw new Error("Missing env var TARGET_LOG_GROUP");
  }

  const endTime = Date.now();
  const startTime = endTime - windowMinutes * 60 * 1000;

  const client = new CloudWatchLogsClient({});

  // Simple filter: match common error words.
  // You can tune later (ERROR, Exception, failed, timeout, etc.)
  const filterPattern = '?"ERROR" ?"Error" ?"Exception" ?"failed" ?"timeout"';

  const resp = await client.send(
    new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime,
      endTime,
      filterPattern,
      limit: 200, // keep small for free-tier + speed
      interleaved: true,
    })
  );

  const messages =
    resp.events
      ?.map((e) => e.message ?? "")
      .map(normalizeErrorLine)
      .filter(Boolean) ?? [];

  // Count occurrences (simple signature = normalized line)
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

  return { ok: true, requestId: context.awsRequestId, errorCount: evidence.errorCount };
};