export function requiresComparison(discussions: unknown[], reviewerId: number, head: string): boolean {
  for (const discussion of discussions as any[])
    for (const note of discussion?.notes ?? []) {
      if (
        note?.author?.id !== reviewerId ||
        typeof note.body !== "string" ||
        !/<!-- agent-autoloop:action=[a-f0-9]{64} -->/.test(note.body)
      )
        continue;
      const previous = note.position?.head_sha;
      if (typeof previous !== "string" || !/^[a-f0-9]{40}$/.test(previous) || previous !== head) return true;
    }
  return false;
}
