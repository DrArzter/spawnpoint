import { useState } from "react";

import type { ConfigFileRow, ConfigFilesModel } from "../../../core/models";
import { formatBytes } from "../../../lib/format";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { applyFilter, FilterBar, type FilterToken } from "../ui/FilterBar";
import { Indicator } from "../ui/Indicator";
import { ConfigFileSheet } from "../ConfigSheet";
import { Table, type Column } from "../ui/Table";
import { t } from "../../../i18n";

/** What a world's own version of a file is: edited from the release's, or added. */
function changeLabel(row: ConfigFileRow): string {
  const by = row.updatedBy ? t("common.byUpdatedBy", { updatedBy: row.updatedBy }) : null;
  const when = row.updatedAt ? shortDateTime(row.updatedAt) : null;
  return [row.added ? t("config.addedWorld") : t("config.editedWorld"), by, when].filter(Boolean).join(" ");
}

const columns: readonly Column<ConfigFileRow>[] = [
  { id: "file", header: t("common.file"), kind: "lead", clip: true, render: (row) => <strong className="c-mono" title={row.path}>{row.path}</strong> },
  { id: "state", header: t("common.state"), render: (row) => (
    <span className="c-config-marks">
      {row.edited && <Indicator icon="edit" label={changeLabel(row)} />}
      {row.releaseChanged && <Indicator status={{ kind: "warning", label: t("config.releaseChangedFileAfter") }} />}
      {!row.edited && !row.releaseChanged && <span className="c-faint">—</span>}
    </span>
  ) },
  { id: "size", header: t("common.size"), kind: "num", render: (row) => formatBytes(row.bytes) },
  { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <ActionButton action={row.open} name={t("common.editPath", { path: row.path })} size="sm" /> },
];

/** The world's config files: a list to choose from, and the one file open to edit beside it (ADR-0093). */
export function ConfigTab({ model }: Readonly<{ model: ConfigFilesModel }>) {
  return (
    <>
      <Files model={model} />
      {model.editor && <ConfigFileSheet editor={model.editor} />}
    </>
  );
}

function Files({ model }: Readonly<{ model: ConfigFilesModel }>) {
  const [tokens, setTokens] = useState<readonly FilterToken[]>([]);
  const list = model.list;
  const ready = list.status === "ready" ? list.value : null;
  const shown = ready ? applyFilter(ready.rows, tokens, () => "", (row) => row.path) : [];
  return (
    <Card actions={ready?.release ? <span className="c-faint c-mono">{t("common.releaseActiveRelease", { activeRelease: ready.release })}</span> : undefined} body="flush" count={ready?.rows.length} title={t("config.configFiles")}>
      {list.status === "error"
        ? <LoadError error={list.error} kind={list.kind} retry={list.retry} title={t("config.configFilesCouldNot")} verb={t("config.editConfigFiles")} />
        : (
          <>
            {(list.status === "loading" || (ready && ready.rows.length > 0)) && (
              <FilterBar disabled={list.status === "loading"} label={t("config.searchConfigFiles")} matches={shown.length} onChange={setTokens} placeholder={t("common.searchByFileName")} properties={[]} tokens={tokens} />
            )}
            <Table
              columns={columns}
              empty={ready && ready.rows.length > 0 ? <Empty icon="search" size="sm" title={t("config.noMatchingFiles")} /> : <Empty icon="tune" size="sm" title={t("config.noConfigFiles")} />}
              label={t("config.configFiles")}
              loading={list.status === "loading"}
              rowKey={(row) => row.path}
              rows={shown}
            />
          </>
        )}
    </Card>
  );
}
