import { Router } from "express";
import { makeHandler, type HandleCtx } from "./_handler";
import { OpenAIChatBodySchema, openaiToInternal } from "../protocol/openai-in";
import {
  collectInternalToOpenAIJson,
  streamInternalToOpenAISSE,
  writeSSEHeaders,
} from "../protocol/openai-out";

export function chatRouter(ctx: HandleCtx) {
  const r = Router();
  const handler = makeHandler(ctx, {
    parse: (body) => {
      const parsed = OpenAIChatBodySchema.parse(body);
      return openaiToInternal(parsed);
    },
    writeStream: (res, model, stream) => streamInternalToOpenAISSE(res, model, stream),
    writeJson: async (res, model, stream) => {
      const body = await collectInternalToOpenAIJson(model, stream);
      res.json(body);
    },
    writeSSEHeaders,
    errorBody: (status, code, message) => ({
      error: { type: code, code, message, status },
    }),
  });
  r.post("/v1/chat/completions", handler);
  return r;
}
