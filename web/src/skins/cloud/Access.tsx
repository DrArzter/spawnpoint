import type { AccessModel } from "../../core/models";
import { StubPage } from "./Stub";

// S1 stand-in; S6 builds Access here.
export function Access({ model }: Readonly<{ model: AccessModel }>) {
  const { notifications, roles } = model;
  const toggles = [
    ...notifications.games.flatMap((game) => [notifications.toggle(`${game.id}.started`, `${game.displayName} started`), notifications.toggle(`${game.id}.stopped`, `${game.displayName} stopped`)]),
    notifications.toggle("invitation.broadcast", "Everyone"),
    notifications.toggle("invitation.direct", "Me"),
  ];
  const reads = roles.roles.status === "ready" ? roles.roles.value.map((role) => roles.read(role)) : [];
  return <StubPage model={model} more={[...toggles, ...reads]} title="Access" />;
}
