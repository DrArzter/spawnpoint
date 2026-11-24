import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";

import type { ConsoleGateway, ConsoleInvocation, ConsoleTarget } from "./console.ts";

// The world id reaches a shell command on the host through the document's
// parameters, so its shape is checked here as well as by load_world there.
const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

type Documents = Readonly<{ console: () => string; whitelist: () => string }>;

/** The console gateway over SSM Run Command: one fixed document each (ADR-0063, ADR-0066). */
export function ssmConsoleGateway(ssm: SSMClient, documents: Documents): ConsoleGateway {
  const run = async (document: string, target: ConsoleTarget, parameters: Record<string, string[]>, comment: string): Promise<string> => {
    if (!WORLD_ID.test(target.worldId)) throw new Error(`invalid world id: ${target.worldId}`);
    const sent = await ssm.send(new SendCommandCommand({
      DocumentName: document,
      InstanceIds: [target.hostId],
      Parameters: { worldId: [target.worldId], slot: [target.slot], ...parameters },
      TimeoutSeconds: 60,
      Comment: `${comment} ${target.worldId}`,
    }));
    const commandId = sent.Command?.CommandId;
    if (!commandId) throw new Error(`${comment} did not return an id`);
    return commandId;
  };
  return {
    send: (target, encodedCommand) => run(documents.console(), target, { command: [encodedCommand] }, "console"),
    reloadWhitelist: (target) => run(documents.whitelist(), target, {}, "whitelist"),
    read: async (commandId, hostId): Promise<ConsoleInvocation> => {
      try {
        const invocation = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: hostId }));
        return {
          status: invocation.Status ?? "Pending",
          responseCode: invocation.ResponseCode ?? null,
          output: invocation.StandardOutputContent ?? "",
          error: invocation.StandardErrorContent ?? "",
        };
      } catch (error) {
        // A command just sent may not have reached the host's invocation list yet.
        if (error instanceof Error && error.name === "InvocationDoesNotExist") return { status: "Pending", responseCode: null, output: "", error: "" };
        throw error;
      }
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

/** The deployed gateway: the documents are read when a command is sent, not at load. */
export const awsConsoleGateway: ConsoleGateway = ssmConsoleGateway(new SSMClient({}), {
  console: () => requiredEnv("CONSOLE_DOCUMENT_NAME"),
  whitelist: () => requiredEnv("WHITELIST_DOCUMENT_NAME"),
});
