export type ExtensionInfo = {
  name: string;
  description: string;
};

export const extensionInfo: ExtensionInfo = {
  name: "television",
  description: "Pi extension that replaces the fuzzy file finder with television (tv) for faster, non-blocking file search",
};

export function createExtension() {
  return {
    name: extensionInfo.name,
    async activate() {
      return extensionInfo;
    },
  };
}
