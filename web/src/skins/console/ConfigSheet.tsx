import type { ConfigEditorModel } from "../../core/models";
import { ActionButton } from "./ui/ActionButton";
import { LoadError } from "./ui/Empty";
import { TextArea } from "./ui/Fields";
import { Notice } from "./ui/Notice";
import { SidePanel } from "./ui/SidePanel";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";
import { t } from "../../i18n";

/** One config file open to edit (ADR-0093): its text, Reset to the release's file, Save, and the one line that says when it applies. */
export function ConfigFileSheet({ editor }: Readonly<{ editor: ConfigEditorModel }>) {
  const { content } = editor;
  return (
    <SidePanel
      actions={<ActionButton action={editor.save} variant="primary" />}
      cancel={editor.close}
      start={editor.reset ? <ActionButton action={editor.reset} variant="ghost" /> : undefined}
      title={editor.path}
      wide
    >
      {editor.reload && <Notice notice={{ id: "config.changed", tone: "warning", title: t("config.someoneChangedFile"), action: editor.reload }} />}
      {content.status === "loading" && <SkeletonGroup><Skeleton height="320px" /></SkeletonGroup>}
      {content.status === "error" && <LoadError error={content.error} kind={content.kind} retry={content.retry} size="sm" title={t("config.fileCouldNotLoaded")} verb={t("config.editConfigFiles")} />}
      {content.status === "ready" && (
        <>
          <TextArea fill aria-label={t("config.contentsPath", { path: editor.path })} onChange={(event) => editor.setText(event.target.value)} value={editor.text} />
          <p className="c-faint c-config-note">{t("config.changesApplyWorldsNext")}</p>
        </>
      )}
    </SidePanel>
  );
}
