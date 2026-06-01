import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "./extension.ts";

export type {
  TelevisionExtensionOptions,
  TelevisionPickResult,
  TelevisionRunner,
  TelevisionRunnerOptions,
} from "./extension.ts";
export {
  createExtension,
  extensionInfo,
  toEditorAttachmentPath,
} from "./extension.ts";

export default function televisionExtension(pi: ExtensionAPI): void {
  createExtension().register(pi);
}
