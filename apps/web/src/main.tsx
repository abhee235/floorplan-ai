// Mounts the React chrome (ADR-018 D1). Everything the editor does is inside EditorShell, which starts the
// imperative app once its refs exist; this file only finds the root and renders.
//
// Deliberately no StrictMode: it mounts, unmounts and remounts every effect in development, which would
// run startApp twice — two bridge sockets, two WebGL renderers appended to the viewport, two frame loops.
// The double-invoke is there to expose impure effects, and this one is genuinely once-only by nature.
import { createRoot } from "react-dom/client";
import { EditorShell } from "./editor/EditorShell.js";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

createRoot(root).render(<EditorShell />);
