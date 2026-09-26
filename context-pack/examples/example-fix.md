# Context Pack

## task
Fix crash when saving an empty project

## goal
Saving a project with zero layers writes a valid file and shows no error dialog.

## constraints
- Do not change the file format version.
- Windows native only; PowerShell for scripts.
- Touch only the files listed below.

## relevant_files
- `src/save.ts` (lines 40-88) — serialization entry point
- `tests/save.test.ts` — existing coverage to extend

## relevant_snippets
### `src/save.ts` (lines 40-46)
```ts
export function save(project: Project) {
  const layers = project.scene.layers.map(serializeLayer);
  return JSON.stringify({ version: 3, layers });
}
```

## repo_rules
- Use the smallest sufficient change.
- Report what changed and the exact evidence.

## observed_errors
```
TypeError: Cannot read properties of undefined (reading 'layers')
    at save (src/save.ts:42:31)
```

## test_commands
- `npm test -- save`

## previous_attempts
- Added a null check in `save()` — outcome: tests pass but empty file is still invalid.

## expected_output
A diff limited to `src/save.ts` and `tests/save.test.ts`, plus the test output.
