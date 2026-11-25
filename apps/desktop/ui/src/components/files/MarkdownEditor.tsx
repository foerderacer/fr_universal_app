import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlertTriangle,
  Bold,
  Check,
  Code,
  FileCode2,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  RotateCcw,
  Save,
  Table as TableIcon,
} from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TurndownService from "turndown";
import type {
  Etag,
  MarkdownDocument_Serialize,
  UserFacingError,
} from "../../bindings/tauri";
import {
  discardMarkdownDraft,
  getMediaProxyUrl,
  joinCloudPath,
  readMarkdownFile,
  saveMarkdownCopy,
  saveMarkdownDraft,
  saveMarkdownFile,
  uploadFileBytes,
} from "../../lib/filesClient";
import { toUserFacingError } from "../../lib/workspaceClient";
import { ErrorBanner } from "../ErrorBanner";

interface MarkdownEditorProps {
  path: string;
  onSaved?: (newPath: string) => void;
}

function createTurndown(docParentDir: string): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.addRule("taskListItem", {
    filter: (node) =>
      node.nodeName === "LI" && node.getAttribute("data-type") === "taskItem",
    replacement: (content, node) => {
      const checked =
        (node as HTMLElement).getAttribute("data-checked") === "true";
      return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
    },
  });
  // Never persist ephemeral loopback media-proxy URLs (which contain session tokens) into .md files.
  td.addRule("stripProxyImageUrl", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const alt = el.getAttribute("alt") || "";
      let src = el.getAttribute("src") || "";
      if (src.startsWith("http://127.0.0.1:")) {
        try {
          const parsed = new URL(src);
          const cloudPath = parsed.searchParams.get("path");
          if (cloudPath) {
            const prefix = docParentDir === "/" ? "/" : `${docParentDir}/`;
            src = cloudPath.startsWith(prefix)
              ? `./${cloudPath.slice(prefix.length)}`
              : cloudPath;
          }
        } catch {
          // Keep original src if URL parsing fails.
        }
      }
      return src ? `![${alt}](${src})` : "";
    },
  });
  return td;
}

