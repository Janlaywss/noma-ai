import { Hono } from "hono";
import { slackHandler } from "./slack";
import { telegramHandler } from "./telegram";
import { larkHandler } from "./lark";

const channels = new Hono();
channels.post("/slack/webhook/:slug", slackHandler);
channels.post("/telegram/webhook/:slug", telegramHandler);
channels.post("/lark/webhook/:slug", larkHandler);

export default channels;
