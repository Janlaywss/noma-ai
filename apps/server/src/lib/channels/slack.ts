import crypto from "node:crypto";

/**
 * Verify a Slack request per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 *   v0:{timestamp}:{raw body}   — HMAC-SHA256 with signing_secret → hex
 *   compared to `X-Slack-Signature` (prefixed with "v0=").
 *
 * Reject requests whose timestamp is older than 5 minutes to block replay.
 */
export function verifySlackSignature(params: {
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  signingSecret: string;
}): boolean {
  const { timestamp, signature, rawBody, signingSecret } = params;
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const h =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(base, "utf8")
      .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function slackSendText(params: {
  botToken: string;
  channel: string;
  text: string;
}): Promise<void> {
  const { botToken, channel, text } = params;
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  if (!resp.ok) throw new Error(`slack send: ${resp.status}`);
}
