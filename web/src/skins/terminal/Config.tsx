import { useFilter } from "../../components/ui/Filter";
import type { ConfigEditorModel, ConfigFileRow, ConfigFilesModel } from "../../core/models";
import { formatBytes } from "../../lib/format";
import { Col, Drawer, Empty, Field, FilterRow, Indicator, LoadError, NoMatches, Notice, Overflow, Panel, Skeleton, SkeletonGroup, Table, TextArea, Verb } from "./ui";

/** What a world's own version of a file is, and who made it. */
function changeLabel(row: Readonly<{ added: boolean; updatedBy: string | null }>): string {
  const what = row.added ? "Added in this world" : "Edited in this world";
  return row.updatedBy ? `${what} by ${row.updatedBy}` : what;
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
    { id: "file", label: "File", truncate: true, render: (row) => <code className="t-clip" title={row.path}>{row.path}</code> },
    { id: "state", label: "State", width: "90px", render: (row) => (
      <span className="t-inline">
        {row.edited && <Indicator glyph={row.added ? "+" : "~"} label={changeLabel(row)} />}
        {row.releaseChanged && <Indicator kind="warning" label="The release changed this file after the edit" />}
      </span>
    ) },
    { id: "size", label: "Size", width: "110px", align: "end", render: (row) => formatBytes(row.bytes) },
    { id: "verbs", label: "Actions", verbs: true, corner: true, render: (row) => <Overflow groups={[[row.open]]} label={`Actions for ${row.path}`} size="small" /> },
  ];
  return (
    <Panel description={ready?.release ? `Release ${ready.release}` : undefined} flush name="Config files">
      {list.status === "error"
        ? <div className="t-inset"><LoadError state={list} title="The config files could not be loaded" verb="edit config files" /></div>
        : <>
          {(list.status === "loading" || (ready && ready.rows.length > 0)) && <FilterRow disabled={list.status === "loading"} filter={filter} label="Search config files" placeholder="Search by file name" />}
          <Table
            columns={columns}
            empty={filter.active ? <NoMatches filter={filter} noun="files" /> : <Empty title="No config files" />}
            label={`Config files of ${model.world.displayName}`}
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
    >
      {editor.reload && <Notice title="Someone changed this file" tone="warning" verbs={<Verb action={editor.reload} size="small" />} />}
      {content.status === "loading" && <SkeletonGroup label="Reading the file"><Skeleton width="long" /><Skeleton width="medium" /><Skeleton width="long" /></SkeletonGroup>}
      {content.status === "error" && <LoadError state={content} title="The file could not be loaded" verb="edit config files" />}
      {content.status === "ready" && (
        <Field hideLabel hint="Changes apply at the world's next start." label={`Contents of ${editor.path}`}>
          <TextArea onChange={(event) => editor.setText(event.target.value)} value={editor.text} />
        </Field>
      )}
    </Drawer>
  );
}
