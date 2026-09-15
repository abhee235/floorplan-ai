// The draft review panel (ADR-011 D5): scale status and controls, questions, layer toggles, the selected
// wall's length, thickness and delete, warnings, and commit or cancel. Text is set through textContent only.
import type { DraftReview, ReviewLayer } from "./plan/review.js";

export interface ReviewActions {
  /** Commit the draft; resolves to an error message, or null on success. */
  commit(): Promise<string | null>;
  cancel(): void;
  fit(): void;
}

type Units = "mm" | "cm" | "m" | "in" | "ft";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<"className" | "textContent" | "type" | "value" | "title", string>> = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (node as unknown as Record<string, string>)[k] = v as string;
  for (const c of children) node.append(c);
  return node;
}

export function mountReviewPanel(
  panel: HTMLElement,
  review: DraftReview,
  actions: ReviewActions,
): { update(): void } {
  // pointer and wheel events on the panel must not pan or zoom the plan underneath
  for (const type of ["pointerdown", "pointerup", "wheel", "click"] as const)
    panel.addEventListener(type, (e) => e.stopPropagation());
  let message = "";
  let busy = false;

  const update = () => {
    panel.hidden = !review.active;
    panel.replaceChildren();
    const d = review.draft;
    if (!d) return;
    const status = review.status;

    panel.append(el("h2", { textContent: `Review ${d.source.file ?? "plan"}` }));
    panel.append(
      el("p", {
        className: "counts",
        textContent: `${d.walls.length} walls · ${d.openings.length} openings · ${d.rooms.length} rooms`,
      }),
    );

    // scale
    const scale = el("section", { className: "scale" });
    const f = d.units.mmPerUnit;
    scale.append(
      el("h3", { textContent: "Scale" }),
      el("p", {
        className: status.confirmed ? "ok" : "warn",
        textContent: `${f === null ? "unknown" : `${Number(f.toPrecision(6))} mm per drawing unit`} (${d.units.scaleSource}). ${status.confirmed ? "Confirmed" : "Not confirmed"}: ${status.reason}.`,
      }),
    );
    for (const c of d.units.checks)
      scale.append(
        el("p", {
          className: "check",
          textContent: `“${c.text}” over ${Number(c.measuredUnits.toPrecision(6))} units → ${Number(c.impliedMmPerUnit.toPrecision(6))} mm per unit`,
        }),
      );
    const unitSelect = el("select");
    for (const u of ["mm", "cm", "m", "in", "ft"] as Units[])
      unitSelect.append(el("option", { value: u, textContent: u }));
    // preselect the detected unit, or the unit a guessed scale was read in
    const UNIT_FACTORS: Record<Units, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
    const guessed = (Object.keys(UNIT_FACTORS) as Units[]).find(
      (u) => f !== null && Math.abs(UNIT_FACTORS[u] - f) / UNIT_FACTORS[u] < 0.02,
    );
    if (d.units.detected !== "unknown") unitSelect.value = d.units.detected;
    else if (guessed) unitSelect.value = guessed;
    const useUnits = el("button", { type: "button", textContent: "Use units" });
    useUnits.addEventListener("click", () => review.setScale({ units: unitSelect.value as Units }));
    const confirm = el("button", {
      type: "button",
      textContent: "Confirm scale",
      title: "Keep the scale shown and mark it confirmed",
    });
    confirm.disabled = f === null;
    confirm.addEventListener("click", () => review.setScale("confirm"));
    scale.append(el("div", { className: "row" }, [unitSelect, useUnits, confirm]));
    const known = el("input", { type: "number", title: "Real length of the selected wall in mm" });
    known.placeholder = "known length, mm";
    const setKnown = el("button", { type: "button", textContent: "Set from selected wall" });
    setKnown.disabled = review.selectedWall === null;
    setKnown.addEventListener("click", () => {
      const v = Number(known.value);
      if (v > 0) review.setKnownLength(v);
    });
    scale.append(el("div", { className: "row" }, [known, setKnown]));
    panel.append(scale);

    // selected wall
    if (review.selectedWall !== null) {
      const w = d.walls.find((x) => x.idx === review.selectedWall);
      if (w) {
        const sec = el("section", { className: "wall" });
        const len = review.wallLengthMm(w.idx) ?? 0;
        sec.append(
          el("h3", { textContent: `Wall ${w.idx}` }),
          el("p", { textContent: `${Math.round(len)} mm long at this scale · ${w.kind ?? "kind unknown"}` }),
        );
        const thick = el("input", {
          type: "number",
          value: String(Math.round((w.thickness ?? 0) * (f ?? 1))),
        });
        const setThick = el("button", { type: "button", textContent: "Set thickness" });
        setThick.addEventListener("click", () => review.setThickness(w.idx, Number(thick.value)));
        const del = el("button", { type: "button", textContent: "Delete wall", className: "danger" });
        del.addEventListener("click", () => review.deleteWall(w.idx));
        sec.append(el("div", { className: "row" }, [thick, setThick, del]));
        panel.append(sec);
      }
    }

    // questions
    const open = d.questions;
    if (open.length) {
      const sec = el("section", { className: "questions" });
      sec.append(el("h3", { textContent: "Questions" }));
      for (const q of open) {
        const row = el("div", { className: "question" });
        row.append(el("p", { textContent: q.text }));
        if (q.answer !== null) row.append(el("p", { className: "ok", textContent: `Answered: ${q.answer}` }));
        else {
          const input = el("input", { type: "text" });
          input.placeholder = q.kind === "scale" ? "mm, m, in, ft, or yes" : "answer";
          const btn = el("button", { type: "button", textContent: "Answer" });
          btn.addEventListener("click", () => {
            const bad = review.answer(q.id, input.value);
            message = bad.length
              ? "That answer could not be read as a unit, a number of mm per unit, or yes."
              : "";
            update();
          });
          row.append(el("div", { className: "row" }, [input, btn]));
        }
        sec.append(row);
      }
      panel.append(sec);
    }

    // layers
    const layers = el("section", { className: "layers" });
    for (const layer of ["source", "walls", "openings", "rooms", "lengths"] as ReviewLayer[]) {
      const box = el("input", { type: "checkbox" });
      box.checked = review.visible[layer];
      box.addEventListener("change", () => review.toggle(layer));
      layers.append(el("label", {}, [box, ` ${layer}`]));
    }
    panel.append(layers);

    if (review.warnings.length) {
      const sec = el("section", { className: "warnings" });
      for (const w of review.warnings.slice(0, 6)) sec.append(el("p", { textContent: w }));
      panel.append(sec);
    }

    const commit = el("button", {
      type: "button",
      textContent: busy ? "Importing…" : "Import into the project",
      className: "primary",
    });
    commit.disabled = busy || !status.confirmed;
    commit.title = status.confirmed ? "" : "Confirm the scale first";
    commit.addEventListener("click", async () => {
      busy = true;
      message = "";
      update();
      const error = await actions.commit();
      busy = false;
      message = error ?? "";
      update();
    });
    const fit = el("button", { type: "button", textContent: "Fit draft" });
    fit.addEventListener("click", () => actions.fit());
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    cancel.addEventListener("click", () => actions.cancel());
    panel.append(el("div", { className: "row actions" }, [commit, fit, cancel]));
    if (message) panel.append(el("p", { className: "warn", textContent: message }));
  };

  review.subscribe(update);
  update();
  return { update };
}
