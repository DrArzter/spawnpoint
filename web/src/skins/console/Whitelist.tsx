import { Column, DataTable } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Fields";
import { Banner, Card, EmptyState } from "../../components/ui/Surfaces";
import { Timestamp } from "../../components/ui/Timestamp";
import type { WhitelistModel, WhitelistRow } from "../../core/models";
import { ActionButton } from "./actions";
import { Person } from "./Person";

// A world's whitelist (ADR-0066): who may join, kept on the world's record so
// it follows the world to every host.
export function WhitelistPanel({ model }: Readonly<{ model: WhitelistModel }>) {
  const list = model.list;
  const columns: Column<WhitelistRow>[] = [
    { id: "player", label: "Player", render: (row) => <Person name={row.name} /> },
    { id: "actions", label: "Actions", actions: true, render: (row) => <ActionButton action={row.remove} size="small" variant="text" /> },
  ];
  const changed = list.status === "ready" && list.value.updatedAt
    ? <>Changed by {list.value.updatedBy ?? "someone"} <Timestamp value={list.value.updatedAt} /></>
    : undefined;
  return (
    <div className="page">
      {list.status === "ready" && !list.value.managed && (
        <Banner
          description="The first name you add makes this list the whole whitelist. Names added on the server by hand are dropped at its next start."
          title="Spawnpoint does not keep this world's whitelist yet"
          tone="warning"
        />
      )}
      <Card title="Add a player">
        <form className="entry-form" onSubmit={(event) => { event.preventDefault(); model.add.run(); }}>
          <TextField
            autoCapitalize="off"
            autoComplete="off"
            error={model.draftError}
            label="Player name"
            maxLength={16}
            mono
            onChange={(event) => model.setDraft(event.target.value)}
            placeholder="As the player types it"
            spellCheck={false}
            value={model.draft}
          />
          <ActionButton action={model.add} type="submit" variant="filled" />
        </form>
      </Card>
      {list.status === "error"
        ? <Banner actions={<ActionButton action={list.retry} variant="text" />} description={list.error} title="The whitelist is unavailable" tone="error" />
        : <Card description={changed} flush title="Whitelist">
          <DataTable
            columns={columns}
            empty={list.status === "ready" && list.value.managed
              ? <EmptyState description="The whitelist is on and has no names." icon="group" title="Nobody can join" />
              : <EmptyState icon="group" title="No names kept here yet" />}
            label={`Whitelist of ${model.world.displayName}`}
            loading={list.status === "loading"}
            rowKey={(row) => row.name}
            rows={list.status === "ready" ? list.value.rows : []}
          />
        </Card>}
    </div>
  );
}
