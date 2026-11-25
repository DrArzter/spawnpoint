import { useEffect, useState } from "react";

import { Timestamp } from "../../components/ui/Timestamp";
import type { World } from "../../model";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingField, GameSettingsModel, InvitationModel, ScopeModel, WorldSettingsModel } from "../../core/models";
import { startableLatest, startableReleases } from "../../core/presets";
import { Drawer, Empty, Field, LoadError, Modal, NoMatches, Person, SelectInput, SkeletonRows, State, TextInput, Toggle, Verb } from "./ui";
import { t } from "../../i18n";

// The scope picker: choosing a game re-scopes the whole console.
export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (model.open) setQuery(""); }, [model.open]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = model.games.filter((game) => needle === "" || game.displayName.toLocaleLowerCase().includes(needle) || game.code.toLocaleLowerCase().includes(needle) || game.id.includes(needle));
  return (
    <Modal className="t-scope-modal" onClose={model.close.run} open={model.open} title={t("common.selectGame")} verbs={<Verb action={model.close} />}>
      <Field hideLabel label={t("world.searchGames")}>
        <TextInput autoComplete="off" data-autofocus onChange={(event) => setQuery(event.target.value)} placeholder={t("world.searchGames")} type="search" value={query} />
      </Field>
      <div aria-label={t("common.games")} className="t-scope-list" role="listbox">
        {visible.map((game) => {
          const status = model.statusOf(game);
          return (
            <button aria-selected={game.id === model.game?.id} className="t-scope-row" data-action="scope.select" key={game.id} onClick={() => model.select(game.id)} role="option" type="button">
              <span aria-hidden="true" className="t-scope-code">{game.code}</span>
              <span className="t-stack">
                <strong>{game.displayName}</strong>
                <small>{t("world.worldCount", { count: game.worlds.length })} · {t("world.presetCount", { count: game.presets.length })}</small>
              </span>
              <State kind={status.kind} label={status.label} />
            </button>
          );
        })}
      </div>
      {visible.length === 0 && <NoMatches filter={{ query, clear: () => setQuery("") }} noun="games" />}
    </Modal>
  );
}

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return <Modal onClose={() => undefined} open={false} title="" />;
  return (
    <Modal
      dismissOnBackdrop={false}
      onClose={model.cancel.run}
      open
      title={model.title}
      verbs={<>
        <Verb action={model.confirm} tone={model.destructive ? "danger" : "primary"} />
        <Verb action={model.cancel} data-autofocus={model.typedConfirmation ? undefined : true} />
      </>}
    >
      <p className="t-copy-line">{model.description}</p>
      {model.releaseChoice && (
        <Field label={model.releaseChoice.label}>
          <SelectInput onChange={(event) => model.releaseChoice?.set(event.target.value)} value={model.releaseChoice.value}>
            <option disabled value="">{t("world.chooseRelease")}</option>
            {model.releaseChoice.options.map((option) => <option key={option.version} value={option.version}>{option.version}{option.latest ? t("world.latest") : ""}</option>)}
          </SelectInput>
        </Field>
      )}
      {model.typedConfirmation && (
        <Field label={model.typedConfirmation.label}>
          <TextInput autoComplete="off" data-autofocus mono onChange={(event) => model.typedConfirmation?.set(event.target.value)} placeholder={model.typedConfirmation.expected} value={model.typedConfirmation.value} />
        </Field>
      )}
      {model.option && <Toggle action={model.option.toggle} checked={model.option.checked} />}
      {model.error && <p className="t-error" role="alert">{model.error}</p>}
    </Modal>
  );
}

