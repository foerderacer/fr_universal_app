import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import {
  AlertTriangle,
  Bold,
  Check,
  Code,
  FileCode2,
  FileText,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
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
import { MOD_KEY } from "../../lib/platform";
import { handleToolbarKeyDown, hasActiveOverlay } from "../../lib/shortcuts";
import { toUserFacingError } from "../../lib/workspaceClient";
import { ErrorBanner } from "../ErrorBanner";
import { InlineDeleteConfirm } from "../ui/InlineDeleteConfirm";
import { IconButton } from "../ui/Tooltip";

interface MarkdownEditorProps {
  path: string;
  onSaved?: (newPath: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function resolveRelativeCloudPath(
  docParentDir: string,
  rawSrc: string,
): string | null {
  const trimmed = rawSrc.trim();
  if (!trimmed || /^(https?:|data:|blob:|mailto:|#)/i.test(trimmed)) {
    return null;
  }
  const baseParts =
    docParentDir === "/" ? [] : docParentDir.split("/").filter(Boolean);
  const relParts = trimmed.startsWith("/") ? [] : [...baseParts];
  for (const seg of trimmed.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (relParts.length === 0) return null;
      relParts.pop();
    } else {
      relParts.push(seg);
    }
  }
  return `/${relParts.join("/")}`;
}

async function renderSanitizedHtmlWithProxyImages(
  mdText: string,
  docParentDir: string,
): Promise<string> {
  const rawHtml = marked.parse(mdText, { async: false }) as string;
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  });

  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(cleanHtml, "text/html");
  const imgs = Array.from(parsedDoc.querySelectorAll("img"));

  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const cloudPath = resolveRelativeCloudPath(docParentDir, src);
      if (!cloudPath) return;
      const proxyUrl = await getMediaProxyUrl(cloudPath).catch(() => null);
      if (proxyUrl) {
        img.setAttribute("src", proxyUrl);
      }
    }),
  );

  return parsedDoc.body.innerHTML;
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

