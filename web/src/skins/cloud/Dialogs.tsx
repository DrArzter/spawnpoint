import { actionsOf } from "../../core/actions";
import type { ConfirmationModel, CreateWorldModel, GameSettingsModel, InvitationModel, WorldSettingsModel } from "../../core/models";
import { ActionList } from "./Stub";
import { ActionButton } from "./ui/ActionButton";
import { Dialog } from "./ui/Dialog";
import { SidePanel } from "./ui/SidePanel";

/*
 * S1 stand-ins; S7 builds the confirmation dialog and every side panel here.
 * The confirmation already draws the typed field by the model's label (M2).
 */

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return null;
  return (
    <Dialog actions={<ActionButton action={model.confirm} variant={model.destructive ? "danger" : "primary"} />} cancel={model.cancel} title={model.title}>
      <p className="c-line">{model.description}</p>
      {model.releaseChoice && (
        <label className="c-stub-field">
          <span>Release</span>
          <select onChange={(event) => model.releaseChoice?.set(event.target.value)} value={model.releaseChoice.value}>
            {model.releaseChoice.options.map((option) => <option key={option.version} value={option.version}>{option.version}</option>)}
          </select>
        </label>
      )}
      {model.typedConfirmation && (
        <label className="c-stub-field">
          <span>{model.typedConfirmation.label}</span>
          <input autoComplete="off" className="c-mono" onChange={(event) => model.typedConfirmation?.set(event.target.value)} placeholder={model.typedConfirmation.expected} value={model.typedConfirmation.value} />
        </label>
      )}
    </Dialog>
  );
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  return <SidePanel actions={<ActionButton action={model.submit} variant="primary" />} cancel={model.cancel} title="Create world" />;
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return <SidePanel actions={<ActionButton action={model.save} variant="primary" />} cancel={model.cancel} title="Hosting & connection" />;
}

export function GameSettingsSheet({ model }: Readonly<{ model: GameSettingsModel }>) {
  return (
    <SidePanel actions={<ActionButton action={model.save} variant="primary" />} cancel={model.cancel} title="Game settings">
      {model.running && <p className="c-line">Saved settings apply from its next start.</p>}
      {model.fields.map((field) => (
        <div className="c-stub-field" key={field.id}>
          <span>{field.label}</span>
          {field.kind === "toggle"
            ? <ActionButton action={field.toggle} size="sm" />
            : <input aria-invalid={"error" in field && field.error ? true : undefined} aria-label={field.label} onChange={(event) => field.set(event.target.value)} value={field.value} />}
          {"error" in field && field.error && <span className="c-line">{field.error}</span>}
        </div>
      ))}
      <ActionButton action={model.restoreDefaults} size="sm" />
    </SidePanel>
  );
}

export function InvitationSheet({ model }: Readonly<{ model: InvitationModel }>) {
  return (
    <SidePanel actions={<ActionButton action={model.send} variant="primary" />} cancel={model.close} title={`Invite players to ${model.world.displayName}`}>
      <ActionList actions={actionsOf({ ...model, send: null, close: null })} />
    </SidePanel>
  );
}
