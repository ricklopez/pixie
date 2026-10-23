import { verifyExtraction } from "@gateway/definition";

const input = JSON.parse(await new Promise<string>((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (value += chunk));
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
})) as {
  definition: Parameters<typeof verifyExtraction>[0];
  input: Parameters<typeof verifyExtraction>[1];
  extraction: Parameters<typeof verifyExtraction>[2];
  observedAt: string;
};
process.stdout.write(JSON.stringify(verifyExtraction(input.definition, input.input, input.extraction, input.observedAt)));
