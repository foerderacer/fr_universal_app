import type {
  FileItemView_Serialize,
  FilePreviewPayload_Serialize,
  FinanceCurrencySummary,
  FinanceEntry_Serialize,
  MarkdownDocument_Serialize,
  SliceJobRecord_Serialize,
  TalkCapabilities,
  TalkMessage_Serialize,
  TalkRoom_Serialize,
} from "../bindings/tauri";

const NOW_SEC = Math.floor(Date.now() / 1000);

export const PREVIEW_FILES_BY_DIR: Record<string, FileItemView_Serialize[]> = {
  "/": [
    {
      entry: {
        id: "dir-eng",
        name: "Engineering",
        path: "/Engineering",
        kind: "directory",
        size: null,
        mimeType: null,
        etag: "e-dir-eng",
        modifiedAt: "2026-11-25T16:40:00Z",
      },
      previewKind: null,
      editable: false,
    },
    {
      entry: {
        id: "dir-fin",
        name: "Finance",
        path: "/Finance",
        kind: "directory",
        size: null,
        mimeType: null,
        etag: "e-dir-fin",
        modifiedAt: "2026-11-26T09:15:00Z",
      },
      previewKind: null,
      editable: false,
    },
    {
      entry: {
        id: "dir-prints",
        name: "3D Prints",
        path: "/3D Prints",
        kind: "directory",
        size: null,
        mimeType: null,
        etag: "e-dir-prints",
        modifiedAt: "2026-11-26T14:22:00Z",
      },
      previewKind: null,
      editable: false,
    },
    {
      entry: {
        id: "f-spec",
        name: "chassis-rev4-spec.md",
        path: "/chassis-rev4-spec.md",
        kind: "file",
        size: 14820,
        mimeType: "text/markdown",
        etag: "etag-spec-4",
        modifiedAt: "2026-11-26T15:10:00Z",
      },
      previewKind: "markdown",
      editable: true,
    },
    {
      entry: {
        id: "f-svg",
        name: "fr-aero-profile.svg",
        path: "/fr-aero-profile.svg",
        kind: "file",
        size: 8420,
        mimeType: "image/svg+xml",
        etag: "etag-svg-1",
        modifiedAt: "2026-11-24T11:30:00Z",
      },
      previewKind: "vectorSvg",
      editable: false,
    },
    {
      entry: {
        id: "f-sld",
        name: "front-wing-endplate.sldprt",
        path: "/front-wing-endplate.sldprt",
        kind: "file",
        size: 4820412,
        mimeType: "application/x-solidworks",
        etag: "etag-sld-2",
        modifiedAt: "2026-11-25T18:05:00Z",
      },
      previewKind: "solidWorks",
      editable: false,
    },
    {
      entry: {
        id: "f-json",
        name: "mk3s-calibration.json",
        path: "/mk3s-calibration.json",
        kind: "file",
        size: 2140,
        mimeType: "application/json",
        etag: "etag-json-3",
        modifiedAt: "2026-11-26T12:48:00Z",
      },
      previewKind: "plainText",
      editable: false,
    },
    {
      entry: {
        id: "f-stl",
        name: "brake-duct-mount.stl",
        path: "/brake-duct-mount.stl",
        kind: "file",
        size: 1945600,
        mimeType: "model/stl",
        etag: "etag-stl-5",
        modifiedAt: "2026-11-26T16:12:00Z",
      },
      previewKind: "cad3d",
      editable: false,
    },
  ],
  "/Engineering": [
    {
      entry: {
        id: "f-eng-1",
        name: "suspension-geometry.md",
        path: "/Engineering/suspension-geometry.md",
        kind: "file",
        size: 9320,
        mimeType: "text/markdown",
        etag: "etag-eng-1",
        modifiedAt: "2026-11-25T16:40:00Z",
      },
      previewKind: "markdown",
      editable: true,
    },
    {
      entry: {
        id: "f-eng-2",
        name: "upright-left-v3.sldprt",
        path: "/Engineering/upright-left-v3.sldprt",
        kind: "file",
        size: 6214000,
        mimeType: "application/x-solidworks",
        etag: "etag-eng-2",
        modifiedAt: "2026-11-24T19:02:00Z",
      },
      previewKind: "solidWorks",
      editable: false,
    },
  ],
  "/Finance": [
    {
      entry: {
        id: "f-fin-1",
        name: "inv-2026-1104-carbon.txt",
        path: "/Finance/inv-2026-1104-carbon.txt",
        kind: "file",
        size: 1840,
        mimeType: "text/plain",
        etag: "etag-fin-1",
        modifiedAt: "2026-11-22T10:00:00Z",
      },
      previewKind: "plainText",
      editable: false,
    },
    {
      entry: {
        id: "f-fin-2",
        name: "q4-budget-notes.md",
        path: "/Finance/q4-budget-notes.md",
        kind: "file",
        size: 5120,
        mimeType: "text/markdown",
        etag: "etag-fin-2",
        modifiedAt: "2026-11-26T09:15:00Z",
      },
      previewKind: "markdown",
      editable: true,
    },
  ],
  "/3D Prints": [
    {
      entry: {
        id: "f-pr-1",
        name: "sensor-bracket-v2.stl",
        path: "/3D Prints/sensor-bracket-v2.stl",
        kind: "file",
        size: 842100,
        mimeType: "model/stl",
        etag: "etag-pr-1",
        modifiedAt: "2026-11-26T14:22:00Z",
      },
      previewKind: "cad3d",
      editable: false,
    },
  ],
};

