import { useFilter } from "../../components/ui/Filter";
import type { ConfigEditorModel, ConfigFileRow, ConfigFilesModel } from "../../core/models";
import { formatBytes } from "../../lib/format";
import { Col, Drawer, Empty, Field, FilterRow, Indicator, LoadError, NoMatches, Notice, Overflow, Panel, Skeleton, SkeletonGroup, Table, TextArea, Verb } from "./ui";
import { t } from "../../i18n";

/** What a world's own version of a file is, and who made it. */
function changeLabel(row: Readonly<{ added: boolean; updatedBy: string | null }>): string {
  const what = row.added ? t("config.addedWorld") : t("config.editedWorld");
  return row.updatedBy ? t("config.whatByUpdatedBy", { what, updatedBy: row.updatedBy }) : what;
}

// A world's config files (ADR-0093): the files to choose from, and the one
// file open to edit in a drawer. The world reads its own version at its next start.
export function ConfigPanel({ model }: Readonly<{ model: ConfigFilesModel }>) {
  return (
    <>
      <Files model={model} />
      {model.editor && <Editor editor={model.editor} />}
    </>
  );
}

function Files({ model }: Readonly<{ model: ConfigFilesModel }>) {
  const list = model.list;
  const ready = list.status === "ready" ? list.value : null;
  const filter = useFilter(ready?.rows ?? [], (row) => [row.path]);
  const columns: readonly Col<ConfigFileRow>[] = [
    { id: "file", label: t("common.file"), truncate: true, render: (row) => <code className="t-clip" title={row.path}>{row.path}</code> },
    { id: "state", label: t("common.state"), width: "90px", render: (row) => (
      <span className="t-inline">
        {row.edited && <Indicator glyph={row.added ? "+" : "~"} label={changeLabel(row)} />}
        {row.releaseChanged && <Indicator kind="warning" label={t("config.releaseChangedFileAfter")} />}
      </span>
    ) },
    { id: "size", label: t("common.size"), width: "110px", align: "end", render: (row) => formatBytes(row.bytes) },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[[row.open]]} label={t("common.actionsMemberName", { memberName: row.path })} size="small" /> },
  ];
  return (
    <Panel description={ready?.release ? t("common.releaseActiveRelease", { activeRelease: ready.release }) : undefined} flush name={t("config.configFiles")}>
      {list.status === "error"
        ? <div className="t-inset"><LoadError state={list} title={t("config.configFilesCouldNotLoaded")} verb={t("config.editConfigFiles")} /></div>
        : <>
          {(list.status === "loading" || (ready && ready.rows.length > 0)) && <FilterRow disabled={list.status === "loading"} filter={filter} label={t("config.searchConfigFiles")} placeholder={t("common.searchByFileName")} />}
          <Table
            columns={columns}
            empty={filter.active ? <NoMatches filter={filter} noun="files" /> : <Empty title={t("config.noConfigFiles")} />}
            label={t("config.configFilesWorldDisplayName", { worldDisplayName: model.world.displayName })}
            loading={list.status === "loading"}
            rowKey={(row) => row.path}
            rows={filter.rows}
          />
        </>}
    </Panel>
  );
}

function Editor({ editor }: Readonly<{ editor: ConfigEditorModel }>) {
  const { content } = editor;
  return (
    <Drawer
      cancel={editor.close}
      cancelLabel={editor.close.label}
      closeActionId={editor.close.id}
      footer={<>
        {editor.reset && <Verb action={editor.reset} />}
        <Verb action={editor.save} tone="primary" tooltipWhenDisabled />
      </>}
      onClose={editor.close.run}
      open
      title={editor.path}
      wide
    >
      {editor.reload && <Notice title={t("config.someoneChangedFile")} tone="warning" verbs={<Verb action={editor.reload} size="small" />} />}
      {content.status === "loading" && <SkeletonGroup label={t("config.readingFile")}><Skeleton width="long" /><Skeleton width="medium" /><Skeleton width="long" /></SkeletonGroup>}
      {content.status === "error" && <LoadError state={content} title={t("config.fileCouldNotLoaded")} verb={t("config.editConfigFiles")} />}
      {content.status === "ready" && (
        <Field fill hideLabel hint={t("config.changesApplyWorldsNext")} label={t("config.contentsPath", { path: editor.path })}>
          <TextArea fill onChange={(event) => editor.setText(event.target.value)} value={editor.text} />
        </Field>
      )}
    </Drawer>
  );
}
