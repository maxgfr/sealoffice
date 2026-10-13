// SPDX-License-Identifier: AGPL-3.0-only
// The document handed to the editor, and reading it again after a save. The
// screens themselves live in home.ts (documents) and docactions.ts (actions).

/** A document to open in the editor; `id` is null until it is first saved. */
export interface OpenDoc {
  id: string | null;
  name: string;
  bytes: Uint8Array;
}

/**
 * The document picked on the home screen, read again after `save` flushed the
 * open one: when both are the same document, the bytes read before the flush
 * lack the latest changes. Null when the save failed and the user stopped.
 */
export async function savedThenRead(
  doc: OpenDoc,
  save: () => Promise<boolean>,
  read: (id: string) => Promise<Uint8Array>,
): Promise<OpenDoc | null> {
  if (!(await save())) return null;
  return doc.id === null ? doc : { ...doc, bytes: await read(doc.id) };
}
