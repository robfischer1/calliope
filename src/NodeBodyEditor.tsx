import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type {
  BlockOpEmitter,
  BodyClient,
  Section,
  SectionInput,
} from "./types.js";
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
  /**
   * Optional block-op emitter. When provided, every editor save transaction
   * routes through a thin decorator that forwards block-ops to this emitter
   * in addition to any emitter already wired inside the `client` itself.
   * This is the editor-boundary hook: "the editor is the DB in the same shape."
   *
   * For {@link UraniaBodyClient}, inject the emitter at construction instead (or
   * in addition). This prop is the surface for render hosts that use a
   * {@link FixtureBodyClient} or a custom client and still want the block-op log.
   */
  blockOpEmitter?: BlockOpEmitter;
}

/**
 * A thin {@link BodyClient} decorator that forwards all calls to `inner` and,
 * on `saveBody` / `editSection`, additionally invokes a {@link BlockOpEmitter}
 * that records each semantic block-op. This is a pure pass-through for the
 * substrate writes; the block-op side-channel is the only addition.
 *
 * Used by {@link NodeBodyEditor} when a `blockOpEmitter` prop is supplied, so the
 * editor transaction boundary is the emission trigger rather than the client
 * construction site.
 */
class BlockOpDecoratedClient implements BodyClient {
  constructor(
    private readonly inner: BodyClient,
    private readonly emitter: BlockOpEmitter,
  ) {}

  readBody(nodeId: string): Promise<Section[]> {
    return this.inner.readBody(nodeId);
  }

  async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    // Read current body BEFORE the save so we can derive semantic ops.
    const before = await this.inner.readBody(nodeId);
    await this.inner.saveBody(nodeId, sections);
    // After the substrate write, derive and emit block-ops.
    const after = await this.inner.readBody(nodeId);
    const ts = new Date().toISOString();
    const beforeMap = new Map(before.map((s) => [s.id, s]));
    const afterIds = new Set(after.map((s) => s.id));

    for (const sec of after) {
      if (!beforeMap.has(sec.id)) {
        // New id after save: either add (brand-new) or update (prose changed).
        const hadAny = before.length > 0;
        await this.emitter.emit({
          block_id: sec.id,
          op_type: hadAny ? "update" : "add",
          content_delta: sec.text,
          order_key: sec.orderKey,
          timestamp: ts,
          authored_by: "human",
          node_id: nodeId,
        });
      } else {
        const prev = beforeMap.get(sec.id);
        if (prev !== undefined && prev.orderKey !== sec.orderKey) {
          // Same id, different order_key: reorder.
          await this.emitter.emit({
            block_id: sec.id,
            op_type: "reorder",
            content_delta: "",
            order_key: sec.orderKey,
            timestamp: ts,
            authored_by: "human",
            node_id: nodeId,
          });
        }
      }
    }

    for (const old of before) {
      if (!afterIds.has(old.id)) {
        await this.emitter.emit({
          block_id: old.id,
          op_type: "delete",
          content_delta: "",
          order_key: old.orderKey,
          timestamp: ts,
          authored_by: "human",
          node_id: nodeId,
        });
      }
    }
  }

  editSection(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section> {
    if (this.inner.editSection === undefined) {
      return Promise.reject(
        new Error("editSection not supported by inner client"),
      );
    }
    const emit = this.emitter;
    return this.inner.editSection(nodeId, sectionId, text).then(async (sec) => {
      await emit.emit({
        block_id: sec.id,
        op_type: "update",
        content_delta: sec.text,
        order_key: sec.orderKey,
        timestamp: new Date().toISOString(),
        authored_by: "human",
        node_id: nodeId,
      });
      return sec;
    });
  }
}

/**
 * Calliope's node-body editor. Resolves a node's body via the injected
 * {@link BodyClient}, materializes it into a ProseMirror doc (the body's
 * markdown, rendered formatted), edits in place, and coarse-saves the whole
 * body back through the client.
 *
 * Section identity, ordering, and copy-on-write versioning live in the client /
 * substrate — the editor only ever hands back ordered prose. Chunking
 * granularity (one block = one section, today) is deferred to a merge/split task.
 */
export function NodeBodyEditor(props: NodeBodyEditorProps): JSX.Element {
  const { nodeId, client, readOnly = false, onSaved, blockOpEmitter } = props;

  // When a blockOpEmitter is provided, wrap the client so every save triggers
  // block-op emission at the editor transaction boundary.
  const effectiveClient = useMemo<BodyClient>(
    () =>
      blockOpEmitter !== undefined
        ? new BlockOpDecoratedClient(client, blockOpEmitter)
        : client,
    [client, blockOpEmitter],
  );

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
    void effectiveClient.readBody(nodeId).then((b) => {
      if (!cancelled) setSections(b);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, effectiveClient]);

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
    void effectiveClient
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
                : "markdown · unsaved"}
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
