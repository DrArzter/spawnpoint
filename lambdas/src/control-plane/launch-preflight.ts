import { findGameModule } from "./game-modules.ts";

/**
 * The names of the parameters a host renders its .env from, never their values
 * (ADR-0106). The last segment of a name is the .env key.
 */
export type HostEnvKeys = Readonly<{ list: () => Promise<readonly string[]> }>;

/**
 * The game's required secrets that no host could render: checked before a
 * session is started, so a missing one costs a refusal rather than a host.
 * A game that needs none asks nothing.
 */
export async function missingGameSecrets(keys: HostEnvKeys, gameId: string): Promise<readonly string[]> {
  const required = findGameModule(gameId)?.requiredSecrets ?? [];
  if (required.length === 0) return [];
  const present = new Set(await keys.list());
  return required.filter((key) => !present.has(key));
}
