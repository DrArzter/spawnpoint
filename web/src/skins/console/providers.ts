import type { IconName } from "../../icons";

// Sign-in providers and linked account kinds, by the id core gives them.
const icons: Readonly<Record<string, IconName>> = {
  telegram: "send",
  email: "mail",
  password: "mail",
  google: "account_circle",
  discord: "group",
  minecraft: "sports_esports",
  factorio: "sports_esports",
  steam: "sports_esports",
  zerotier: "hub",
};

const names: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  email: "Email",
  password: "Email",
  google: "Google",
  discord: "Discord",
  minecraft: "Minecraft",
  factorio: "Factorio",
  steam: "Steam",
  zerotier: "ZeroTier",
};

export function providerIcon(id: string): IconName {
  return icons[id] ?? "link";
}

export function providerName(id: string): string {
  return names[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