export const PREVIEW_MARKDOWN_CONTENT: Record<string, string> = {
  "/chassis-rev4-spec.md": `# Chassis Rev 4 — Structural Spec

Target monocoque torsional stiffness: **2,850 Nm/deg** at curb weight under 198 kg.

## Checklist
- [x] Verify front bulkhead impact attenuator clearance
- [x] Confirm M6 titanium insert torque spec (11.5 Nm)
- [ ] Run final Prusa MK3S fitment print for brake duct mount

## Layup Schedule
| Zone | Fiber | Plies | Resin % |
| --- | --- | --- | --- |
| Primary tub | T700 2x2 Twill | 6 | 38% |
| Roll hoop mount | M40J UD | 8 | 36% |
`,
  "/Engineering/suspension-geometry.md": `# Suspension Kinematics Notes

Front anti-dive set to 28%, rear anti-squat at 34%. Camber gain under 25 mm bump: -0.92 deg.
`,
  "/Finance/q4-budget-notes.md": `# Q4 Engineering Budget Notes

All carbon prepreg and CNC machining invoices reconciled against Nextcloud \`/Finance\`.
`,
};

export const PREVIEW_SVG_SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180" width="420" height="180">
  <rect x="8" y="8" width="404" height="164" rx="4" fill="#121317" stroke="#2d313d" stroke-width="1"/>
  <path d="M 32 132 C 110 42, 230 34, 386 108 C 295 112, 160 124, 32 132 Z" fill="none" stroke="#5e6ad2" stroke-width="2"/>
  <line x1="32" y1="132" x2="386" y2="108" stroke="#646975" stroke-width="1" stroke-dasharray="4 4"/>
  <circle cx="140" cy="75" r="3" fill="#3fb950"/>
  <text x="24" y="30" fill="#989da8" font-family="monospace" font-size="11">NACA 6412 · CHORD 354.0 mm · AoA 4.2°</text>
</svg>`;

export function getPreviewMarkdownDoc(path: string): MarkdownDocument_Serialize {
  const name = path.split("/").pop() ?? "Note";
  const content =
    PREVIEW_MARKDOWN_CONTENT[path] ??
    `# ${name}\n\nPreview content for ${path}.`;
  return {
    path,
    name,
    content,
    etag: "preview-etag",
    draft: null,
  };
}

