import {
  ensureCredentialMeta,
  type ProviderCredentials,
} from "./credentialMeta";

export interface MergeCredentialProvidersOptions {
  replaceProviders?: Iterable<string> | "all";
}

/**
 * Merge disk credentials into the in-memory config without resurrecting
 * providers that were intentionally replaced (e.g. rename/delete flows).
 */
export function mergeCredentialProvidersFromDisk(
  current?: Record<string, ProviderCredentials>,
  disk?: Record<string, ProviderCredentials>,
  options: MergeCredentialProvidersOptions = {},
): Record<string, ProviderCredentials> | undefined {
  if (!disk) return current;

  const target = current ?? {};
  const replaceAll = options.replaceProviders === "all";
  const replaceProviders = replaceAll ? null : new Set(options.replaceProviders ?? []);

  for (const [provider, diskCreds] of Object.entries(disk)) {
    if (replaceAll || replaceProviders!.has(provider)) continue;

    if (!target[provider]) {
      target[provider] = structuredClone(diskCreds);
      ensureCredentialMeta(target[provider]);
      continue;
    }

    const mergedCreds = target[provider];
    for (const [name, value] of Object.entries(diskCreds)) {
      if (name === "__meta") continue;
      if (!Object.prototype.hasOwnProperty.call(mergedCreds, name)) {
        mergedCreds[name] = structuredClone(value);
      }
    }
    ensureCredentialMeta(mergedCreds);
  }

  return target;
}
