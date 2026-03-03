import type { Context, ScheduledEvent } from "aws-lambda";

export const handler = async (event: ScheduledEvent, context: Context) => {
  const now = new Date().toISOString();

  console.log("Heartbeat Lambda ran");
  console.log("time:", now);
  console.log("requestId:", context.awsRequestId);
  console.log("event:", JSON.stringify(event));

  return { ok: true, time: now };
};