import { Router } from "express";
import { makeHandler, type HandleCtx } from "./_handler";
import { ResponsesBodySchema, responsesToInternal } from "../protocol/responses-in";
import {
  collectInternalToResponsesJson,
  streamInternalToResponsesSSE,
  writeSSEHeaders,
} from "../protocol/responses-out";

export function responsesRouter(ctx: HandleCtx) {
  const r = Router();
  const handler = makeHandler(ctx, {
    parse: (body) => {
      const parsed = ResponsesBodySchema.parse(body);
      return responsesToInternal(parsed);
    },
    writeStream: (res, model, stream) => streamInternalToResponsesSSE(res, model, stream),
    writeJson: async (res, model, stream) => {
      const body = await collectInternalToResponsesJson(model, stream);
      res.json(body);
    },
    writeSSEHeaders,
    errorBody: (status, code, message) => ({
      error: { message, type: code, code, param: null },
    }),
  });
  r.post("/v1/responses", handler);
  return r;
}
