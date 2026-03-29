// TODO(#9): Consider defining a CredentialEntry interface with key/refresh/type
// fields and using Record<string, CredentialEntry> instead of Record<string, any>
// once all credential shapes are well-understood.
export type ProviderCredentials = Record<string, any> & {
  __meta?: {
    defaultName?: string;
  };
};

export function isReservedCredentialName(name: string): boolean {
  return name === "type" || name === "__meta" || name === "prototype" || name.startsWith("__") || name in Object.prototype;
}

export function isCredentialEntryKey(name: string) {
  return !isReservedCredentialName(name);
}

export function getCredentialNames(creds?: ProviderCredentials | null): string[] {
  if (!creds) return [];
  return Object.keys(creds).filter(isCredentialEntryKey);
}

export function getDefaultCredentialName(creds?: ProviderCredentials | null): string | undefined {
  const names = getCredentialNames(creds);
  if (names.length === 0) return undefined;

  const metaDefault = creds?.__meta?.defaultName;
  if (metaDefault && names.includes(metaDefault)) return metaDefault;
  if (names.includes("primary")) return "primary";
  return names[0];
}

export function ensureCredentialMeta(creds?: ProviderCredentials | null): void {
  if (!creds) return;

  const defaultName = getDefaultCredentialName(creds);
  const meta = creds.__meta && typeof creds.__meta === "object" ? creds.__meta : {};

  if (defaultName) {
    creds.__meta = { ...meta, defaultName };
  } else if (creds.__meta) {
    const nextMeta = { ...meta };
    delete nextMeta.defaultName;
    creds.__meta = nextMeta;
  }
}

export function setDefaultCredentialName(creds: ProviderCredentials, name?: string) {
  const names = getCredentialNames(creds);
  const nextName = name && names.includes(name) ? name : getDefaultCredentialName(creds);
  const meta = creds.__meta && typeof creds.__meta === "object" ? creds.__meta : {};

  if (nextName) {
    creds.__meta = { ...meta, defaultName: nextName };
  } else {
    const nextMeta = { ...meta };
    delete nextMeta.defaultName;
    creds.__meta = nextMeta;
  }
}

export function normalizeCredentialProviders(credentials?: Record<string, ProviderCredentials>) {
  if (!credentials) return;
  for (const creds of Object.values(credentials)) {
    ensureCredentialMeta(creds);
  }
}