function ConnectionFields({ model, first = false }: Readonly<{ model: ConnectionFieldsModel; first?: boolean }>) {
  return <>
    <Field label={t("world.hosting")}>
      <SelectInput data-autofocus={first ? true : undefined} onChange={(event) => model.setPlacement(event.target.value as "configured" | "fleet")} value={model.placement}>
        <option value="configured">{t("world.persistentHost")}</option>
        <option disabled={!model.fleetAvailable} value="fleet">{t("world.onDemandFleet")}{model.fleetAvailable ? "" : t("world.notConfigured")}</option>
      </SelectInput>
    </Field>
    <Field hint={model.connections.find((option) => option.disabled)?.hint} label={t("world.connection")}>
      <SelectInput onChange={(event) => model.setConnectivity(event.target.value as World["connectivity"])} value={model.connectivity}>
        {model.connections.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </SelectInput>
    </Field>
    {model.connectivity !== "zerotier" && <p className="t-copy-line">{t("world.gamePortPublicSet")}</p>}
  </>;
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  const readyPresets = model.presets.filter((preset) => startableReleases(preset).length > 0);
  return (
    <Drawer
      cancel={model.cancel}
      closeActionId={model.cancel.id}
      footer={<>
        <p>{model.preset ? `${model.preset.displayName} · ${t("world.releaseCount", { count: startableReleases(model.preset).length })}` : t("world.choosePreset")}</p>
        <Verb action={model.submit} tone="primary" />
      </>}
      onClose={model.cancel.run}
      open
      title={t("common.createWorld")}
    >
      <form className="t-form" onSubmit={(event) => { event.preventDefault(); model.submit.run(); }}>
        <Field hint={readyPresets.length === 0 ? t("world.noPresetGameHas") : undefined} label={t("common.preset")}>
          <SelectInput onChange={(event) => model.setPresetId(event.target.value)} value={model.presetId}>
            {model.presets.map((item) => <option disabled={startableReleases(item).length === 0} key={item.id} value={item.id}>{item.displayName}{startableReleases(item).length === 0 ? ` (${item.buildStatus})` : ""}</option>)}
          </SelectInput>
        </Field>
        <Field hint={t("world.n180CharactersShown")} label={t("common.name")}>
          <TextInput autoComplete="off" data-autofocus maxLength={80} onChange={(event) => model.setName(event.target.value)} placeholder={t("world.exampleRailWorld")} value={model.name} />
        </Field>
        <Field label={t("common.release")}>
          <SelectInput disabled={!model.preset} onChange={(event) => model.setRelease(event.target.value)} value={model.release}>
            <option disabled value="">{t("world.chooseRelease")}</option>
            {model.preset && [...startableReleases(model.preset)].reverse().map((version) => <option key={version} value={version}>{version}{version === startableLatest(model.preset!) ? t("world.latest") : ""}</option>)}
          </SelectInput>
        </Field>
        <ConnectionFields model={model.connection} />
      </form>
    </Drawer>
  );
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return (
    <Drawer
      cancel={model.cancel}
      closeActionId={model.cancel.id}
      footer={<Verb action={model.save} tone="primary" />}
      onClose={model.cancel.run}
      open
      title={t("world.hostingGameDisplayName", { gameDisplayName: model.game.displayName })}
    >
      <div className="t-form">
        {!model.stopped && <p className="t-copy-line">{t("world.stopWorldsSessionBefore")}</p>}
        <ConnectionFields first model={model.connection} />
      </div>
    </Drawer>
  );
}

// A world's game settings (ADR-0064): each drawn by its kind, saved together.
export function GameSettingsSheet({ model }: Readonly<{ model: GameSettingsModel }>) {
  return (
    <Drawer
      cancel={model.cancel}
      closeActionId={model.cancel.id}
      description={`${model.game.displayName} · ${model.world.displayName}`}
      footer={<><Verb action={model.restoreDefaults} /><Verb action={model.save} tone="primary" tooltipWhenDisabled /></>}
      onClose={model.cancel.run}
      open
      title={t("world.gameSettings")}
    >
      <form className="t-form" onSubmit={(event) => { event.preventDefault(); model.save.run(); }}>
        {model.running && <p className="t-copy-line">{t("world.worldIsRunning", { world: model.world.displayName })} {t("world.savedSettingsApplyFrom")}</p>}
        {model.fields.map((field) => <GameSettingInput field={field} key={field.id} />)}
      </form>
    </Drawer>
  );
}

function GameSettingInput({ field }: Readonly<{ field: GameSettingField }>) {
  switch (field.kind) {
    case "choice":
      return <Field hint={field.hint} label={field.label}>
        <SelectInput onChange={(event) => field.set(event.target.value)} value={field.value}>
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectInput>
      </Field>;
    case "number":
      return <Field error={field.error} hint={field.hint} label={field.label}>
        <TextInput aria-invalid={field.error ? true : undefined} inputMode="numeric" max={field.max} min={field.min} mono onChange={(event) => field.set(event.target.value)} type="number" value={field.value} />
      </Field>;
    case "text":
      return <Field error={field.error} hint={field.hint} label={field.label}>
        <TextInput aria-invalid={field.error ? true : undefined} maxLength={field.maxLength} onChange={(event) => field.set(event.target.value)} value={field.value} />
      </Field>;
    case "toggle":
      return <Toggle action={field.toggle} checked={field.checked} {...(field.hint ? { note: field.hint } : {})} />;
  }
}

export function InvitationSheet({ model }: Readonly<{ model: InvitationModel }>) {
  const { game, world } = model;
  const recipients = model.recipients;
  const history = model.history;
  const address = world.connectionAddress ? ` · ${world.connectionAddress}` : "";
  const matches = recipients.status === "ready" ? recipients.value.length : 0;
  const summary = model.query.trim() ? t("world.matchesMatches", { matches }) : t("world.reachableReachable", { reachable: model.reachable });
  return (
    <Drawer
      cancel={model.close}
      closeActionId={model.close.id}
      description={`${game.displayName} · ${world.displayName}${address}`}
      footer={<Verb action={model.send} tone="primary" />}
      onClose={model.close.run}
      open
      title={t("common.invitePlayers")}
    >
      <div className="t-form">
        <fieldset className="t-radios">
          <legend className="t-setting-label">{t("world.audience")}</legend>
          <label className="t-radio">
            <input checked={model.audience === "broadcast"} data-autofocus name="invite-audience" onChange={() => model.setAudience("broadcast")} type="radio" />
            <span aria-hidden="true" className="t-radio-box">{model.audience === "broadcast" ? "(o)" : "( )"}</span>
            <strong>{t("common.everyone")}</strong>
          </label>
          <label className="t-radio">
            <input checked={model.audience === "direct"} name="invite-audience" onChange={() => model.setAudience("direct")} type="radio" />
            <span aria-hidden="true" className="t-radio-box">{model.audience === "direct" ? "(o)" : "( )"}</span>
            <strong>{t("world.specificPeople")}</strong>
          </label>
        </fieldset>

        {model.audience === "direct" && (
          <section aria-label={t("common.players")} className="t-form">
            <Field hideLabel label={t("world.findPlayer")}>
              <TextInput autoComplete="off" onChange={(event) => model.setQuery(event.target.value)} placeholder={t("world.searchByDisplayName")} type="search" value={model.query} />
            </Field>
            <p className="t-copy-line t-inline">
              <span>{summary}</span>
              {model.selectedCount > 0 && <Verb action={model.clearSelection} size="small" />}
            </p>
            {recipients.status === "loading" && <SkeletonRows label={t("world.loadingApprovedPlayers")} rows={3} />}
            {recipients.status === "error" && <LoadError state={recipients} title={t("world.playersCouldNotLoaded2")} verb={t("world.listPlayers")} />}
            {recipients.status === "ready" && recipients.value.length === 0 && !model.query.trim() && <Empty description={t("world.approveAnotherPlayerAccess")} title={t("world.noOtherApprovedPlayers")} />}
            {recipients.status === "ready" && recipients.value.length === 0 && model.query.trim() && <NoMatches filter={{ query: model.query, clear: () => model.setQuery("") }} noun="players" />}
            {recipients.status === "ready" && recipients.value.length > 0 && (
              <ul className="t-list">
                {recipients.value.map((recipient) => (
                  <li className="t-list-row" key={recipient.id}>
                    <label className={recipient.ready ? "t-check" : "t-check t-check-off"}>
                      <input checked={recipient.selected} disabled={!recipient.ready} onChange={recipient.toggle} type="checkbox" />
                      <span aria-hidden="true" className="t-check-box">{recipient.selected ? "[x]" : "[ ]"}</span>
                      <Person detail={recipient.delivery} name={recipient.displayName} photoUrl={recipient.photoUrl} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="t-invite-history" className="t-details-group">
          <div className="t-group-head">
            <h3 className="t-group-name" id="t-invite-history">{t("common.recentInvitations")}</h3>
            <Verb action={model.refreshHistory} size="small" />
          </div>
          {history.status === "loading" && <SkeletonRows columns={3} label={t("world.loadingRecentInvitationResults")} rows={2} />}
          {history.status === "error" && <LoadError state={history} title={t("world.deliveryHistoryCouldNot")} verb={t("common.readInvitations")} />}
          {history.status === "ready" && history.value.length === 0 && <Empty title={t("world.noInvitationsYet")} />}
          {history.status === "ready" && history.value.length > 0 && (
            <ul className="t-list">
              {history.value.map((item) => (
                <li className="t-list-row t-history-row" key={item.id}>
                  <State kind={item.status.kind} label={item.status.label} />
                  <span className="t-tag">{item.audience}</span>
                  <span className="t-copy-line">{item.detail}</span>
                  <Timestamp className="t-secondary" value={item.createdAt} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