export function MarkdownEditor({ path, onSaved }: MarkdownEditorProps) {
  const [doc, setDoc] = useState<MarkdownDocument_Serialize | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [etag, setEtag] = useState<Etag | null>(null);
  const [mode, setMode] = useState<"rich" | "raw">("rich");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);

  const docParentDir = useMemo(() => {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
  }, [path]);
  const turndown = useMemo(() => createTurndown(docParentDir), [docParentDir]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncingFromExternal = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start writing your team note..." }),
    ],
    content: "",
    onUpdate: ({ editor: ed }) => {
      if (syncingFromExternal.current) return;
      const md = turndown.turndown(ed.getHTML());
      setMarkdown(md);
      setDirty(true);
    },
  });

  const applyMarkdownToEditor = useCallback(
    (mdText: string) => {
      if (!editor) return;
      syncingFromExternal.current = true;
      try {
        const html = marked.parse(mdText, { async: false }) as string;
        editor.commands.setContent(html, { emitUpdate: false });
      } finally {
        syncingFromExternal.current = false;
      }
    },
    [editor],
  );

  const loadDocument = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConflictOpen(false);
    try {
      const loaded = await readMarkdownFile(path);
      setDoc(loaded);
      setMarkdown(loaded.content);
      setEtag(loaded.etag);
      setDirty(false);
      applyMarkdownToEditor(loaded.content);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoading(false);
    }
  }, [path, applyMarkdownToEditor]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  // Debounced auto-save of unsaved drafts into local SQLite.
  useEffect(() => {
    if (!dirty || !doc) return;
    const handle = window.setTimeout(() => {
      void saveMarkdownDraft(path, markdown, etag)
        .then(() => setDraftNotice("Draft saved locally"))
        .catch(() => {});
    }, 800);
    return () => window.clearTimeout(handle);
  }, [dirty, doc, path, markdown, etag]);

  const handleSave = useCallback(
    async (forceOverwrite = false) => {
      setSaving(true);
      setError(null);
      setSavedNotice(null);
      try {
        const res = await saveMarkdownFile(path, markdown, etag, forceOverwrite);
        setEtag(res.etag);
        setDirty(false);
        setDraftNotice(null);
        setConflictOpen(false);
        setSavedNotice("Saved to Nextcloud");
        setTimeout(() => setSavedNotice(null), 2500);
        onSaved?.(res.path);
      } catch (err) {
        const uf = toUserFacingError(err);
        if (uf.code === "conflict") {
          setConflictOpen(true);
        } else {
          setError(uf);
        }
      } finally {
        setSaving(false);
      }
    },
    [path, markdown, etag, onSaved],
  );

  // Ctrl/Cmd+S shortcut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saving && !loading) {
          void handleSave(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave, saving, loading]);

  async function handleSaveCopy() {
    setSaving(true);
    setError(null);
    try {
      const res = await saveMarkdownCopy(path, markdown);
      setConflictOpen(false);
      setDirty(false);
      setDraftNotice(null);
      setSavedNotice(`Saved copy: ${res.path.split("/").pop()}`);
      onSaved?.(res.path);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRestoreDraft() {
    if (!doc?.draft) return;
    setMarkdown(doc.draft.content);
    applyMarkdownToEditor(doc.draft.content);
    setDirty(true);
    setDoc({ ...doc, draft: null });
  }

  async function handleDiscardDraft() {
    await discardMarkdownDraft(path);
    if (doc) {
      setDoc({ ...doc, draft: null });
    }
    setDraftNotice(null);
  }

  async function handleInsertImage(file: File) {
    try {
      const parent = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/")) || "/"
        : "/";
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const assetPath = joinCloudPath(
        joinCloudPath(parent, "assets"),
        `${Date.now()}-${safeName}`,
      );
      const buf = new Uint8Array(await file.arrayBuffer());
      await uploadFileBytes(assetPath, buf);
      const proxyUrl = await getMediaProxyUrl(assetPath);
      const relLink = `./assets/${assetPath.split("/").pop()}`;
      if (mode === "rich" && editor) {
        editor
          .chain()
          .focus()
          .setImage({ src: proxyUrl ?? relLink, alt: file.name })
          .run();
      } else {
        setMarkdown((prev) => `${prev}\n\n![${file.name}](${relLink})\n`);
        setDirty(true);
      }
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  function handleModeSwitch(nextMode: "rich" | "raw") {
    if (nextMode === mode) return;
    if (nextMode === "rich") {
      applyMarkdownToEditor(markdown);
    }
    setMode(nextMode);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500">
        Loading Markdown note...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {doc?.draft && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span>
            You have an unsaved local draft of this document from an earlier session.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRestoreDraft()}
              className="rounded-lg bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700"
            >
              Restore draft
            </button>
            <button
              type="button"
              onClick={() => void handleDiscardDraft()}
              className="rounded-lg border border-amber-300 px-3 py-1 font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {conflictOpen && (
        <div
          role="alertdialog"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900/60 dark:bg-rose-950/40"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-rose-900 dark:text-rose-100">
                Someone else updated this file on Nextcloud
              </p>
              <p className="mt-1 text-xs text-rose-800 dark:text-rose-200">
                Your edits are safely preserved. Choose how you want to continue:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveCopy()}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Save as a copy (Recommended)
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave(true)}
                  className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300"
                >
                  Overwrite server version
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void loadDocument()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Discard &amp; reload latest
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-1">
          {mode === "rich" && editor && (
            <>
              <ToolbarBtn
                active={editor.isActive("heading", { level: 1 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                label="Heading 1"
              >
                <Heading1 className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("heading", { level: 2 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                label="Heading 2"
              >
                <Heading2 className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("bold")}
                onClick={() => editor.chain().focus().toggleBold().run()}
                label="Bold"
              >
                <Bold className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("italic")}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                label="Italic"
              >
                <Italic className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("bulletList")}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                label="Bullet list"
              >
                <List className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("orderedList")}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                label="Numbered list"
              >
                <ListOrdered className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("taskList")}
                onClick={() => editor.chain().focus().toggleTaskList().run()}
                label="Checklist"
              >
                <ListChecks className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("blockquote")}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                label="Quote"
              >
                <Quote className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("codeBlock")}
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                label="Code block"
              >
                <Code className="h-4 w-4" />
              </ToolbarBtn>
              <ToolbarBtn
                active={editor.isActive("table")}
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run()
                }
                label="Insert table"
              >
                <TableIcon className="h-4 w-4" />
              </ToolbarBtn>
            </>
          )}
          <ToolbarBtn
            active={false}
            onClick={() => fileInputRef.current?.click()}
            label="Insert image (uploads to assets/)"
          >
            <ImagePlus className="h-4 w-4" />
          </ToolbarBtn>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleInsertImage(f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs dark:border-slate-700 dark:bg-slate-950">
            <button
              type="button"
              onClick={() => handleModeSwitch("rich")}
              className={`rounded-md px-2 py-1 font-medium ${
                mode === "rich"
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              Visual
            </button>
            <button
              type="button"
              onClick={() => handleModeSwitch("raw")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${
                mode === "raw"
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              <FileCode2 className="h-3 w-3" />
              Markdown
            </button>
          </div>

          {draftNotice && dirty && (
            <span className="text-[11px] text-slate-400">{draftNotice}</span>
          )}
          {savedNotice && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              {savedNotice}
            </span>
          )}

          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void handleSave(false)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Editor Surface */}
      <div className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {mode === "rich" ? (
          <EditorContent editor={editor} className="fr-prose min-h-[380px]" />
        ) : (
          <textarea
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="h-full min-h-[420px] w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-slate-900 focus:outline-none dark:text-slate-100"
          />
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`rounded-lg p-1.5 transition-colors ${
        active
          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          : "text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}
