# /knowledge-housekeeping

You are performing a scheduled housekeeping pass over the Pixshar OKF knowledge bundle at `.knowledge/`.

## Your task

1. **Assess what has changed** since the `timestamp` on each concept file.
   - Run `git log --since="<oldest-timestamp-in-bundle>" --name-only --pretty=format: apps/ packages/ prisma/ helm/ docker-compose.yml` to list changed files.
   - Map changed files to affected concepts using this guide:
     - `apps/api/src/routes/` → `api/` concepts
     - `apps/api/prisma/schema.prisma` or `apps/api/prisma/migrations/` → `data-model/` concepts
     - `apps/api/src/services/imageProcessor*` or `resizeWorker*` → `architecture/image-processing.md`
     - `apps/api/src/services/downloadJob*` or `archivePlanner*` → `architecture/archive-generation.md`, `data-model/download-jobs.md`, `decisions/multi-part-archive.md`
     - `apps/api/src/lib/s3*` → `architecture/storage.md`
     - `apps/api/src/lib/auth*` or `apps/api/src/middleware/` → `architecture/auth.md`
     - `apps/web/` → `architecture/frontend.md`
     - `apps/api/src/index.ts` or `apps/api/src/lib/env.ts` → `architecture/backend.md`
     - `helm/` or `docker-compose.yml` → no dedicated concept; note in log only

2. **For each affected concept**, read the current concept file and the changed source files, then:
   - Update the concept body to reflect the current reality.
   - Update the `timestamp` frontmatter to today's date in ISO 8601 format.
   - Do NOT change the `type` or `title` unless they are genuinely wrong.
   - Keep concept files concise. One concept per file. No file-path lists.

3. **Check for stale or missing concepts**:
   - If a major new subsystem has been added that has no concept, create one.
   - If a concept describes something that no longer exists, delete the file.
   - Keep cross-references (links) valid: if you rename or delete a concept, update links in other leaf files.

4. **Update index files** if new concepts were added or removed from a directory. Index files have no frontmatter — body only, as per OKF §6.

5. **Update `.knowledge/log.md`** with a new date section at the top. Use `**Update**`, `**Creation**`, or `**Deletion**` prefixes. List each changed concept as a markdown link.

6. **Do not update concepts that are still accurate.** If a concept is unchanged and its timestamp is older than the last relevant code change, leave it alone — the timestamp reflects the last *meaningful* conceptual change, not a superficial touch.

## Quality criteria for concept files

- Each file covers exactly one concept. Split if two concerns appear.
- Body uses structural markdown (headings, tables, code blocks). Minimal prose.
- No file paths or function names in the body — these change too frequently and belong in code, not the knowledge bundle.
- Leaf files (no subdirectory children) may cross-reference other concepts with bundle-relative links (`/path/to/concept.md`).
- Parent-level files (those with sibling subdirectories in the same directory) must not cross-reference.
- Keep each file under ~100 lines. Split if it grows larger.

## When you are done

Report a short summary: how many concepts were updated, created, or deleted, and list any concepts you flagged as potentially stale but chose not to update (with a reason why you left them).
