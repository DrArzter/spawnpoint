import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingField, GameSettingsModel, InvitationModel, MarketFieldModel, WorldMarket, WorldPlacement, WorldSettingsModel } from "../../core/models";
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
import { t } from "../../i18n";

// Dialogs and side panels (spec §6.7). The scope dialog lives in Scope.tsx.

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return null;
  const { releaseChoice, typedConfirmation, option } = model;
  return (
    <Dialog actions={<ActionButton action={model.confirm} variant={model.destructive ? "danger" : "primary"} />} cancel={model.cancel} title={model.title}>
      {model.description && <p className="c-line">{model.description}</p>}
      {releaseChoice && (
        <Field label={releaseChoice.label}>
          <Select
            onChange={(event) => releaseChoice.set(event.target.value)}
            options={[
              ...(releaseChoice.value === "" ? [{ value: "", label: t("world.chooseRelease"), disabled: true }] : []),
              ...releaseChoice.options.map((option) => ({ value: option.version, label: option.latest ? t("world.versionLatest", { version: option.version }) : option.version })),
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
      {option && <Checkbox actionId={option.toggle.id} checked={option.checked} label={option.toggle.label} onChange={() => option.toggle.run()} />}
      {model.error && <p className="c-field-error" role="alert">{model.error}</p>}
    </Dialog>
  );
}

const CONNECTION_ICONS = { zerotier: "hub", raw: "public", route53: "language" } as const;

function MarketField({ model }: Readonly<{ model: MarketFieldModel }>) {
  const options: readonly RadioCardOption<WorldMarket>[] = [
    { value: "spot", label: t("host.marketSpot"), icon: "sync" },
    { value: "on-demand", label: t("world.marketOnDemand"), icon: "lock" },
  ];
  return <RadioCards legend={t("world.pricing")} name="market" onChange={model.set} options={options} value={model.value} />;
}

function ConnectionFields({ model, market = null }: Readonly<{ model: ConnectionFieldsModel; market?: MarketFieldModel | null }>) {
  const fleet = model.placement === "fleet";
  const hosting: readonly RadioCardOption<WorldPlacement>[] = [
    { value: "configured", label: t("world.persistent"), icon: "dns" },
    { value: "fleet", label: t("world.fleet"), icon: "bolt", disabled: !model.fleetAvailable, hint: t("world.fleetHostingOffDeployment") },
  ];
  const connection: readonly RadioCardOption<World["connectivity"]>[] = model.connections.map((option) => ({ ...option, icon: CONNECTION_ICONS[option.value] }));
  return <>
    <RadioCards legend={t("world.hosting")} name="hosting" onChange={model.setPlacement} options={hosting} value={model.placement} />
    {market && <MarketField model={market} />}
    <RadioCards legend={t("world.connection")} name="connection" onChange={model.setConnectivity} options={connection} value={model.connectivity} />
    {model.connectivity !== "zerotier" && <Notice detail="tooltip" notice={{ id: "public-port", tone: "warning", title: t("world.gamePortPublic"), description: t("world.setGamesPasswordAllowlist") }} />}
  </>;
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  const ready = model.presets.some((preset) => startableReleases(preset).length > 0);
  const presets: readonly SelectOption[] = model.presets.map((preset) => ({ value: preset.id, label: startableReleases(preset).length > 0 ? preset.displayName : `${preset.displayName} · ${preset.buildStatus}`, disabled: startableReleases(preset).length === 0 }));
  const releases: readonly SelectOption[] = [
    ...(model.release === "" ? [{ value: "", label: t("world.chooseRelease"), disabled: true }] : []),
    ...[...(model.preset ? startableReleases(model.preset) : [])].reverse().map((version) => ({ value: version, label: version === (model.preset && startableLatest(model.preset)) ? t("world.versionLatest", { version }) : version })),
  ];
  const releasesHref = routeHash({ page: "releases", accessTab: "users", gameId: model.game.id, worldId: null });
  return (
    <SidePanel actions={<ActionButton action={model.submit} variant="primary" />} cancel={model.cancel} title={t("common.createWorld")}>
      <Field label={t("common.name")}>
        <TextInput autoComplete="off" maxLength={80} onChange={(event) => model.setName(event.target.value)} value={model.name} />
      </Field>
      {ready
        ? (
          <Field label={t("common.preset")}>
            <Select onChange={(event) => model.setPresetId(event.target.value)} options={presets} value={model.presetId} />
          </Field>
        )
        : (
          <Field end={<a href={releasesHref}>{t("common.releases")}</a>} label={t("common.preset")}>
            <Select disabled options={[{ value: "", label: t("world.noReadyPreset") }]} value="" />
          </Field>
        )}
      {ready && (
        <Field label={t("common.release")}>
          <Select disabled={!model.preset} onChange={(event) => model.setRelease(event.target.value)} options={releases} value={model.release} />
        </Field>
      )}
      <ConnectionFields model={model.connection} />
    </SidePanel>
  );
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return (
    <SidePanel actions={<ActionButton action={model.save} variant="primary" />} cancel={model.cancel} title={t("world.hostingConnection")}>
      <ConnectionFields market={model.market} model={model.connection} />
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
      title={t("world.gameSettings")}
    >
      {model.fields.map((field) => <GameSettingInput field={field} key={field.id} />)}
      {model.running && <p className="c-line">{t("world.savedSettingsApplyFrom")}</p>}
    </SidePanel>
  );
}

type Recipient = InvitationModel["recipients"] extends infer L ? L extends { status: "ready"; value: readonly (infer R)[] } ? R : never : never;
type Sent = InvitationModel["history"] extends infer L ? L extends { status: "ready"; value: readonly (infer R)[] } ? R : never : never;

const recipientTracks: readonly Track<Recipient>[] = [
  { id: "pick", header: t("world.select"), width: "auto", quietHeader: true, kind: "plain", render: (row) => <Checkbox checked={row.selected} disabled={!row.ready} label={row.displayName} labelHidden onChange={() => row.toggle()} /> },
  { id: "player", header: t("common.player"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <Person name={row.displayName} photoUrl={row.photoUrl} /> },
  { id: "reach", header: t("world.reach"), width: "auto", quietHeader: true, kind: "end", render: (row) => (row.ready ? null : <Indicator status={{ kind: "absent", label: t("world.noReachableChannelDelivery", { delivery: row.delivery }) }} />) },
];

const historyTracks: readonly Track<Sent>[] = [
  { id: "status", header: t("common.status"), width: "auto", compactWidth: "auto", kind: "plain", render: (row) => <Status status={row.status} /> },
  { id: "detail", header: t("common.detail"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle line={<Chip>{row.audience}</Chip>} title={row.detail} /> },
  { id: "sent", header: t("world.sent"), width: "auto", kind: "end", render: (row) => <Ago at={row.createdAt} /> },
];

export function InvitationSheet({ model }: Readonly<{ model: InvitationModel }>) {
  const { recipients, history } = model;
  const searching = model.query.trim() !== "";
  return (
    <SidePanel actions={<ActionButton action={model.send} variant="primary" />} cancel={model.close} title={t("world.invitePlayersWorldDisplayName", { worldDisplayName: model.world.displayName })}>
      <Segmented
        label={t("world.audience")}
        onChange={model.setAudience}
        options={[{ value: "broadcast", label: t("world.broadcast") }, { value: "direct", label: t("world.direct") }]}
        value={model.audience}
      />
      {model.audience === "direct" && <>
        <Field
          end={<span className="c-sheet-count"><span className="c-faint">{t("ui.countOfTotal", { count: model.selectedCount, total: model.reachable })}</span><ActionButton action={model.clearSelection} size="sm" variant="ghost" /></span>}
          label={t("common.players")}
        >
          <TextInput autoComplete="off" onChange={(event) => model.setQuery(event.target.value)} type="search" value={model.query} />
        </Field>
        {recipients.status === "error" && <LoadError error={recipients.error} kind={recipients.kind} retry={recipients.retry} size="sm" title={t("world.playersCouldNotLoaded2")} verb={t("world.listPlayers")} />}
        {recipients.status !== "error" && (
          <TrackList
            empty={<Empty icon={searching ? "search" : "group"} size="sm" title={searching ? t("common.noMatches") : t("world.noPlayersInvite")} />}
            header={false}
            label={t("common.players")}
            loading={recipients.status === "loading"}
            rowKey={(row) => row.id}
            rows={recipients.status === "ready" ? recipients.value : []}
            tracks={recipientTracks}
          />
        )}
      </>}
      <Card actions={<ActionButton action={model.refreshHistory} size="sm" />} body="flush" title={t("world.history")}>
        {history.status === "error" && <LoadError error={history.error} kind={history.kind} retry={history.retry} size="sm" title={t("world.historyCouldNotLoaded")} verb={t("common.readInvitations")} />}
        {history.status !== "error" && <TrackList empty={<Empty icon="send" size="sm" title={t("world.noInvitationsYet")} />} label={t("world.history")} loading={history.status === "loading"} rowKey={(row) => row.id} rows={history.status === "ready" ? history.value : []} tracks={historyTracks} />}
      </Card>
    </SidePanel>
  );
}
