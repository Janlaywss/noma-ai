/**
 * Telegram doesn't sign webhook requests — the auth model is the URL secret
 * path (`?secret=...`). We embed a per-user opaque slug in the webhook URL
 * so only the Telegram servers (which got the URL via setWebhook) can hit
 * it for that user. Rotate the slug by clearing channel_configs.webhook_slug.
 */

export async function telegramSendText(params: {
  botToken: string;
  chatId: string;
  text: string;
}): Promise<void> {
  const { botToken, chatId, text } = params;
  const resp = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  if (!resp.ok) throw new Error(`telegram send: ${resp.status}`);
}
