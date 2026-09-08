import { object, type ObjectValue as Item } from "./plain-object.js";
import { ReverseContractError } from "./claude-errors.js";

export const json = (raw: Buffer): Item => {
  try {
    return object(JSON.parse(raw.toString("utf8"))) ?? invalid();
  } catch {
    return invalid();
  }
};
function invalid(): never {
  throw new ReverseContractError("invalid_json_body");
}
const invalidInput = (): never => {
  throw new ReverseContractError("invalid_input_item");
};
export const inputItems = (input: unknown): Item[] =>
  Array.isArray(input)
    ? input.map((value) => object(value) ?? invalidInput())
    : typeof input === "string"
      ? [{ type: "message", role: "user", content: input }]
      : [];
