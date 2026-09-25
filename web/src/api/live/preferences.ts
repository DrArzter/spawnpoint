import { apiFailure, type AppearancePreference, type SpawnpointApi, type SubscriptionState } from "../contract";
import { authorizedFetch } from "./transport";

export const preferencesApi = {
  async loadSubscriptions(): Promise<SubscriptionState> {
    const response = await authorizedFetch("/me/subscriptions");
    if (!response.ok) throw await apiFailure(response, "Your notification subscriptions could not be loaded.");
    const body = await response.json() as { subscriptions: SubscriptionState };
    return body.subscriptions;
  },

  async updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
    const response = await authorizedFetch("/me/subscriptions", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptions }),
    });
    if (!response.ok) throw await apiFailure(response, "Your notification subscriptions could not be saved.");
    const body = await response.json() as { subscriptions: SubscriptionState };
    return body.subscriptions;
  },

  async loadAppearance(): Promise<AppearancePreference> {
    const response = await authorizedFetch("/me/appearance");
    if (!response.ok) throw await apiFailure(response, "Your appearance settings could not be loaded.");
    const body = await response.json() as { appearance: AppearancePreference };
    return body.appearance;
  },

  async updateAppearance(appearance: AppearancePreference): Promise<AppearancePreference> {
    const response = await authorizedFetch("/me/appearance", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance }),
    });
    if (!response.ok) throw await apiFailure(response, "Your appearance settings could not be saved.");
    const body = await response.json() as { appearance: AppearancePreference };
    return body.appearance;
  },
} satisfies Partial<SpawnpointApi>;
