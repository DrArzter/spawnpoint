import { Timestamp } from "../../components/ui/Timestamp";
import type { WhitelistModel, WhitelistRow } from "../../core/models";
import { Col, Empty, Field, LoadError, Overflow, Panel, Person, Table, TextInput, Verb } from "./ui";
import { rich, t } from "../../i18n";

// A world's whitelist (ADR-0066): who may join, kept on the world's record so
// it follows the world to every host.
export function WhitelistPanel({ model }: Readonly<{ model: WhitelistModel }>) {
  const list = model.list;
  const columns: readonly Col<WhitelistRow>[] = [
    { id: "player", label: t("common.player"), render: (row) => <Person name={row.name} /> },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[[row.remove]]} label={t("common.actionsMemberName", { memberName: row.name })} size="small" /> },
  ];
  const changed = list.status === "ready" && list.value.updatedAt
    ? rich("whitelist.changedBy", { who: list.value.updatedBy ?? t("whitelist.someone"), time: <Timestamp value={list.value.updatedAt} /> })
    : undefined;
  return <>
    <Panel name={t("whitelist.addPlayer2")}>
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); model.add.run(); }}>
        <Field error={model.draftError} label={t("whitelist.playerName")}>
          <TextInput
            aria-invalid={model.draftError ? true : undefined}
            autoCapitalize="off"
            autoComplete="off"
            maxLength={16}
            mono
            onChange={(event) => model.setDraft(event.target.value)}
            placeholder={t("whitelist.asPlayerTypes")}
            spellCheck={false}
            value={model.draft}
          />
        </Field>
        <Verb action={model.add} className="t-entry-verb" tone="primary" type="submit" />
      </form>
    </Panel>
    {list.status === "error"
      ? <LoadError state={list} title={t("whitelist.whitelistCouldNotLoaded2")} verb={t("whitelist.readWhitelist")} />
      : <Panel description={changed} flush name={t("common.whitelist")}>
        <Table
          columns={columns}
          empty={list.status === "ready" && list.value.managed
            ? <Empty description={t("whitelist.whitelistHasNoNames")} title={t("whitelist.nobodyCanJoin")} />
            : <Empty title={t("whitelist.noNames")} />}
          label={t("whitelist.whitelistWorldDisplayName", { worldDisplayName: model.world.displayName })}
          loading={list.status === "loading"}
          rowKey={(row) => row.name}
          rows={list.status === "ready" ? list.value.rows : []}
        />
      </Panel>}
  </>;
}
