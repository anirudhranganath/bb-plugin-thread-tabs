import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface TranscriptRow {
    id: string;
    kind: string;
    sourceSeqStart: number;
    sourceSeqEnd: number;
    role?: string;
    text?: string;
    children?: readonly TranscriptRow[] | null;
    attachments?: { localFilePaths: string[]; localImagePaths: string[]; imageUrls: string[] } | null;
}

/** Renders timeline rows up to sequence `end` as Markdown; `full` adds tool and system records. */
export function renderTranscript(rows: readonly TranscriptRow[], end: number, full: boolean): string {
    const messages = new Map<string, TranscriptRow>();
    // Collects messages within `end`, descending into turns.
    function visit(row: TranscriptRow) {
        if (row.kind === "turn") {
            row.children?.forEach(visit);
        } else if (row.sourceSeqEnd <= end) {
            messages.set(row.id, row);
        }
    }
    rows.forEach(visit);
    const sections = [...messages.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart).flatMap(row => {
        if (row.kind === "conversation") {
            const attachments = [...(row.attachments?.localFilePaths ?? []), ...(row.attachments?.localImagePaths ?? []), ...(row.attachments?.imageUrls ?? [])];
            const body = [row.text?.trim(), ...attachments.map(path => `Attachment: ${path}`)].filter(Boolean).join("\n\n");
            if (!body) return [];
            const heading = row.role === "user" ? "User" : "Assistant";
            return [`## ${heading}\n\n${body}`];
        }
        if (!full) return [];
        return [`## ${row.kind === "work" ? "Tool activity" : "System event"}\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``];
    });
    return sections.join("\n\n");
}

/** Pages a thread's timeline into a Markdown transcript, throwing rather than truncating when a size limit is exceeded. */
export async function collectTranscript(sdk: BbPluginApi["sdk"], threadId: string, sourceSeqEnd?: number, full = false) {
    type Page = Extract<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>, { rows: unknown }>;
    const rows: TranscriptRow[] = [];
    let cursor: { anchorId: string; anchorSeq: number } | null = null;
    let end = sourceSeqEnd;
    const cursors = new Set<string>();
    let bytesRead = 0;
    for (;;) {
        const page: Page = await sdk.threads.timeline({ threadId, includeNestedRows: "true", deferContent: "false", segmentLimit: "100", ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
        end ??= page.maxSeq;
        bytesRead += Buffer.byteLength(JSON.stringify(page.rows), "utf8");
        if (bytesRead > 16 * 1024 * 1024 || cursors.size >= 200) throw new Error("This conversation is too large to export safely. Fork from an earlier message.");
        rows.push(...page.rows);
        const text = renderTranscript(rows, end, full);
        if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("This transcript exceeds 2 MB. Fork from an earlier message or copy the concise transcript.");
        cursor = page.timelinePage.olderCursor;
        if (!cursor) {
            if (!text.trim()) throw new Error("There are no conversation messages to copy yet.");
            return { text, sourceSeqEnd: end };
        }
        const key = `${cursor.anchorSeq}:${cursor.anchorId}`;
        if (cursors.has(key)) throw new Error("Transcript pagination did not advance; nothing was forked.");
        cursors.add(key);
    }
}
