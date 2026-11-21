import type { WorldModel } from "../../../core/models";
import { wipeStatus } from "../../../core/worlds";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty } from "../ui/Empty";
import { Status } from "../ui/Status";
import { Table } from "../ui/Table";

export function WipesTab({ model }: Readonly<{ model: WorldModel }>) {
  const wipe = model.more.find((item) => item.id === "world.wipe");
  return (
    <Card actions={wipe && <ActionButton action={wipe} size="sm" />} body="flush" count={model.wipes.length} title="Wipes">
      <Table
        columns={[
          { id: "wipe", header: "Wipe", kind: "lead", render: (row) => <strong>#{row.wipe.number}</strong> },
          { id: "state", header: "State", render: (row) => <Status status={wipeStatus(row.wipe)} /> },
          { id: "created", header: "Created", render: (row) => shortDateTime(row.wipe.createdAt) ?? "—" },
          { id: "closed", header: "Closed", kind: "wide", render: (row) => shortDateTime(row.wipe.closedAt) ?? <span className="c-faint">—</span> },
          { id: "origin", header: "Origin release", render: (row) => <span className="c-mono">{row.wipe.originRelease}</span> },
          { id: "actions", header: "Actions", kind: "act", render: (row) => <ActionButton action={row.showBackups} size="sm" /> },
        ]}
        empty={<Empty icon="layers" title="No wipes" />}
        label="Wipes"
        rowKey={(row) => row.wipe.id}
        rows={[...model.wipes].sort((a, b) => b.wipe.number - a.wipe.number)}
      />
    </Card>
  );
}
