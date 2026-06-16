import { Router } from "express";
import { makeHandler, type HandleCtx } from "./_handler";
import { AnthropicMessagesBodySchema, anthropicToInternal } from "../protocol/anthropic-in";
import {
  collectInternalToAnthropicJson,
  streamInternalToAnthropicSSE,
  writeSSEHeaders,
} from "../protocol/anthropic-out";

export function messagesRouter(ctx: HandleCtx) {
  const r = Router();
  const handler = makeHandler(ctx, {
    parse: (body) => {
      const parsed = AnthropicMessagesBodySchema.parse(body);
      return anthropicToInternal(parsed);
    },
    writeStream: (res, model, stream) => streamInternalToAnthropicSSE(res, model, stream),
    writeJson: async (res, model, stream) => {
      const body = await collectInternalToAnthropicJson(model, stream);
      res.json(body);
    },
    writeSSEHeaders,
    errorBody: (status, code, message) => ({
      type: "error",
      error: { type: code, message, status },
    }),
  });
  r.post("/v1/messages", handler);
  return r;
}
