import type { ReleasesModel } from "../../core/models";
import { StubPage } from "./Stub";

// S1 stand-in; S6 builds Releases here.
export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  return <StubPage model={model} title="Releases" />;
}
