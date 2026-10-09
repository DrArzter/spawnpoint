import { Timestamp } from "../../components/ui/Timestamp";
import type { WhitelistModel, WhitelistRow } from "../../core/models";
import { Col, Empty, Field, Notice, Panel, Person, Table, TextInput, Verb } from "./ui";

// A world's whitelist (ADR-0066): who may join, kept on the world's record so
// it follows the world to every host.
export function WhitelistPanel({ model }: Readonly<{ model: WhitelistModel }>) {
  const list = model.list;
  const columns: readonly Col<WhitelistRow>[] = [
    { id: "player", label: "Player", render: (row) => <Person name={row.name} /> },
    { id: "verbs", label: "Actions", verbs: true, corner: true, render: (row) => <Verb action={row.remove} size="small" tone="danger" /> },
  ];
  const changed = list.status === "ready" && list.value.updatedAt
    ? <>Changed by {list.value.updatedBy ?? "someone"} <Timestamp value={list.value.updatedAt} /></>
    : undefined;
  return <>
    {list.status === "ready" && !list.value.managed && (
      <Notice
        description="The first name you add makes this list the whole whitelist. Names added on the server by hand are dropped at its next start."
        title="Spawnpoint does not keep this world's whitelist yet"
        tone="warning"
      />
    )}
    <Panel name="Add a player">
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); model.add.run(); }}>
        <Field error={model.draftError} label="Player name">
          <TextInput
            aria-invalid={model.draftError ? true : undefined}
            autoCapitalize="off"
            autoComplete="off"
            maxLength={16}
            mono
            onChange={(event) => model.setDraft(event.target.value)}
            placeholder="As the player types it"
            spellCheck={false}
            value={model.draft}
          />
        </Field>
        <Verb action={model.add} className="t-entry-verb" tone="primary" type="submit" />
      </form>
    </Panel>
    {list.status === "error"
      ? <Notice description={list.error} title="The whitelist is unavailable" tone="error" verbs={<Verb action={list.retry} size="small" />} />
      : <Panel description={changed} flush name="Whitelist">
        <Table
          columns={columns}
          empty={list.status === "ready" && list.value.managed
            ? <Empty description="The whitelist is on and has no names." title="Nobody can join" />
            : <Empty title="No names kept here yet" />}
          label={`Whitelist of ${model.world.displayName}`}
          loading={list.status === "loading"}
          rowKey={(row) => row.name}
          rows={list.status === "ready" ? list.value.rows : []}
        />
      </Panel>}
  </>;
}
