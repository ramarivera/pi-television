import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "./extension.ts";

export type {
  TelevisionConfig,
  TelevisionConfigLoader,
  TelevisionExtensionOptions,
  TelevisionMode,
  TelevisionPickResult,
  TelevisionResolvedConfig,
  TelevisionSearcher,
  TelevisionSearchOptions,
  TelevisionSearchResult,
} from "./extension.ts";
export {
  createDefaultSearcher,
  createExtension,
  createTelevisionAutocompleteProvider,
  extensionInfo,
  loadTelevisionConfig,
  rankTelevisionResults,
  toEditorAttachmentPath,
} from "./extension.ts";

export default function televisionExtension(pi: ExtensionAPI): void {
  createExtension().register(pi);
}
