import type { Preset } from "../model";
import { t } from "../i18n";

export function releaseBuildCopy(preset: Preset): { label: string; title: string; description: string; hint: string } {
  if (preset.build?.state === "starting") return {
    label: t("releases.resumeBuild"), title: t("releases.resumeReleaseRelease", { release: preset.build.release }),
    description: t("releases.billedBuildWorldsNot"),
    hint: t("releases.resumeSamePendingBuild"),
  };
  if (preset.build?.state === "failed") return {
    label: t("releases.retryBuild"), title: t("releases.retryReleaseRelease", { release: preset.build.release }),
    description: t("releases.billedBuildWorldsNot"),
    hint: t("releases.retryReleaseReleaseFrom", { release: preset.build.release }),
  };
  return {
    label: preset.releases.length > 0 ? t("releases.buildNewRelease") : t("releases.buildRelease"), title: t("releases.buildPresetDisplayName", { presetDisplayName: preset.displayName }),
    description: t("releases.billedBuildWorldsNot"),
    hint: t("releases.buildFromPinnedPreset"),
  };
}

export function releaseBuildExpectation(preset: Preset): { profileDigest: string; retryRelease?: string } {
  if (preset.build && (preset.build.state === "failed" || preset.build.state === "starting")) {
    return { profileDigest: preset.build.profileDigest ?? preset.profileDigest, retryRelease: preset.build.release };
  }
  return { profileDigest: preset.profileDigest };
}