export function getPreviewFilePayload(path: string): FilePreviewPayload_Serialize {
  const all = Object.values(PREVIEW_FILES_BY_DIR).flat();
  const found = all.find((f) => f.entry.path === path);
  const entry = found?.entry ?? {
    id: path,
    name: path.split("/").pop() ?? path,
    path,
    kind: "file" as const,
    size: 4096,
    mimeType: "text/plain",
    etag: null,
    modifiedAt: "2026-11-26T12:00:00Z",
  };
  const kind = found?.previewKind ?? "plainText";

  if (kind === "vectorSvg") {
    return {
      entry,
      previewKind: "vectorSvg",
      mediaUrl: null,
      textContent: PREVIEW_SVG_SAMPLE,
      thumbnailDataUrl: null,
      imageDimensions: { width: 420, height: 180 },
      solidworks: null,
      note: null,
    };
  }
  if (kind === "solidWorks") {
    return {
      entry,
      previewKind: "solidWorks",
      mediaUrl: null,
      textContent: null,
      thumbnailDataUrl: null,
      imageDimensions: null,
      solidworks: {
        thumbnailDataUrl: null,
        streamCount: 14,
        metadata: {
          title: "Front Wing Endplate Rev 4",
          subject: "Aero Package",
          author: "L. Weber",
          keywords: "aero, cfd, endplate",
          lastSavedBy: "L. Weber",
          applicationName: "SOLIDWORKS 2025 SP2",
          createdAt: "2026-10-14 09:20",
          lastSavedAt: "2026-11-25 18:05",
          comments: "CFD iteration 12 — cleared for CNC mold prep",
        },
      },
      note: null,
    };
  }
  if (kind === "plainText") {
    return {
      entry,
      previewKind: "plainText",
      mediaUrl: null,
      textContent:
        path.endsWith(".json")
          ? JSON.stringify(
              {
                printer: "Prusa i3 MK3S",
                nozzleDiameterMm: 0.4,
                linearAdvanceK: 0.055,
                bedMeshVarianceMm: 0.032,
                calibratedAt: "2026-11-26T12:48:00Z",
              },
              null,
              2,
            )
          : "INVOICE #2026-1104\nVendor: Toray Composite Materials EU\nItem: T700S 12K Carbon Prepreg (15m roll)\nSubtotal: EUR 1,420.00\nVAT (19%): EUR 269.80\nTotal: EUR 1,689.80\nStatus: Approved",
      thumbnailDataUrl: null,
      imageDimensions: null,
      solidworks: null,
      note: null,
    };
  }
  return {
    entry,
    previewKind: kind,
    mediaUrl: null,
    textContent: null,
    thumbnailDataUrl: null,
    imageDimensions: null,
    solidworks: null,
    note: "Preview streaming runs via the local desktop Range proxy in the Tauri build.",
  };
}

export const PREVIEW_FINANCE_ENTRIES: FinanceEntry_Serialize[] = [
  {
    id: "fin-1",
    kind: "invoice",
    vendor: "Toray Composite Materials EU",
    description: "T700S 12K prepreg roll — chassis rev 4",
    category: "Composites",
    amountCents: 168980,
    currency: "EUR",
    entryDate: "2026-11-22",
    status: "approved",
    cloudFilePath: "/Finance/inv-2026-1104-carbon.txt",
    createdAt: "2026-11-22T10:00:00Z",
    updatedAt: "2026-11-24T08:30:00Z",
  },
  {
    id: "fin-2",
    kind: "receipt",
    vendor: "Prusa Research",
    description: "Prusament PETG Carbon & PLA Galaxy Black (8 spools)",
    category: "3D Printing",
    amountCents: 31840,
    currency: "EUR",
    entryDate: "2026-11-20",
    status: "paid",
    cloudFilePath: null,
    createdAt: "2026-11-20T14:12:00Z",
    updatedAt: "2026-11-20T14:12:00Z",
  },
  {
    id: "fin-3",
    kind: "invoice",
    vendor: "AluForm CNC GmbH",
    description: "7075-T6 front upright machining (pair)",
    category: "Machining",
    amountCents: 124500,
    currency: "EUR",
    entryDate: "2026-11-25",
    status: "pending",
    cloudFilePath: "/Finance/q4-budget-notes.md",
    createdAt: "2026-11-25T11:20:00Z",
    updatedAt: "2026-11-25T11:20:00Z",
  },
  {
    id: "fin-4",
    kind: "receipt",
    vendor: "Mouser Electronics",
    description: "CAN bus transceivers, M8 bulkhead connectors",
    category: "Electronics",
    amountCents: 46290,
    currency: "EUR",
    entryDate: "2026-11-18",
    status: "paid",
    cloudFilePath: null,
    createdAt: "2026-11-18T16:45:00Z",
    updatedAt: "2026-11-18T16:45:00Z",
  },
  {
    id: "fin-5",
    kind: "budget",
    vendor: "Q4 Chassis & Aero Allocation",
    description: "Approved winter manufacturing budget cap",
    category: "Allocation",
    amountCents: 850000,
    currency: "EUR",
    entryDate: "2026-11-01",
    status: "approved",
    cloudFilePath: "/Finance/q4-budget-notes.md",
    createdAt: "2026-11-01T08:00:00Z",
    updatedAt: "2026-11-01T08:00:00Z",
  },
  {
    id: "fin-6",
    kind: "invoice",
    vendor: "Hetzner Cloud",
    description: "Nextcloud & CI build runners (Nov 2026)",
    category: "Infrastructure",
    amountCents: 8950,
    currency: "EUR",
    entryDate: "2026-11-26",
    status: "pending",
    cloudFilePath: null,
    createdAt: "2026-11-26T07:05:00Z",
    updatedAt: "2026-11-26T07:05:00Z",
  },
];

