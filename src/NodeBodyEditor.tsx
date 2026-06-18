import { type JSX, useEffect, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type { BodyClient, Section } from "./types.js";
import { docToTexts, textsToDoc } from "./prosemirror.js";

/** Props for {@link NodeBodyEditor}. */
export interface NodeBodyEditorProps {
  /** The note/node whose body is being edited. */
  nodeId: string;
  /** The body transport (fixture or substrate-direct). */
  client: BodyClient;
  /** Viewing a frozen revision — the editor is read-only, no save. */
  readOnly?: boolean;
  /** Called after a successful coarse save. */
  onSaved?: () => void;
}

/**
 * Calliope's node-body editor. Resolves a node's body via the injected
 * {@link BodyClient}, materializes it into a ProseMirror doc (paragraphs + h2
 * headings), edits in place, and coarse-saves the whole body back through the
 * client.
 *
 * Section identity, ordering, and copy-on-write versioning live in the client /
 * substrate — the editor only ever hands back ordered prose. Chunking
 * granularity (one block = one section, today) is deferred to a merge/split task.
 */
export function NodeBodyEditor(props: NodeBodyEditorProps): JSX.Element {
  const { nodeId, client, readOnly = false, onSaved } = props;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [saved, setSaved] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load (or reload) the node's body whenever the node or client changes.
  useEffect(() => {
    let cancelled = false;
    setSections(null);
    setSaved(true);
    void client.readBody(nodeId).then((b) => {
      if (!cancelled) setSections(b);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, client]);

  // Build the ProseMirror view once the body + mount are ready.
  useEffect(() => {
    if (sections === null || mountRef.current === null) return;
    const state = EditorState.create({
      doc: textsToDoc(sections.map((s) => s.text)),
      plugins: [
        history(),
        keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
        keymap(baseKeymap),
      ],
    });
    const view = new EditorView(mountRef.current, {
      state,
      editable: () => !readOnly,
      dispatchTransaction(tr) {
        const v = viewRef.current;
        if (v === null) return;
        v.updateState(v.state.apply(tr));
        if (tr.docChanged) setSaved(false);
      },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [sections, readOnly]);

  function handleSave(): void {
    const view = viewRef.current;
    if (view === null || readOnly || saving) return;
    const texts = docToTexts(view.state.doc);
    setSaving(true);
    void client
      .saveBody(
        nodeId,
        texts.map((text) => ({ text })),
      )
      .then(() => {
        setSaved(true);
        setSaving(false);
        onSaved?.();
      })
      .catch((err: unknown) => {
        setSaving(false);
        // Surface the failure to the host; the seam owns recovery UX.
        throw err instanceof Error ? err : new Error(String(err));
      });
  }

  return (
    <div className="calliope" data-node-id={nodeId}>
      <div ref={mountRef} className="calliope-editor" />
      {readOnly ? null : (
        <div className="calliope-footer">
          <span className="calliope-hint">
            {sections === null
              ? "loading…"
              : saved
                ? "saved"
                : "paragraphs + ## headings · unsaved"}
          </span>
          <button
            type="button"
            className="calliope-save"
            onClick={handleSave}
            disabled={saved || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
