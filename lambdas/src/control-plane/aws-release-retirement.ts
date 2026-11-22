import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import type { ReleaseRef } from "./release-refs.ts";

// Asks the retirement Lambda to retire one release (ADR-0080). The call is
// asynchronous: retirement reads every world, pointer and archive, and runs for
// minutes. The API answers 202 and the Lambda's logs hold the outcome.

export type RetirementRequestPayload = Readonly<ReleaseRef & { confirmation: string; requestedBy: string }>;

let lambda: LambdaClient | undefined;

export const releaseRetirement = {
  /** InvocationType Event: Lambda queues it and answers 202. Throws when it cannot be queued. */
  async request(payload: RetirementRequestPayload): Promise<void> {
    const functionName = process.env.RELEASE_RETIREMENT_FUNCTION_NAME;
    if (!functionName) throw new Error("RELEASE_RETIREMENT_FUNCTION_NAME is required");
    lambda ??= new LambdaClient({});
    const sent = await lambda.send(new InvokeCommand({
      FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    if (sent.StatusCode !== 202) throw new Error("release retirement was not queued");
  },
};
