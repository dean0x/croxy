/** Native clients supported by this build; providers and model names are a separate registry. */
export const CLIENT_IDS = ["claude-code", "codex"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export type ClientSelection = ClientId | "all";

export const parseClientSelection = (value: string): ClientSelection | undefined => {
  if (value === "all" || value === "both") return "all";
  return CLIENT_IDS.find(client => client === value);
};

export const selectedClients = (selection: ClientSelection): readonly ClientId[] =>
  selection === "all" ? CLIENT_IDS : [selection];