export const PREVIEW_FINANCE_SUMMARIES: FinanceCurrencySummary[] = [
  {
    currency: "EUR",
    totalInvoicesCents: 302430,
    totalReceiptsCents: 78130,
    totalBudgetsCents: 850000,
    entryCount: 6,
    pendingCount: 2,
  },
];

export const PREVIEW_SLICE_JOBS: SliceJobRecord_Serialize[] = [
  {
    id: "job-101",
    outputFileName: "brake_duct_mount_PETG_020.gcode",
    state: "completed",
    percent: 100,
    stage: "Completed",
    rigidity: "high",
    quality: "standard",
    materialName: "PETG",
    estimatedTime: "2h 18m",
    filamentGrams: 64.2,
    filamentMm: 21400,
    gcodeSizeBytes: 3842110,
    cloudSavedPath: "/3D Prints/brake_duct_mount_PETG_020.gcode",
    errorMessage: null,
    technicalLog:
      "PrusaSlicer 2.8.1 — 248 layers, 0.20mm, 4 perimeters, 50% gyroid",
    createdAt: "2026-11-26T14:22:00Z",
    finishedAt: "2026-11-26T14:22:11Z",
  },
  {
    id: "job-100",
    outputFileName: "sensor_housing_PLA_010.gcode",
    state: "completed",
    percent: 100,
    stage: "Completed",
    rigidity: "medium",
    quality: "fine",
    materialName: "PLA",
    estimatedTime: "1h 04m",
    filamentGrams: 22.8,
    filamentMm: 7600,
    gcodeSizeBytes: 1924500,
    cloudSavedPath: null,
    errorMessage: null,
    technicalLog:
      "PrusaSlicer 2.8.1 — 310 layers, 0.10mm, 3 perimeters, 25% gyroid",
    createdAt: "2026-11-25T17:45:00Z",
    finishedAt: "2026-11-25T17:45:09Z",
  },
];

export const PREVIEW_TALK_CAPS: TalkCapabilities = {
  enabled: true,
  features: ["chat-v2", "reactions", "rich-object-sharing"],
  maxMessageLength: 32000,
  attachmentsAllowed: true,
  attachmentsFolder: "/Talk",
  conversationSubfolders: true,
  richObjectSharing: true,
  reactionsSupported: true,
  editMessagesSupported: true,
  deleteMessagesSupported: true,
};

export const PREVIEW_TALK_ROOMS: TalkRoom_Serialize[] = [
  {
    token: "aero-chassis",
    name: "Aero & Chassis",
    displayName: "Aero & Chassis",
    roomType: "group",
    description: "Monocoque layup, wind tunnel & 3D print fitment",
    unreadMessages: 2,
    unreadMention: false,
    isFavorite: true,
    readOnly: false,
    canLeave: true,
    lastActivity: NOW_SEC - 180,
    lastReadMessage: 401,
    lastMessagePreview: "Uploaded brake-duct-mount.stl for MK3S test fit",
    lastMessageActor: "Lukas Weber",
  },
  {
    token: "finance-ops",
    name: "Finance & Procurement",
    displayName: "Finance & Procurement",
    roomType: "group",
    description: "Invoices, supplier POs & Q4 budget tracking",
    unreadMessages: 0,
    unreadMention: false,
    isFavorite: true,
    readOnly: false,
    canLeave: true,
    lastActivity: NOW_SEC - 3400,
    lastReadMessage: 501,
    lastMessagePreview: "Toray prepreg invoice approved and linked",
    lastMessageActor: "Hannah Meyer",
  },
  {
    token: "dm-mira",
    name: "Mira Patel",
    displayName: "Mira Patel",
    roomType: "oneToOne",
    description: "Electronics Lead",
    unreadMessages: 0,
    unreadMention: false,
    isFavorite: false,
    readOnly: false,
    canLeave: false,
    lastActivity: NOW_SEC - 9200,
    lastReadMessage: 601,
    lastMessagePreview: "CAN harness pinout matches rev 4",
    lastMessageActor: "Mira Patel",
  },
];

