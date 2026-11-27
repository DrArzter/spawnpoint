import type { WorldModel } from "../../../core/models";
import { wipeStatus } from "../../../core/worlds";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty } from "../ui/Empty";
import { Status } from "../ui/Status";
import { Table } from "../ui/Table";
import { t } from "../../../i18n";

export function WipesTab({ model }: Readonly<{ model: WorldModel }>) {
  const wipe = model.more.find((item) => item.id === "world.wipe");
  return (
    <Card actions={wipe && <ActionButton action={wipe} size="sm" />} body="flush" fill count={model.wipes.length} title={t("world.wipes")}>
      <Table
        columns={[
          { id: "wipe", header: t("common.wipe"), kind: "lead", render: (row) => <strong>#{row.wipe.number}</strong> },
          { id: "state", header: t("common.state"), render: (row) => <Status status={wipeStatus(row.wipe)} /> },
          { id: "created", header: t("common.created"), render: (row) => shortDateTime(row.wipe.createdAt) ?? "—" },
          { id: "closed", header: t("world.closed"), kind: "wide", render: (row) => shortDateTime(row.wipe.closedAt) ?? <span className="c-faint">—</span> },
          { id: "origin", header: t("world.originRelease"), render: (row) => <span className="c-mono">{row.wipe.originRelease}</span> },
          { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <ActionButton action={row.showBackups} size="sm" /> },
        ]}
        empty={<Empty icon="layers" title={t("world.noWipes")} />}
        label={t("world.wipes")}
        rowKey={(row) => row.wipe.id}
        rows={[...model.wipes].sort((a, b) => b.wipe.number - a.wipe.number)}
      />
    </Card>
  );
}
