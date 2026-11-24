import type { ConfigEditorModel } from "../../core/models";
import { ActionButton } from "./ui/ActionButton";
import { LoadError } from "./ui/Empty";
import { TextArea } from "./ui/Fields";
import { Notice } from "./ui/Notice";
import { SidePanel } from "./ui/SidePanel";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";

/** One config file open to edit (ADR-0093): its text, Reset to the release's file, Save, and the one line that says when it applies. */
export function ConfigFileSheet({ editor }: Readonly<{ editor: ConfigEditorModel }>) {
  const { content } = editor;
  return (
    <SidePanel
      actions={<ActionButton action={editor.save} variant="primary" />}
      cancel={editor.close}
      start={editor.reset ? <ActionButton action={editor.reset} variant="ghost" /> : undefined}
      title={editor.path}
    >
      {editor.reload && <Notice notice={{ id: "config.changed", tone: "warning", title: "Someone changed this file", action: editor.reload }} />}
      {content.status === "loading" && <SkeletonGroup><Skeleton height="320px" /></SkeletonGroup>}
      {content.status === "error" && <LoadError error={content.error} kind={content.kind} retry={content.retry} size="sm" title="The file could not be loaded" verb="edit config files" />}
      {content.status === "ready" && (
        <>
          <TextArea aria-label={`Contents of ${editor.path}`} onChange={(event) => editor.setText(event.target.value)} value={editor.text} />
          <p className="c-faint c-config-note">Changes apply at the world's next start.</p>
        </>
      )}
    </SidePanel>
  );
}
