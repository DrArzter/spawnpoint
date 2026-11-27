import type { FormEvent } from "react";

import type { WhitelistModel } from "../../../core/models";
import { cx } from "../../../lib/cx";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { TextInput } from "../ui/Fields";
import { Grid } from "../ui/Grid";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { useSkeletonRows } from "../ui/rows";
import { ARRIVED, useArrivals } from "../ui/Tick";
import { t } from "../../../i18n";

export function WhitelistTab({ model }: Readonly<{ model: WhitelistModel }>) {
  const list = model.list;
  const ready = list.status === "ready" ? list.value : null;
  const fresh = useArrivals(ready?.rows.map((row) => row.name) ?? []);
  const placeholders = useSkeletonRows(t("common.whitelist"), ready?.rows.length ?? 0, list.status === "loading");
  const changed = ready?.updatedAt ? [t("whitelist.changedValue", { value: shortDateTime(ready.updatedAt) ?? "" }), ready.updatedBy ? t("common.byUpdatedBy", { updatedBy: ready.updatedBy }) : null].filter(Boolean).join(" ") : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!model.add.disabled && !model.add.busy) model.add.run();
  };
  const form = (
    <form className="c-wl-form" onSubmit={submit}>
      <TextInput
        aria-invalid={model.draftError ? true : undefined}
        aria-label={t("whitelist.playerName")}
        autoComplete="off"
        data-tip={model.draftError ?? undefined}
        mono
        onChange={(event) => model.setDraft(event.target.value)}
        placeholder={t("whitelist.playerName")}
        value={model.draft}
      />
      <ActionButton action={model.add} size="sm" />
    </form>
  );
  return (
    <Card actions={form} body="flush" fill count={ready?.rows.length} title={t("common.whitelist")} titleTip={changed}>
      {list.status === "error" && <LoadError error={list.error} kind={list.kind} retry={list.retry} title={t("whitelist.whitelistCouldNotLoaded")} verb={t("whitelist.readWhitelist")} />}
      {list.status === "loading" && (
        <SkeletonGroup>
          <Grid className="c-wl-names" kind="name">
            {Array.from({ length: placeholders }, (_, cell) => (
              <div className="c-wl-name" key={cell}><Skeleton text width="45%" /><Skeleton height="var(--c-ctl-sm)" width="var(--c-ctl-sm)" /></div>
            ))}
          </Grid>
        </SkeletonGroup>
      )}
      {ready?.rows.length === 0 && <Empty icon="verified_user" title={ready.managed ? t("whitelist.nobodyCanJoin") : t("whitelist.noNames")} />}
      {ready && ready.rows.length > 0 && (
        <Grid className="c-wl-names" kind="name" label={t("common.players")}>
          {ready.rows.map((row) => (
            <div className={cx("c-wl-name", fresh.has(row.name) && ARRIVED)} key={row.name}>
              <span className="c-mono" title={row.name}>{row.name}</span>
              <ActionButton action={{ ...row.remove, label: t("whitelist.removeName", { name: row.name }) }} iconOnly size="sm" />
            </div>
          ))}
        </Grid>
      )}
    </Card>
  );
}
