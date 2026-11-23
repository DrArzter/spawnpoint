import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingField, GameSettingsModel, InvitationModel, WorldPlacement, WorldSettingsModel } from "../../core/models";
import { startableLatest, startableReleases } from "../../core/presets";
import { connectionLabel } from "../../core/worlds";
import type { World } from "../../model";
import { routeHash } from "../../routing";
import { ActionButton } from "./ui/ActionButton";
import { Ago } from "./ui/Ago";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Dialog } from "./ui/Dialog";
import { Empty, LoadError } from "./ui/Empty";
import { Checkbox, Field, NumberInput, RadioCards, Select, TextInput, Toggle, type RadioCardOption, type SelectOption } from "./ui/Fields";
import { Indicator } from "./ui/Indicator";
import { Notice } from "./ui/Notice";
import { Person } from "./ui/Person";
import { Segmented } from "./ui/Segmented";
import { SidePanel } from "./ui/SidePanel";
import { Status } from "./ui/Status";
import { TrackList, TrackTitle, type Track } from "./ui/TrackList";

// Dialogs and side panels (spec §6.7). The scope dialog lives in Scope.tsx.

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return null;
  const { releaseChoice, typedConfirmation } = model;
  return (
    <Dialog actions={<ActionButton action={model.confirm} variant={model.destructive ? "danger" : "primary"} />} cancel={model.cancel} title={model.title}>
      {model.description && <p className="c-line">{model.description}</p>}
      {releaseChoice && (
        <Field label={releaseChoice.label}>
          <Select
            onChange={(event) => releaseChoice.set(event.target.value)}
            options={[
              ...(releaseChoice.value === "" ? [{ value: "", label: "Choose a release", disabled: true }] : []),
              ...releaseChoice.options.map((option) => ({ value: option.version, label: option.latest ? `${option.version} · latest` : option.version })),
            ]}
            value={releaseChoice.value}
          />
        </Field>
      )}
      {typedConfirmation && (
        <Field label={typedConfirmation.label}>
          <TextInput autoComplete="off" mono onChange={(event) => typedConfirmation.set(event.target.value)} placeholder={typedConfirmation.expected} spellCheck={false} value={typedConfirmation.value} />
        </Field>
      )}
      {model.error && <p className="c-field-error" role="alert">{model.error}</p>}
    </Dialog>
  );
}

const CONNECTION_ICONS = { zerotier: "hub", raw: "public", route53: "language" } as const;

function ConnectionFields({ model }: Readonly<{ model: ConnectionFieldsModel }>) {
  const fleet = model.placement === "fleet";
  const hosting: readonly RadioCardOption<WorldPlacement>[] = [
    { value: "configured", label: "Persistent", icon: "dns" },
    { value: "fleet", label: "Fleet", icon: "bolt", disabled: !model.fleetAvailable, hint: "Fleet hosting is off in this deployment" },
  ];
  const connection: readonly RadioCardOption<World["connectivity"]>[] = model.connections.map((option) => ({ ...option, icon: CONNECTION_ICONS[option.value] }));
  return <>
    <RadioCards legend="Hosting" name="hosting" onChange={model.setPlacement} options={hosting} value={model.placement} />
    <RadioCards legend="Connection" name="connection" onChange={model.setConnectivity} options={connection} value={model.connectivity} />
    {model.connectivity !== "zerotier" && <Notice detail="tooltip" notice={{ id: "public-port", tone: "warning", title: "The game port is public.", description: "Set the game's password or allowlist before you share its address." }} />}
  </>;
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  const ready = model.presets.some((preset) => startableReleases(preset).length > 0);
  const presets: readonly SelectOption[] = model.presets.map((preset) => ({ value: preset.id, label: startableReleases(preset).length > 0 ? preset.displayName : `${preset.displayName} · ${preset.buildStatus}`, disabled: startableReleases(preset).length === 0 }));
  const releases: readonly SelectOption[] = [
    ...(model.release === "" ? [{ value: "", label: "Choose a release", disabled: true }] : []),
    ...[...(model.preset ? startableReleases(model.preset) : [])].reverse().map((version) => ({ value: version, label: version === (model.preset && startableLatest(model.preset)) ? `${version} · latest` : version })),
  ];
  const releasesHref = routeHash({ page: "releases", accessTab: "users", gameId: model.game.id, worldId: null });
  return (
    <SidePanel actions={<ActionButton action={model.submit} variant="primary" />} cancel={model.cancel} title="Create world">
      <Field label="Name">
        <TextInput autoComplete="off" maxLength={80} onChange={(event) => model.setName(event.target.value)} value={model.name} />
      </Field>
      {ready
        ? (
          <Field label="Preset">
            <Select onChange={(event) => model.setPresetId(event.target.value)} options={presets} value={model.presetId} />
          </Field>
        )
        : (
          <Field end={<a href={releasesHref}>Releases</a>} label="Preset">
            <Select disabled options={[{ value: "", label: "No ready preset" }]} value="" />
          </Field>
        )}
      {ready && (
        <Field label="Release">
          <Select disabled={!model.preset} onChange={(event) => model.setRelease(event.target.value)} options={releases} value={model.release} />
        </Field>
      )}
      <ConnectionFields model={model.connection} />
    </SidePanel>
  );
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return (
    <SidePanel actions={<ActionButton action={model.save} variant="primary" />} cancel={model.cancel} title="Hosting & connection">
      <ConnectionFields model={model.connection} />
    </SidePanel>
  );
}

