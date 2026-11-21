import type { ProfileModel } from "../../core/models";
import { StubPage } from "./Stub";

// S1 stand-in; S7 builds Profile here.
export function Profile({ model }: Readonly<{ model: ProfileModel }>) {
  const accounts = model.loginAccounts.accounts;
  const rows = accounts.status === "ready" ? accounts.value.flatMap((account) => model.loginAccounts.rowActions(account)) : [];
  return <StubPage model={model} more={rows} title={model.member.name} />;
}
