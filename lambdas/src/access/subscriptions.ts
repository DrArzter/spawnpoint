import { gameCatalog, type CatalogGame } from "../control-plane/catalog.ts";

export function subscriptionKeys(catalog: readonly CatalogGame[] = gameCatalog): readonly string[] {
  return [
    ...catalog.flatMap((game) => [`${game.id}.started`, `${game.id}.stopped`]),
    "invitation.broadcast",
    "invitation.direct",
  ];
}

export function defaultSubscriptions(catalog: readonly CatalogGame[] = gameCatalog): Record<string, boolean> {
  return Object.fromEntries(subscriptionKeys(catalog).map((key) => [key, false]));
}

export function validateSubscriptions(value: unknown, catalog: readonly CatalogGame[] = gameCatalog): Record<string, boolean> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = subscriptionKeys(catalog);
  if (Object.keys(input).some((key) => !allowed.includes(key))) return null;
  if (Object.values(input).some((enabled) => typeof enabled !== "boolean")) return null;
  const normalized = defaultSubscriptions(catalog);
  for (const [key, enabled] of Object.entries(input)) normalized[key] = enabled as boolean;
  return normalized;
}