function GameSettingInput({ field }: Readonly<{ field: GameSettingField }>) {
  switch (field.kind) {
    case "choice":
      return (
        <Field hint={field.hint} label={field.label}>
          <Select onChange={(event) => field.set(event.target.value)} options={field.options} value={field.value} />
        </Field>
      );
    case "number":
      return (
        <Field error={field.error} hint={field.hint} label={field.label}>
          <NumberInput max={field.max} min={field.min} onChange={(event) => field.set(event.target.value)} value={field.value} />
        </Field>
      );
    case "text":
      return (
        <Field error={field.error} hint={field.hint} label={field.label}>
          <TextInput maxLength={field.maxLength} onChange={(event) => field.set(event.target.value)} value={field.value} />
        </Field>
      );
    case "toggle":
      return (
        <div className="c-sheet-switch">
          <span className="c-field-label" data-tip={field.hint} tabIndex={field.hint ? 0 : undefined /* NOSONAR focusable tooltip trigger */}>{field.label}</span>
          <Toggle action={field.toggle} checked={field.checked} label={field.label} />
        </div>
      );
  }
}

export function GameSettingsSheet({ model }: Readonly<{ model: GameSettingsModel }>) {
  return (
    <SidePanel
      actions={<ActionButton action={model.save} variant="primary" />}
      cancel={model.cancel}
      start={<ActionButton action={model.restoreDefaults} variant="ghost" />}
      title="Game settings"
    >
      {model.fields.map((field) => <GameSettingInput field={field} key={field.id} />)}
      {model.running && <p className="c-line">Saved settings apply from its next start.</p>}
    </SidePanel>
  );
}

type Recipient = InvitationModel["recipients"] extends infer L ? L extends { status: "ready"; value: readonly (infer R)[] } ? R : never : never;
type Sent = InvitationModel["history"] extends infer L ? L extends { status: "ready"; value: readonly (infer R)[] } ? R : never : never;

const recipientTracks: readonly Track<Recipient>[] = [
  { id: "pick", header: "Select", width: "auto", quietHeader: true, kind: "plain", render: (row) => <Checkbox checked={row.selected} disabled={!row.ready} label={row.displayName} labelHidden onChange={() => row.toggle()} /> },
  { id: "player", header: "Player", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <Person name={row.displayName} photoUrl={row.photoUrl} /> },
  { id: "reach", header: "Reach", width: "auto", quietHeader: true, kind: "end", render: (row) => (row.ready ? null : <Indicator status={{ kind: "absent", label: `No reachable channel · ${row.delivery}` }} />) },
];

const historyTracks: readonly Track<Sent>[] = [
  { id: "status", header: "Status", width: "auto", compactWidth: "auto", kind: "plain", render: (row) => <Status status={row.status} /> },
  { id: "detail", header: "Detail", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle line={<Chip>{row.audience}</Chip>} title={row.detail} /> },
  { id: "sent", header: "Sent", width: "auto", kind: "end", render: (row) => <Ago at={row.createdAt} /> },
];

export function InvitationSheet({ model }: Readonly<{ model: InvitationModel }>) {
  const { recipients, history } = model;
  const searching = model.query.trim() !== "";
  return (
    <SidePanel actions={<ActionButton action={model.send} variant="primary" />} cancel={model.close} title={`Invite players to ${model.world.displayName}`}>
      <Segmented
        label="Audience"
        onChange={model.setAudience}
        options={[{ value: "broadcast", label: "Broadcast" }, { value: "direct", label: "Direct" }]}
        value={model.audience}
      />
      {model.audience === "direct" && <>
        <Field
          end={<span className="c-sheet-count"><span className="c-faint">{model.selectedCount} of {model.reachable}</span><ActionButton action={model.clearSelection} size="sm" variant="ghost" /></span>}
          label="Players"
        >
          <TextInput autoComplete="off" onChange={(event) => model.setQuery(event.target.value)} type="search" value={model.query} />
        </Field>
        {recipients.status === "error" && <LoadError error={recipients.error} kind={recipients.kind} retry={recipients.retry} size="sm" title="Players could not be loaded" verb="list players" />}
        {recipients.status !== "error" && (
          <TrackList
            empty={<Empty icon={searching ? "search" : "group"} size="sm" title={searching ? "No matches" : "No players to invite"} />}
            header={false}
            label="Players"
            loading={recipients.status === "loading"}
            rowKey={(row) => row.id}
            rows={recipients.status === "ready" ? recipients.value : []}
            tracks={recipientTracks}
          />
        )}
      </>}
      <Card actions={<ActionButton action={model.refreshHistory} size="sm" />} body="flush" title="History">
        {history.status === "error" && <LoadError error={history.error} kind={history.kind} retry={history.retry} size="sm" title="History could not be loaded" verb="read invitations" />}
        {history.status !== "error" && <TrackList empty={<Empty icon="send" size="sm" title="No invitations yet" />} label="History" loading={history.status === "loading"} rowKey={(row) => row.id} rows={history.status === "ready" ? history.value : []} tracks={historyTracks} />}
      </Card>
    </SidePanel>
  );
}
