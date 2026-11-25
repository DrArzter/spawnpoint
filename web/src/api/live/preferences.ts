import type { AppearancePreference, SpawnpointApi, SubscriptionState } from "../contract";
import { request } from "./request";
import { t } from "../../i18n";

export const preferencesApi = {
  async loadSubscriptions(): Promise<SubscriptionState> {
    const body = await request<{ subscriptions: SubscriptionState }>("/me/subscriptions", { failure: t("common.notificationSubscriptionsCouldNot") });
    return body.subscriptions;
  },

  async updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
    const body = await request<{ subscriptions: SubscriptionState }>("/me/subscriptions", { method: "PUT", body: { subscriptions }, failure: t("common.notificationSubscriptionsCouldNotSaved") });
    return body.subscriptions;
  },

  async loadAppearance(): Promise<AppearancePreference> {
    const body = await request<{ appearance: AppearancePreference }>("/me/appearance", { failure: t("profile.appearanceSettingsCouldNot") });
    return body.appearance;
  },

  async updateAppearance(appearance: AppearancePreference): Promise<AppearancePreference> {
    const body = await request<{ appearance: AppearancePreference }>("/me/appearance", { method: "PUT", body: { appearance }, failure: t("profile.appearanceSettingsCouldNotSaved") });
    return body.appearance;
  },
} satisfies Partial<SpawnpointApi>;