export function MarkdownEditor({
  path,
  onSaved,
  onDirtyChange,
}: MarkdownEditorProps) {
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
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [confirmDiscardDraft, setConfirmDiscardDraft] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuTriggerRef = useRef<HTMLSpanElement | null>(null);
  const moreMenuListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const firstItem =
      moreMenuListRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]',
      );
    firstItem?.focus();
    const onDown = (e: MouseEvent) => {
      if (!moreMenuRef.current?.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMoreMenuOpen(false);
        moreMenuTriggerRef.current?.querySelector("button")?.focus();
        return;
      }
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        const items = Array.from(
          moreMenuListRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]',
          ) ?? [],
        );
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const curIdx = items.findIndex((el) => el === document.activeElement);
        let nextIdx = 0;
        if (e.key === "ArrowDown") {
          nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % items.length;
        } else if (e.key === "ArrowUp") {
          nextIdx = curIdx <= 0 ? items.length - 1 : curIdx - 1;
        } else if (e.key === "End") {
          nextIdx = items.length - 1;
        }
        items[nextIdx]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [moreMenuOpen]);

  const docParentDir = useMemo(() => {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
  }, [path]);
  const turndown = useMemo(() => createTurndown(docParentDir), [docParentDir]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncingFromExternal = useRef(false);
  const renderSeqRef = useRef(0);
  const latestDraftRef = useRef<{
    dirty: boolean;
    hasDoc: boolean;
    path: string;
    markdown: string;
    etag: Etag | null;
  }>({
    dirty: false,
    hasDoc: false,
    path,
    markdown: "",
    etag: null,
  });

  useEffect(() => {
    latestDraftRef.current = {
      dirty,
      hasDoc: Boolean(doc),
      path,
      markdown,
      etag,
    };
  }, [dirty, doc, path, markdown, etag]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false },
      }),
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
    async (mdText: string) => {
      if (!editor) return;
      const seq = ++renderSeqRef.current;
      const safeHtml = await renderSanitizedHtmlWithProxyImages(
        mdText,
        docParentDir,
      );
      if (seq !== renderSeqRef.current || editor.isDestroyed) return;
      syncingFromExternal.current = true;
      try {
        editor.commands.setContent(safeHtml, { emitUpdate: false });
      } finally {
        syncingFromExternal.current = false;
      }
    },
    [editor, docParentDir],
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
      await applyMarkdownToEditor(loaded.content);
    } catch (err) {
      setError(toUserFacingError(err));
    } finally {
      setLoading(false);
    }
  }, [path, applyMarkdownToEditor]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  useEffect(() => {
    if (!dirty || !doc) return;
    const handle = window.setTimeout(() => {
      void saveMarkdownDraft(path, markdown, etag)
        .then(() => setDraftNotice("Draft saved"))
        .catch(() => {});
    }, 800);
    return () => window.clearTimeout(handle);
  }, [dirty, doc, path, markdown, etag]);

  useEffect(() => {
    const flushNow = () => {
      const cur = latestDraftRef.current;
      if (cur.dirty && cur.hasDoc) {
        void saveMarkdownDraft(cur.path, cur.markdown, cur.etag).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flushNow);
    return () => {
      window.removeEventListener("beforeunload", flushNow);
      flushNow();
    };
  }, [path]);

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
        setSavedNotice("Saved");
        setTimeout(() => setSavedNotice(null), 2500);
        onSaved?.(res.path);
      } catch (err) {
        const uf = toUserFacingError(err);
        if (uf.code === "conflict") {
          await saveMarkdownDraft(path, markdown, etag)
            .then(() => setDraftNotice("Draft saved"))
            .catch(() => {});
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

  const handleReloadAfterConflict = useCallback(async () => {
    if (dirty && doc) {
      try {
        await saveMarkdownDraft(path, markdown, etag);
        setDraftNotice("Draft saved");
      } catch (err) {
        setError(toUserFacingError(err));
        return;
      }
    }
    await loadDocument();
  }, [dirty, doc, path, markdown, etag, loadDocument]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (hasActiveOverlay()) {
          return;
        }
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
      setSavedNotice(`Saved copy`);
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
    await applyMarkdownToEditor(doc.draft.content);
    setDirty(true);
    setDoc({ ...doc, draft: null });
  }

  async function handleDiscardDraft() {
    await discardMarkdownDraft(path);
    if (doc) setDoc({ ...doc, draft: null });
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
      await uploadFileBytes(assetPath, buf, false);
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
      void applyMarkdownToEditor(markdown);
    }
    setMode(nextMode);
  }

  if (loading) {
    return (
      <div className="flex h-56 items-center justify-center text-xs text-[var(--text-muted)]">
        Loading note…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {doc?.draft && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] px-3 py-2 text-xs text-[var(--text-primary)]">
          <span>Unsaved local draft found from an earlier session.</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleRestoreDraft()}
              className="rounded bg-[var(--status-warning)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-warning-fg)]"
            >
              Restore
            </button>
            <InlineDeleteConfirm
              armed={confirmDiscardDraft}
              onArm={() => setConfirmDiscardDraft(true)}
              onCancel={() => setConfirmDiscardDraft(false)}
              onConfirm={() => {
                setConfirmDiscardDraft(false);
                void handleDiscardDraft();
              }}
              label="Discard local draft"
              triggerLabel="Discard"
              confirmLabel="Discard"
            />
          </div>
        </div>
      )}

      {conflictOpen && (
        <div
          role="alert"
          aria-label="Remote file conflict"
          className="rounded-md border border-[var(--status-danger)]/40 bg-[var(--status-danger-soft)] p-3 text-xs text-[var(--text-primary)]"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-danger-text)]"
              strokeWidth={1.5}
            />
            <div className="flex-1">
              <p className="font-medium">Remote file updated on Nextcloud</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                Your edits are preserved locally. Choose how to resolve:
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveCopy()}
                  className="rounded bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  Save copy
                </button>
                <InlineDeleteConfirm
                  armed={confirmOverwrite}
                  onArm={() => setConfirmOverwrite(true)}
                  onCancel={() => setConfirmOverwrite(false)}
                  onConfirm={() => {
                    setConfirmOverwrite(false);
                    void handleSave(true);
                  }}
                  label="Overwrite remote file"
                  triggerLabel="Overwrite"
                  confirmLabel="Overwrite"
                  disabled={saving}
                />
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleReloadAfterConflict()}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border-strong)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
                  Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact Single-Row Icon-First Formatting Bar */}
      <div
        role="toolbar"
        aria-label="Markdown formatting"
        onKeyDown={handleToolbarKeyDown}
        className="flex h-8 shrink-0 flex-nowrap items-center justify-between gap-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5"
      >
        <div className="flex flex-nowrap items-center gap-0.5">
          {mode === "rich" && editor && (
            <>
              <IconButton
                size="xs"
                label="Bold"
                shortcut={`${MOD_KEY}B`}
                active={editor.isActive("bold")}
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <Bold className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="xs"
                label="Italic"
                shortcut={`${MOD_KEY}I`}
                active={editor.isActive("italic")}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <Italic className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="xs"
                label="Bullet list"
                active={editor.isActive("bulletList")}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                <List className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="xs"
                label="Numbered list"
                active={editor.isActive("orderedList")}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                <ListOrdered className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
              <IconButton
                size="xs"
                label="Checklist"
                active={editor.isActive("taskList")}
                onClick={() => editor.chain().focus().toggleTaskList().run()}
              >
                <ListChecks className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </>
          )}

          {/* Overflow menu keeps the bar strictly one row at all inspector widths */}
          <div ref={moreMenuRef} className="relative">
            <span ref={moreMenuTriggerRef} className="inline-flex">
              <IconButton
                size="xs"
                label="More blocks & insert"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                onClick={() => setMoreMenuOpen((v) => !v)}
              >
                <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
              </IconButton>
            </span>
            {moreMenuOpen && (
              <div
                ref={moreMenuListRef}
                role="menu"
                aria-label="More formatting options"
                className="absolute top-full left-0 z-40 mt-1 w-44 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1"
              >
                {mode === "rich" && editor && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        editor.chain().focus().toggleHeading({ level: 1 }).run();
                        setMoreMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        editor.isActive("heading", { level: 1 })
                          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Heading1 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Heading 1
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        editor.chain().focus().toggleHeading({ level: 2 }).run();
                        setMoreMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        editor.isActive("heading", { level: 2 })
                          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Heading2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Heading 2
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        editor.chain().focus().toggleBlockquote().run();
                        setMoreMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        editor.isActive("blockquote")
                          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Quote className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Quote
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        editor.chain().focus().toggleCodeBlock().run();
                        setMoreMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        editor.isActive("codeBlock")
                          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Code className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Code block
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        editor
                          .chain()
                          .focus()
                          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                          .run();
                        setMoreMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        editor.isActive("table")
                          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <TableIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Insert table
                    </button>
                    <div
                      role="none"
                      className="my-1 border-t border-[var(--border-hairline)]"
                    />
                  </>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Insert image…
                </button>
              </div>
            )}
          </div>

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

        <div className="flex shrink-0 flex-nowrap items-center gap-1">
          {draftNotice && dirty && (
            <span className="hidden truncate text-[11px] text-[var(--text-muted)] sm:inline">
              {draftNotice}
            </span>
          )}
          {savedNotice && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--status-positive-text)]"
            >
              <Check className="h-3 w-3" strokeWidth={1.5} />
              {savedNotice}
            </span>
          )}

          <div className="flex items-center rounded border border-[var(--border-strong)] bg-[var(--bg-app)] p-0.5">
            <IconButton
              size="xs"
              label="Rich visual mode"
              active={mode === "rich"}
              onClick={() => handleModeSwitch("rich")}
            >
              <FileText className="h-3 w-3" strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="xs"
              label="Raw Markdown mode"
              active={mode === "raw"}
              onClick={() => handleModeSwitch("raw")}
            >
              <FileCode2 className="h-3 w-3" strokeWidth={1.5} />
            </IconButton>
          </div>

          <IconButton
            size="xs"
            label="Save note"
            shortcut={`${MOD_KEY}S`}
            tone={dirty ? "accent" : "default"}
            disabled={saving || !dirty}
            onClick={() => void handleSave(false)}
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      {/* Editor Surface */}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 focus-within:border-[var(--accent)]">
        {mode === "rich" ? (
          <EditorContent editor={editor} className="fr-prose min-h-[340px]" />
        ) : (
          <textarea
            aria-label="Raw Markdown source"
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="mono-num h-full min-h-[380px] w-full resize-none bg-transparent text-xs leading-relaxed text-[var(--text-primary)] focus:outline-none"
          />
        )}
      </div>
    </div>
  );
}
