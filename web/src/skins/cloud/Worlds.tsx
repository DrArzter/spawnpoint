import type { WorldsModel } from "../../core/models";
import { StubPage } from "./Stub";
import { Notices } from "./ui/Notice";

// S1 stand-in; S3 builds the game home and the Worlds list here.
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const requests = model.requests?.status === "ready" ? model.requests.value : [];
  const more = [
    ...model.rows.flatMap((row) => row.sessionAction ? [row.sessionAction()] : []),
    ...requests.flatMap((request) => {
      const verbs = model.requestActions?.(request.id);
      return verbs ? [verbs.approve, verbs.dismiss] : [];
    }),
  ];
  return (
    <StubPage model={model} more={more} title={model.view === "overview" ? model.game?.displayName ?? "Home" : "Worlds"}>
      <Notices notices={model.notices} />
      <ul className="c-stub-names">{model.rows.map((row) => <li key={row.world.id}><a href={row.href}>{row.world.displayName}</a></li>)}</ul>
    </StubPage>
  );
}
