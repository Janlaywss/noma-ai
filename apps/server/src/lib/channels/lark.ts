import crypto from "node:crypto";

/**
 * Verify Lark event-subscription payload signature. Lark posts a JSON body
 * plus three headers (`X-Lark-Request-Timestamp`, `X-Lark-Request-Nonce`,
 * `X-Lark-Signature`). The signature is hex(sha256(timestamp + nonce +
 * encryptKey + body)).
 *
 * https://open.larksuite.com/document/server-docs/event-subscription-guide/request-url-configuration-case
 */
export function verifyLarkSignature(params: {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  rawBody: string;
  encryptKey: string;
}): boolean {
  const { timestamp, nonce, signature, rawBody, encryptKey } = params;
  if (!timestamp || !nonce || !signature) return false;
  const h = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + rawBody, "utf8")
    .digest("hex");
  return safeEqual(h, signature);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function larkTenantAccessToken(
  appId: string,
  appSecret: string
): Promise<string> {
  const resp = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  if (!resp.ok) throw new Error(`lark token: ${resp.status}`);
  const body = (await resp.json()) as { tenant_access_token?: string };
  if (!body.tenant_access_token) throw new Error("lark: missing token");
  return body.tenant_access_token;
}

export async function larkSendText(params: {
  token: string;
  chatId: string;
  text: string;
}): Promise<void> {
  const { token, chatId, text } = params;
  const resp = await fetch(
    `https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    }
  );
  if (!resp.ok) throw new Error(`lark send: ${resp.status}`);
}
