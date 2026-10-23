import { locate, checkpoint, extractOutputs } from "@gateway/adapter/runtime";
export async function run(page, input) {
  return await extractOutputs(page, [], {});
}