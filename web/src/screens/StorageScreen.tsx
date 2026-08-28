import { useState } from "react";
import { World } from "../model";
import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";

type Resource = { name: string; status: string; details: string; created: string; action?: string };

const releases: Resource[] = [
  { name: "1.1", status: "Desired", details: "111 mods · 594 MiB", created: "26 Aug 2026", action: "Promote" },
  { name: "1.0", status: "Active", details: "111 mods · 594 MiB", created: "13 Aug 2026" },
  { name: "0.9", status: "Archived", details: "108 mods · 581 MiB", created: "8 Aug 2026" },
];

const backups: Resource[] = [
  { name: "world-20260826T213152Z", status: "Verified", details: "418 MiB", created: "26 Aug 2026", action: "Restore" },
  { name: "world-20260825T201744Z", status: "Verified", details: "415 MiB", created: "25 Aug 2026", action: "Restore" },
  { name: "world-20260813T201024Z", status: "Verified", details: "398 MiB", created: "13 Aug 2026", action: "Restore" },
];

export function StorageScreen({ world }: { world: World }) {
  const [tab, setTab] = useState<"releases" | "backups">("releases");
  return <>
    <div className="page-heading"><h1>Releases</h1><p>Releases and verified backups for {world.title}</p></div>
    <Tabs label="Storage view" onChange={setTab} options={[{ id: "releases", label: "Releases" }, { id: "backups", label: "Backups" }]} value={tab} />
    <ResourceTable actionHint={tab === "releases" ? "Release promotion is not connected yet" : "Backup restore is not connected yet"} label={tab === "releases" ? "Releases" : "Backups"} rows={tab === "releases" ? releases : backups} />
  </>;
}

function ResourceTable({ actionHint, label, rows }: { actionHint: string; label: string; rows: Resource[] }) {
  const columns: DataColumn<Resource>[] = [
    { id: "name", label: label === "Releases" ? "Version" : "Backup", render: (row) => row.name, width: "1.4fr" },
    { id: "status", label: "Status", render: (row) => row.status, width: ".7fr" },
    { id: "details", label: label === "Releases" ? "Artifact" : "Size", render: (row) => row.details, width: "1.4fr" },
    { id: "created", label: "Created", render: (row) => row.created, width: "1fr" },
    { id: "action", label: "Action", render: (row) => row.action ? <Button disabled title={actionHint} variant="ghost">{row.action}</Button> : null, width: "100px" },
  ];
  return <DataTable columns={columns} label={label} rowKey={(row) => row.name} rows={rows} />;
}
