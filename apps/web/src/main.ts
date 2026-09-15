import { startApp } from "./app.js";

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

startApp({
  viewport: byId("viewport"),
  plan: byId("plan"),
  status: byId("status"),
  fit: byId<HTMLButtonElement>("fit"),
  importButton: byId<HTMLButtonElement>("import"),
  importFile: byId<HTMLInputElement>("import-file"),
  review: byId("review"),
});