export const PREVIEW_TALK_MESSAGES: Record<string, TalkMessage_Serialize[]> = {
  "aero-chassis": [
    {
      id: 401,
      token: "aero-chassis",
      actorType: "users",
      actorId: "hannah",
      actorDisplayName: "Hannah Meyer",
      timestamp: NOW_SEC - 2400,
      message:
        "Morning team — updated the rev 4 structural spec with the final insert torque values. Please review before we lock the layup schedule.",
      messageType: "comment",
      systemMessage: "",
      isReplyable: true,
      deleted: false,
      referenceId: "ref-401",
      parent: null,
      fileReference: {
        fileId: "f-spec",
        name: "chassis-rev4-spec.md",
        path: "/chassis-rev4-spec.md",
        size: 14820,
        mimeType: "text/markdown",
        link: null,
      },
      reactions: { "👍": 3 },
      reactionsSelf: ["👍"],
    },
    {
      id: 402,
      token: "aero-chassis",
      actorType: "users",
      actorId: "lukas",
      actorDisplayName: "Lukas Weber",
      timestamp: NOW_SEC - 1300,
      message:
        "Checked the clearance in SolidWorks. Running a PETG fitment print on the MK3S with `High` rigidity (`4 perimeters`, `50% gyroid`) right now.",
      messageType: "comment",
      systemMessage: "",
      isReplyable: true,
      deleted: false,
      referenceId: "ref-402",
      parent: {
        id: 401,
        actorDisplayName: "Hannah Meyer",
        message:
          "Morning team — updated the rev 4 structural spec with the final insert torque values.",
        deleted: false,
      },
      fileReference: null,
      reactions: {},
      reactionsSelf: [],
    },
    {
      id: 403,
      token: "aero-chassis",
      actorType: "users",
      actorId: "demo-user",
      actorDisplayName: "Alex Lindner",
      timestamp: NOW_SEC - 420,
      message:
        "Attached the updated aero profile SVG as well — verified 4.2° AoA against the endplate CAD.",
      messageType: "comment",
      systemMessage: "",
      isReplyable: true,
      deleted: false,
      referenceId: "ref-403",
      parent: null,
      fileReference: {
        fileId: "f-svg",
        name: "fr-aero-profile.svg",
        path: "/fr-aero-profile.svg",
        size: 8420,
        mimeType: "image/svg+xml",
        link: null,
      },
      reactions: { "👀": 2 },
      reactionsSelf: [],
    },
  ],
  "finance-ops": [
    {
      id: 501,
      token: "finance-ops",
      actorType: "users",
      actorId: "hannah",
      actorDisplayName: "Hannah Meyer",
      timestamp: NOW_SEC - 3400,
      message:
        "Toray prepreg invoice `EUR 1,689.80` is approved and linked in `/Finance`. AluForm CNC invoice is pending sign-off.",
      messageType: "comment",
      systemMessage: "",
      isReplyable: true,
      deleted: false,
      referenceId: "ref-501",
      parent: null,
      fileReference: {
        fileId: "f-fin-1",
        name: "inv-2026-1104-carbon.txt",
        path: "/Finance/inv-2026-1104-carbon.txt",
        size: 1840,
        mimeType: "text/plain",
        link: null,
      },
      reactions: { "👍": 2 },
      reactionsSelf: ["👍"],
    },
  ],
  "dm-mira": [
    {
      id: 601,
      token: "dm-mira",
      actorType: "users",
      actorId: "mira",
      actorDisplayName: "Mira Patel",
      timestamp: NOW_SEC - 9200,
      message:
        "CAN harness pinout matches rev 4. Let me know once the sensor bracket finishes slicing.",
      messageType: "comment",
      systemMessage: "",
      isReplyable: true,
      deleted: false,
      referenceId: "ref-601",
      parent: null,
      fileReference: null,
      reactions: {},
      reactionsSelf: [],
    },
  ],
};
