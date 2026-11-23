import type { AppearancePreference, SpawnpointApi, SubscriptionState } from "../contract";
import { request } from "./request";

export const preferencesApi = {
  async loadSubscriptions(): Promise<SubscriptionState> {
    const body = await request<{ subscriptions: SubscriptionState }>("/me/subscriptions", { failure: "Your notification subscriptions could not be loaded." });
    return body.subscriptions;
  },

  async updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
    const body = await request<{ subscriptions: SubscriptionState }>("/me/subscriptions", { method: "PUT", body: { subscriptions }, failure: "Your notification subscriptions could not be saved." });
    return body.subscriptions;
  },

  async loadAppearance(): Promise<AppearancePreference> {
    const body = await request<{ appearance: AppearancePreference }>("/me/appearance", { failure: "Your appearance settings could not be loaded." });
    return body.appearance;
  },

  async updateAppearance(appearance: AppearancePreference): Promise<AppearancePreference> {
    const body = await request<{ appearance: AppearancePreference }>("/me/appearance", { method: "PUT", body: { appearance }, failure: "Your appearance settings could not be saved." });
    return body.appearance;
  },
} satisfies Partial<SpawnpointApi>;
