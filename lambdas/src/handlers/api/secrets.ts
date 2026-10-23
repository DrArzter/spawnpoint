import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssm } from "./clients.ts";

const botTokenParameter = process.env.BOT_TOKEN_PARAMETER;
if (!botTokenParameter) throw new Error("missing environment variable: BOT_TOKEN_PARAMETER");
const sessionSigningSecretParameter = process.env.SESSION_SIGNING_SECRET_PARAMETER;
if (!sessionSigningSecretParameter) throw new Error("missing environment variable: SESSION_SIGNING_SECRET_PARAMETER");

let botTokenPromise: Promise<string> | undefined;

let sessionSigningSecretPromise: Promise<string> | undefined;

export function botToken(): Promise<string> {
  botTokenPromise ??= ssm.send(new GetParameterCommand({ Name: botTokenParameter, WithDecryption: true })).then((result) => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Telegram bot token parameter is empty");
    return value;
  });
  return botTokenPromise;
}

export function sessionSigningSecret(): Promise<string> {
  sessionSigningSecretPromise ??= ssm.send(new GetParameterCommand({ Name: sessionSigningSecretParameter, WithDecryption: true })).then((result) => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Session signing secret parameter is empty");
    return value;
  });
  return sessionSigningSecretPromise;
}
